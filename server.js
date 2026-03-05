// server.js — EduInsight Backend API
require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const fetch    = require('node-fetch');
const { Student, Teacher, QuizResult, QuizUpload } = require('./models');

const app  = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'eduinsight_secret';

// ── MIDDLEWARE ─────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static('../frontend'));

// ── DB CONNECT ─────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/eduinsight')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ── AUTH MIDDLEWARE ────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ══════════════════════════════════════════════════════════
//  AUTH ROUTES
// ══════════════════════════════════════════════════════════

// POST /api/auth/student — Student login
app.post('/api/auth/student', async (req, res) => {
  try {
    const { email, studentId, password } = req.body;
    const query = email ? { email: email.toLowerCase() } : { studentId };
    const student = await Student.findOne(query);
    if (!student) return res.status(404).json({ error: 'Student not found. Check your email/ID.' });
    const ok = await student.matchPassword(password);
    if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
    const token = jwt.sign({ id: student._id, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, role: 'student', student: sanitizeStudent(student) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/teacher — Teacher login
app.post('/api/auth/teacher', async (req, res) => {
  try {
    const { teacherId, password } = req.body;
    const teacher = await Teacher.findOne({ teacherId });
    if (!teacher) return res.status(404).json({ error: 'Teacher ID not found.' });
    const ok = await teacher.matchPassword(password);
    if (!ok) return res.status(401).json({ error: 'Incorrect password.' });
    const token = jwt.sign({ id: teacher._id, role: 'teacher' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, role: 'teacher', teacher: sanitizeTeacher(teacher) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  STUDENT ROUTES
// ══════════════════════════════════════════════════════════

// GET /api/student/me — Full student dashboard data
app.get('/api/student/me', auth, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id).lean();
    if (!student) return res.status(404).json({ error: 'Student not found' });

    // Get recent quiz results
    const recentQuizzes = await QuizResult
      .find({ studentId: req.user.id })
      .sort({ takenAt: -1 })
      .limit(10)
      .lean();

    res.json({
      student: sanitizeStudent(student),
      recentQuizzes,
      stats: {
        overallAvg: Math.round((student.subjects.physics + student.subjects.math + student.subjects.chemistry) / 3),
        quizzesTaken: student.quizzesTaken,
        weakTopicsCount: student.weakTopics.length,
        lessonsViewed: student.lessonsViewed,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/student/quiz-result — Save quiz result + run AI analysis
app.post('/api/student/quiz-result', auth, async (req, res) => {
  try {
    const { subject, topic, score, totalQ, correctQ, answers } = req.body;

    // Run AI gap detection
    const aiAnalysis = await runAIGapDetection(subject, topic, score, answers);

    // Save result to DB
    const result = await QuizResult.create({
      studentId: req.user.id,
      subject, topic, score, totalQ, correctQ, answers,
      aiAnalysis,
    });

    // Update student subject score (rolling average)
    const subjectKey = subject.toLowerCase();
    const student = await Student.findById(req.user.id);
    if (student && student.subjects[subjectKey] !== undefined) {
      student.subjects[subjectKey] = Math.round((student.subjects[subjectKey] * 0.7) + (score * 0.3));
    }

    // Update weak topics
    const weakFromQuiz = (aiAnalysis.weakConcepts || []).map(t => ({ subject, topic: t, score }));
    weakFromQuiz.forEach(wt => {
      const existing = student.weakTopics.find(x => x.topic === wt.topic && x.subject === wt.subject);
      if (existing) existing.score = Math.round((existing.score + score) / 2);
      else student.weakTopics.push(wt);
    });

    // Remove topics from weak if now strong (score >= 80)
    if (aiAnalysis.correctConcepts) {
      student.weakTopics = student.weakTopics.filter(wt =>
        !aiAnalysis.correctConcepts.includes(wt.topic)
      );
    }

    // Update topic scores
    answers.forEach(a => {
      const existing = student.topicScores.find(ts => ts.topic === a.concept && ts.subject === subject);
      if (existing) {
        existing.score = Math.round((existing.score + (a.isCorrect ? 100 : 0)) / 2);
        existing.attempts += 1;
      } else {
        student.topicScores.push({ subject, topic: a.concept, score: a.isCorrect ? 100 : 0, attempts: 1 });
      }
    });

    student.quizzesTaken += 1;
    await student.save();

    res.json({ result, aiAnalysis });
  } catch (err) {
    console.error('Quiz result error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/student/lesson-viewed — Track lesson view
app.post('/api/student/lesson-viewed', auth, async (req, res) => {
  try {
    await Student.findByIdAndUpdate(req.user.id, { $inc: { lessonsViewed: 1 } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  TEACHER ROUTES
// ══════════════════════════════════════════════════════════

// GET /api/teacher/dashboard — Full class overview
app.get('/api/teacher/dashboard', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher only' });
    const teacher = await Teacher.findById(req.user.id).lean();

    // Get all students
    const students = await Student.find({}).lean();

    // Compute class averages per topic
    const topicMap = {};
    students.forEach(s => {
      s.topicScores?.forEach(ts => {
        const key = `${ts.subject}:${ts.topic}`;
        if (!topicMap[key]) topicMap[key] = { subject: ts.subject, topic: ts.topic, total: 0, count: 0 };
        topicMap[key].total += ts.score;
        topicMap[key].count += 1;
      });
    });
    const classTopics = Object.values(topicMap).map(t => ({
      subject: t.subject,
      topic:   t.topic,
      avg:     Math.round(t.total / t.count),
      correctPct: Math.round(t.total / t.count),
    })).sort((a, b) => a.avg - b.avg);

    const weakClassTopics   = classTopics.filter(t => t.avg < 65);
    const strongClassTopics = classTopics.filter(t => t.avg >= 80);

    const atRiskStudents = students
      .filter(s => {
        const avg = Math.round((s.subjects.physics + s.subjects.math + s.subjects.chemistry) / 3);
        return avg < 60;
      })
      .map(s => ({
        name: s.name,
        email: s.email,
        avg: Math.round((s.subjects.physics + s.subjects.math + s.subjects.chemistry) / 3),
        weakTopics: s.weakTopics,
      }));

    const classAvg = Math.round(
      students.reduce((sum, s) => sum + Math.round((s.subjects.physics + s.subjects.math + s.subjects.chemistry) / 3), 0)
      / (students.length || 1)
    );

    // Recent quiz results
    const recentResults = await QuizResult.find({})
      .populate('studentId', 'name email')
      .sort({ takenAt: -1 })
      .limit(20)
      .lean();

    res.json({
      teacher: sanitizeTeacher(teacher),
      classStats: {
        classAvg,
        totalStudents: students.length,
        atRiskCount: atRiskStudents.length,
        quizzesGiven: await QuizUpload.countDocuments({ teacherId: req.user.id }),
        weakTopicsCount: weakClassTopics.length,
      },
      weakClassTopics,
      strongClassTopics,
      atRiskStudents,
      students: students.map(s => ({
        name: s.name,
        email: s.email,
        studentId: s.studentId,
        subjects: s.subjects,
        avg: Math.round((s.subjects.physics + s.subjects.math + s.subjects.chemistry) / 3),
        weakTopics: s.weakTopics,
        quizzesTaken: s.quizzesTaken,
      })),
      recentResults,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/teacher/upload-quiz
app.post('/api/teacher/upload-quiz', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher only' });
    const { subject, topic, title, notes, questionCount } = req.body;
    const upload = await QuizUpload.create({
      teacherId: req.user.id,
      subject, topic, title, notes, questionCount: questionCount || 10,
    });
    res.json({ upload, message: 'Quiz uploaded successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════
//  AI ENGINE
// ══════════════════════════════════════════════════════════
async function runAIGapDetection(subject, topic, score, answers) {
  const correctConcepts = [...new Set(answers.filter(a => a.isCorrect).map(a => a.concept))];
  const weakConcepts    = [...new Set(answers.filter(a => !a.isCorrect).map(a => a.concept))];

  try {
    const prompt = `You are EduInsight's AI gap detection engine.
A student just took a quiz on "${subject} - ${topic}".
Score: ${score}%
Correct concepts: ${correctConcepts.join(', ') || 'None'}
Weak concepts: ${weakConcepts.join(', ') || 'None'}
Respond ONLY with valid JSON (no markdown):
{"summary":"2-sentence performance summary","correctConcepts":${JSON.stringify(correctConcepts)},"weakConcepts":${JSON.stringify(weakConcepts)},"diagnosis":"1-2 sentences on root cause","nextSteps":["step1","step2","step3"]}`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const text = data.content?.map(c => c.text || '').join('').trim().replace(/```json|```/g, '');
    return JSON.parse(text);
  } catch {
    return {
      summary: `Student scored ${score}% on ${topic}. ${weakConcepts.length ? 'Gaps detected in: ' + weakConcepts.join(', ') : 'Good overall performance.'}`,
      correctConcepts, weakConcepts,
      diagnosis: weakConcepts.length ? 'Conceptual gaps detected in specific topics.' : 'No significant gaps detected.',
      nextSteps: weakConcepts.length
        ? ['Review AI mini-lessons for weak topics', 'Attempt practice questions', 'Re-take the quiz']
        : ['Explore advanced topics', 'Help classmates who are struggling', 'Take the next chapter quiz'],
    };
  }
}

// ── HELPERS ────────────────────────────────────────────────
function sanitizeStudent(s) {
  const { password, __v, ...rest } = s;
  return rest;
}
function sanitizeTeacher(t) {
  const { password, __v, ...rest } = t;
  return rest;
}

// ── START ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 EduInsight API running at http://localhost:${PORT}`);
  console.log(`   Seed DB: npm run seed`);
});