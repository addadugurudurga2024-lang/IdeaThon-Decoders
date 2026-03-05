// server.js — SmartGap_AI Backend (Ollama phi3 edition) 
require('dotenv').config();
const express  = require('express');
const mongoose = require('mongoose');
const cors     = require('cors');
const jwt      = require('jsonwebtoken');
const { Student, Teacher, GeneratedQuiz, GeneratedLesson, QuizResult, QuizUpload, QuizAssignment } = require('./models');

const app        = express();
const PORT       = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'smartgap_ai_secret';
const OLLAMA_HOST= process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'phi3';

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());
// Serve index.html from same directory as server.js
app.use(express.static(__dirname));

// ── DB ──────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/smartgap_ai')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => { console.error('❌ MongoDB error:', err.message); process.exit(1); });

// ── AUTH MIDDLEWARE ─────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid token' }); }
}

// ════════════════════════════════════════════════════════
//  OLLAMA HELPER  — uses fetch + AbortController (reliable timeout)
// ════════════════════════════════════════════════════════
async function ollamaGenerate(prompt, timeoutMs = 300000, num_predict = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(OLLAMA_HOST + '/api/generate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:   OLLAMA_MODEL,
        prompt,
        stream:  false,
        options: { temperature: 0.3, num_predict },
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${txt}`);
    }

    const data = await res.json();
    return data.response || '';
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Ollama timeout after ${timeoutMs/1000}s — try a smaller question count or a faster model`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Safely extract JSON from ollama response (phi3 sometimes adds prose or markdown fences)
function extractJSON(text) {
  // Strip markdown code fences if present (phi3 often wraps in ```json ... ```)
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // Try direct parse first
  try { return JSON.parse(text); } catch {}
  // Find first [ or { and last ] or }
  const arrStart = text.indexOf('[');
  const objStart = text.indexOf('{');
  let start = -1, endChar;
  if (arrStart === -1 && objStart === -1) throw new Error('No JSON found in response');
  if (arrStart === -1) { start = objStart; endChar = '}'; }
  else if (objStart === -1) { start = arrStart; endChar = ']'; }
  else { start = Math.min(arrStart, objStart); endChar = start === arrStart ? ']' : '}'; }
  const end = text.lastIndexOf(endChar);
  if (end === -1) throw new Error('No closing bracket found');
  return JSON.parse(text.slice(start, end + 1));
}

// Fallback: extract lesson fields individually via regex when full JSON parse fails
// This handles phi3's common failures: HTML in strings, unescaped quotes, truncation
function extractLessonFields(raw, topic) {
  const grab = (key) => {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"').trim() : '';
  };
  const grabArr = (key) => {
    const m = raw.match(new RegExp(`"${key}"\\s*:\\s*\\[([^\\]]*?)\\]`, 's'));
    if (!m) return [];
    return [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(x => x[1].trim()).filter(Boolean);
  };
  const grabPQ = () => {
    const m = raw.match(/"practiceQuestions"\s*:\s*\[([\s\S]*?)\]\s*[,}]/);
    if (!m) return [];
    const pairs = [];
    const pairRe = /\{\s*"q"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"a"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let pm;
    while ((pm = pairRe.exec(m[1])) !== null) {
      pairs.push({ q: pm[1].trim(), a: pm[2].trim() });
    }
    return pairs;
  };

  return {
    title:               grab('title')               || topic,
    tagline:             grab('tagline')             || `Understanding ${topic}`,
    explanation:         grab('explanation')         || '',
    keyFormula:          grab('keyFormula')          || 'N/A',
    keyFormulaExplained: grab('keyFormulaExplained') || '',
    commonMistakes:      grabArr('commonMistakes'),
    practiceQuestions:   grabPQ(),
  };
}

// ════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════
app.post('/api/auth/student', async (req, res) => {
  try {
    const { email, studentId, password } = req.body;
    const query = email ? { email: email.toLowerCase() } : { studentId };
    const student = await Student.findOne(query);
    if (!student) return res.status(404).json({ error: 'Student not found.' });
    if (!(await student.matchPassword(password))) return res.status(401).json({ error: 'Incorrect password.' });
    const token = jwt.sign({ id: student._id, role: 'student' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, role: 'student', student: strip(student.toObject()) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/teacher', async (req, res) => {
  try {
    const { teacherId, password } = req.body;
    const teacher = await Teacher.findOne({ teacherId });
    if (!teacher) return res.status(404).json({ error: 'Teacher ID not found.' });
    if (!(await teacher.matchPassword(password))) return res.status(401).json({ error: 'Incorrect password.' });
    const token = jwt.sign({ id: teacher._id, role: 'teacher' }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, role: 'teacher', teacher: strip(teacher.toObject()) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════
//  QUIZ GENERATION — phi3 → saved to MongoDB
// ════════════════════════════════════════════════════════
app.post('/api/quiz/generate', auth, async (req, res) => {
  const { subject, topic, difficulty = 'medium', count = 10, notes = '' } = req.body;
  if (!subject || !topic) return res.status(400).json({ error: 'subject and topic required' });

  // Check cache first — reuse if exists and fresh (< 7 days)
  const existing = await GeneratedQuiz.findOne({
    subject, topic, difficulty,
    createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
  }).lean();
  if (existing && existing.questions.length >= count) {
    return res.json({ quiz: existing, cached: true });
  }

  const prompt = `You are a strict JSON API for an educational quiz system.
Generate exactly ${count} multiple-choice questions about "${topic}" in "${subject}" at "${difficulty}" difficulty.
${notes ? 'Context/notes: ' + notes : ''}

Return ONLY a valid JSON array. No explanation, no markdown, no extra text. Just the array:
[
  {
    "question": "Full question text",
    "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
    "answer": 0,
    "concept": "specific concept name this question tests",
    "explanation": "why the correct answer is right"
  }
]
Rules: answer is the 0-based index of the correct option. Include exactly 4 options per question. Make questions test understanding, not just recall.`;

  try {
    console.log(`🤖 Generating quiz: ${subject} / ${topic} via ${OLLAMA_MODEL}...`);
    const raw = await ollamaGenerate(prompt);
    const questions = extractJSON(raw);

    if (!Array.isArray(questions) || questions.length === 0) {
      return res.status(500).json({ error: 'phi3 returned invalid quiz format' });
    }

    // Validate each question
    const valid = questions.filter(q =>
      q.question && Array.isArray(q.options) && q.options.length === 4 &&
      typeof q.answer === 'number' && q.answer >= 0 && q.answer <= 3
    ).slice(0, count);

    if (valid.length === 0) return res.status(500).json({ error: 'No valid questions generated' });

    // Save to MongoDB
    const quiz = await GeneratedQuiz.create({
      subject, topic, difficulty,
      title:       `${subject} – ${topic} (${difficulty})`,
      generatedBy: `ollama/${OLLAMA_MODEL}`,
      teacherId:   req.user.role === 'teacher' ? req.user.id : null,
      questions:   valid,
    });

    console.log(`✅ Quiz saved: ${valid.length} questions, id=${quiz._id}`);
    res.json({ quiz, cached: false });
  } catch (err) {
    console.error('Quiz generation error:', err.message);
    res.status(500).json({ error: 'Quiz generation failed: ' + err.message });
  }
});

// GET all quizzes (browse available quizzes)
app.get('/api/quiz/list', auth, async (req, res) => {
  try {
    const { subject, topic } = req.query;
    const filter = {};
    if (subject) filter.subject = subject;
    if (topic)   filter.topic   = topic;
    const quizzes = await GeneratedQuiz.find(filter)
      .select('subject topic title difficulty timesAttempted avgScore createdAt')
      .sort({ createdAt: -1 })
      .lean();
    res.json({ quizzes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single quiz by id
app.get('/api/quiz/:id', auth, async (req, res) => {
  try {
    const quiz = await GeneratedQuiz.findById(req.params.id).lean();
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    res.json({ quiz });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════
//  LESSON GENERATION — phi3 → saved to MongoDB
// ════════════════════════════════════════════════════════
app.post('/api/lesson/generate', auth, async (req, res) => {
  const { topic, subject } = req.body;
  if (!topic || !subject) return res.status(400).json({ error: 'topic and subject required' });

  // Cache: reuse lesson < 14 days old
  const existing = await GeneratedLesson.findOne({
    topic, subject,
    createdAt: { $gte: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) }
  }).lean();
  if (existing) {
    await GeneratedLesson.findByIdAndUpdate(existing._id, { $inc: { viewCount: 1 }, lastViewed: new Date() });
    return res.json({ lesson: existing, cached: true });
  }

  const prompt = `You are a JSON API for an educational tutoring system.
Generate a mini lesson for a student weak on "${topic}" in "${subject}".

Rules:
- Return ONLY a valid JSON object. No markdown, no code fences, no extra text before or after.
- All string values must use plain text only. No HTML tags, no angle brackets.
- Keep each string value under 300 characters.
- The explanation field must be plain text paragraphs separated by the literal text " | " (space-pipe-space).

{
  "title": "${topic}",
  "tagline": "one sentence about why this concept matters",
  "explanation": "paragraph one | paragraph two | paragraph three",
  "keyFormula": "the most important formula or N/A",
  "keyFormulaExplained": "plain English meaning",
  "commonMistakes": ["mistake 1", "mistake 2", "mistake 3"],
  "practiceQuestions": [
    { "q": "question 1", "a": "answer 1" },
    { "q": "question 2", "a": "answer 2" },
    { "q": "question 3", "a": "answer 3" }
  ]
}`;

  try {
    console.log(`🤖 Generating lesson: ${subject} / ${topic} via ${OLLAMA_MODEL}...`);
    const raw = await ollamaGenerate(prompt, 180000, 3000);

    // Try full parse first, then fall back to field-by-field regex extraction
    let data = {};
    try {
      data = extractJSON(raw);
    } catch (parseErr) {
      console.warn('Full JSON parse failed, attempting field extraction:', parseErr.message);
      data = extractLessonFields(raw, topic);
    }

    // Convert pipe-separated explanation back to HTML paragraphs for display
    let explanation = data.explanation || '';
    if (explanation && !explanation.includes('<p>')) {
      explanation = explanation.split(' | ')
        .filter(p => p.trim())
        .map(p => `<p>${p.trim()}</p>`)
        .join('');
    }

    const lesson = await GeneratedLesson.create({
      topic, subject,
      generatedBy:         `ollama/${OLLAMA_MODEL}`,
      tagline:             data.tagline             || `Understanding ${topic}`,
      explanation:         explanation              || `<p>This lesson covers ${topic} in ${subject}.</p>`,
      keyFormula:          data.keyFormula          || 'N/A',
      keyFormulaExplained: data.keyFormulaExplained || '',
      commonMistakes:      Array.isArray(data.commonMistakes) ? data.commonMistakes : [],
      practiceQuestions:   Array.isArray(data.practiceQuestions) ? data.practiceQuestions : [],
      viewCount:           1,
      lastViewed:          new Date(),
    });

    console.log(`✅ Lesson saved: ${topic}, id=${lesson._id}`);
    res.json({ lesson, cached: false });
  } catch (err) {
    console.error('Lesson generation error:', err.message);
    res.status(500).json({ error: 'Lesson generation failed: ' + err.message });
  }
});

// GET lesson by topic+subject (for re-fetching cached ones)
app.get('/api/lesson', auth, async (req, res) => {
  try {
    const { topic, subject } = req.query;
    const lesson = await GeneratedLesson.findOne({ topic, subject }).lean();
    if (!lesson) return res.status(404).json({ error: 'Not found' });
    res.json({ lesson });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════
//  STUDENT ROUTES
// ════════════════════════════════════════════════════════
app.get('/api/student/me', auth, async (req, res) => {
  try {
    const student = await Student.findById(req.user.id).lean();
    if (!student) return res.status(404).json({ error: 'Not found' });
    const recentQuizzes = await QuizResult.find({ studentId: req.user.id })
      .sort({ takenAt: -1 }).limit(10).lean();
    const sub = student.subjects || {};
    // Only average subjects that have actual quiz data (score > 0)
    const subValues = [sub.physics, sub.math, sub.chemistry].filter(v => v > 0);
    const overallAvg = subValues.length > 0 ? Math.round(subValues.reduce((a,b) => a+b, 0) / subValues.length) : 0;
    res.json({
      student: strip(student),
      recentQuizzes,
      stats: {
        overallAvg,
        quizzesTaken:    student.quizzesTaken   || 0,
        weakTopicsCount: student.weakTopics?.length || 0,
        lessonsViewed:   student.lessonsViewed  || 0,
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST quiz result — save attempt + run phi3 gap detection
app.post('/api/student/quiz-result', auth, async (req, res) => {
  try {
    const { subject, topic, score, totalQ, correctQ, answers, quizId } = req.body;

    // Run phi3 gap detection
    const aiAnalysis = await runGapDetection(subject, topic, score, answers);

    // Save quiz result
    const result = await QuizResult.create({
      studentId: req.user.id,
      quizId:    quizId || null,
      subject, topic, score, totalQ, correctQ, answers,
      aiAnalysis,
    });

    // Update quiz stats
    if (quizId) {
      const quiz = await GeneratedQuiz.findById(quizId);
      if (quiz) {
        quiz.timesAttempted += 1;
        quiz.avgScore = Math.round(((quiz.avgScore * (quiz.timesAttempted - 1)) + score) / quiz.timesAttempted);
        await quiz.save();
      }
    }

    // Update student scores
    const student = await Student.findById(req.user.id);
    const subKey = subject.toLowerCase()
      .replace('mathematics', 'math')
      .replace(/^physics.*/i, 'physics')
      .replace(/^chemistry.*/i, 'chemistry')
      .replace(/^math.*/i, 'math');

    if (!student.subjects) student.subjects = { physics: 0, math: 0, chemistry: 0 };
    if (student.subjects[subKey] !== undefined) {
      const prev = student.subjects[subKey] || 0;
      // First quiz: use raw score. Subsequent: weighted rolling average
      student.subjects[subKey] = prev === 0 ? score : Math.round((prev * 0.65) + (score * 0.35));
      student.markModified('subjects');
    }

    // Merge weak topics
    (aiAnalysis.weakConcepts || []).forEach(concept => {
      const exist = student.weakTopics.find(w => w.topic === concept && w.subject === subject);
      if (exist) exist.score = Math.round((exist.score + score) / 2);
      else student.weakTopics.push({ subject, topic: concept, score });
    });

    // Remove from weak if now mastered
    (aiAnalysis.correctConcepts || []).forEach(concept => {
      student.weakTopics = student.weakTopics.filter(w => !(w.topic === concept && w.subject === subject));
    });

    // Update topic-level scores
    answers.forEach(a => {
      const ts = student.topicScores.find(t => t.topic === a.concept && t.subject === subject);
      if (ts) {
        ts.score = Math.round((ts.score + (a.isCorrect ? 100 : 0)) / 2);
        ts.attempts += 1;
      } else {
        student.topicScores.push({ subject, topic: a.concept, score: a.isCorrect ? 100 : 0, attempts: 1 });
      }
    });

    student.quizzesTaken += 1;
    await student.save();

    res.json({ result, aiAnalysis });
  } catch (err) {
    console.error('quiz-result error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/student/lesson-viewed', auth, async (req, res) => {
  try {
    await Student.findByIdAndUpdate(req.user.id, { $inc: { lessonsViewed: 1 } });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════
//  TEACHER ROUTES
// ════════════════════════════════════════════════════════
app.get('/api/teacher/dashboard', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher only' });
    const teacher  = await Teacher.findById(req.user.id).lean();
    const students = await Student.find({}).lean();

    // Compute class topic averages
    const topicMap = {};
    students.forEach(s => (s.topicScores || []).forEach(ts => {
      const key = `${ts.subject}::${ts.topic}`;
      if (!topicMap[key]) topicMap[key] = { subject: ts.subject, topic: ts.topic, total: 0, count: 0 };
      topicMap[key].total += ts.score;
      topicMap[key].count += 1;
    }));

    const classTopics = Object.values(topicMap).map(t => ({
      subject: t.subject, topic: t.topic,
      correctPct: Math.round(t.total / t.count),
    })).sort((a, b) => a.correctPct - b.correctPct);

    const weakClassTopics   = classTopics.filter(t => t.correctPct < 65);
    const strongClassTopics = classTopics.filter(t => t.correctPct >= 80);

    const atRiskStudents = students
      .map(s => ({ ...s, avg: Math.round(((s.subjects?.physics||0)+(s.subjects?.math||0)+(s.subjects?.chemistry||0))/3) }))
      .filter(s => s.avg < 60);

    const classAvg = students.length
      ? Math.round(students.reduce((sum, s) => sum + Math.round(((s.subjects?.physics||0)+(s.subjects?.math||0)+(s.subjects?.chemistry||0))/3), 0) / students.length)
      : 0;

    const recentResults = await QuizResult.find({})
      .populate('studentId', 'name email')
      .sort({ takenAt: -1 }).limit(20).lean();

    res.json({
      teacher: strip(teacher),
      classStats: {
        classAvg, totalStudents: students.length,
        atRiskCount: atRiskStudents.length,
        quizzesGiven: await QuizUpload.countDocuments({ teacherId: req.user.id }),
        weakTopicsCount: weakClassTopics.length,
      },
      weakClassTopics, strongClassTopics, atRiskStudents,
      students: students.map(s => ({
        name: s.name, email: s.email, studentId: s.studentId,
        subjects: s.subjects, weakTopics: s.weakTopics, quizzesTaken: s.quizzesTaken,
        avg: Math.round(((s.subjects?.physics||0)+(s.subjects?.math||0)+(s.subjects?.chemistry||0))/3),
      })),
      recentResults,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/teacher/upload-quiz', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher only' });
    const { subject, topic, title, notes, difficulty, questionCount } = req.body;
    const upload = await QuizUpload.create({
      teacherId: req.user.id, subject, topic, title, notes,
      difficulty: difficulty || 'medium',
      questionCount: questionCount || 10,
    });
    res.json({ upload, message: 'Quiz uploaded!' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST assign a generated quiz to the class
app.post('/api/teacher/assign-quiz', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher only' });
    const { quizId, dueDate, instructions } = req.body;
    if (!quizId) return res.status(400).json({ error: 'quizId required' });
    const quiz = await GeneratedQuiz.findById(quizId).lean();
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

    // Prevent duplicate active assignments of the same quiz
    const existing = await QuizAssignment.findOne({ quizId, teacherId: req.user.id, isActive: true });
    if (existing) return res.json({ assignment: existing, alreadyAssigned: true });

    const assignment = await QuizAssignment.create({
      teacherId: req.user.id,
      quizId,
      subject: quiz.subject,
      topic: quiz.topic,
      title: quiz.title,
      dueDate: dueDate || null,
      instructions: instructions || '',
    });
    res.json({ assignment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET all active assignments (for teacher to manage)
app.get('/api/teacher/assignments', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher only' });
    const assignments = await QuizAssignment.find({ teacherId: req.user.id })
      .sort({ createdAt: -1 }).lean();

    // For each assignment, count how many students have attempted it
    const enriched = await Promise.all(assignments.map(async (a) => {
      const attemptCount = await QuizResult.countDocuments({ quizId: a.quizId });
      const totalStudents = await Student.countDocuments({});
      return { ...a, attemptCount, totalStudents };
    }));

    res.json({ assignments: enriched });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH toggle assignment active/inactive
app.patch('/api/teacher/assignments/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher only' });
    const { isActive } = req.body;
    const a = await QuizAssignment.findOneAndUpdate(
      { _id: req.params.id, teacherId: req.user.id },
      { isActive },
      { new: true }
    );
    if (!a) return res.status(404).json({ error: 'Assignment not found' });
    res.json({ assignment: a });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET assigned quizzes for a student (only active ones)
app.get('/api/student/assigned-quizzes', auth, async (req, res) => {
  try {
    const assignments = await QuizAssignment.find({ isActive: true })
      .sort({ createdAt: -1 }).lean();

    // Check which ones the student has already attempted
    const attempted = await QuizResult.find({ studentId: req.user.id })
      .select('quizId score takenAt').lean();
    const attemptMap = {};
    attempted.forEach(r => { attemptMap[String(r.quizId)] = { score: r.score, takenAt: r.takenAt }; });

    const result = assignments.map(a => ({
      ...a,
      attempted: !!attemptMap[String(a.quizId)],
      attemptScore: attemptMap[String(a.quizId)]?.score ?? null,
      attemptDate: attemptMap[String(a.quizId)]?.takenAt ?? null,
    }));

    res.json({ assignments: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET all stored quizzes and lessons summary (for teacher view)
app.get('/api/teacher/generated-content', auth, async (req, res) => {
  try {
    if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher only' });
    const quizzes = await GeneratedQuiz.find({}).sort({ createdAt: -1 })
      .select('subject topic title difficulty timesAttempted avgScore createdAt generatedBy').lean();
    const lessons = await GeneratedLesson.find({}).sort({ createdAt: -1 })
      .select('topic subject viewCount createdAt generatedBy lastViewed').lean();
    res.json({ quizzes, lessons });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ════════════════════════════════════════════════════════
//  phi3 GAP DETECTION
// ════════════════════════════════════════════════════════
async function runGapDetection(subject, topic, score, answers) {
  const correctConcepts = [...new Set(answers.filter(a => a.isCorrect).map(a => a.concept))];
  const weakConcepts    = [...new Set(answers.filter(a => !a.isCorrect).map(a => a.concept))];

  const prompt = `You are a JSON API for educational gap detection.
A student scored ${score}% on a quiz about "${topic}" (${subject}).
Correct concepts: ${correctConcepts.join(', ') || 'none'}
Weak/incorrect concepts: ${weakConcepts.join(', ') || 'none'}
Total questions: ${answers.length}, Correct: ${answers.filter(a=>a.isCorrect).length}

Return ONLY valid JSON, no extra text:
{
  "summary": "2 sentence performance summary",
  "correctConcepts": ${JSON.stringify(correctConcepts)},
  "weakConcepts": ${JSON.stringify(weakConcepts)},
  "diagnosis": "1-2 sentences on root cause of the gaps",
  "nextSteps": ["step 1", "step 2", "step 3"],
  "generatedBy": "ollama/phi3"
}`;

  try {
    console.log(`🤖 Running gap detection for ${subject}/${topic}...`);
    const raw  = await ollamaGenerate(prompt, 60000);
    return extractJSON(raw);
  } catch (e) {
    console.warn('Gap detection fallback:', e.message);
    return {
      summary: `Student scored ${score}% on ${topic}. ${weakConcepts.length ? 'Gaps in: ' + weakConcepts.join(', ') : 'Good overall performance.'}`,
      correctConcepts, weakConcepts,
      diagnosis: weakConcepts.length ? 'Conceptual gaps detected in specific topics.' : 'No significant gaps.',
      nextSteps: weakConcepts.length
        ? ['Review AI lessons for weak topics', 'Practice more questions', 'Re-take the quiz']
        : ['Explore advanced topics', 'Take next chapter quiz'],
      generatedBy: 'fallback',
    };
  }
}

// ── HELPERS ─────────────────────────────────────────────
function strip(obj) {
  const { password, __v, ...rest } = obj;
  return rest;
}

// ── HEALTH CHECK ─────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  let ollamaStatus = 'offline';
  try {
    await ollamaGenerate('respond with exactly: {"ok":true}', 5000);
    ollamaStatus = 'online';
  } catch {}
  res.json({ server: 'ok', mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected', ollama: ollamaStatus, model: OLLAMA_MODEL });
});

app.listen(PORT, () => {
  console.log(`\n🚀 SmartGap_AI API → http://localhost:${PORT}`);
  console.log(`📦 MongoDB  → ${process.env.MONGO_URI || 'mongodb://localhost:27017/smartgap_ai'}`);
  console.log(`🤖 Ollama   → ${OLLAMA_HOST} (model: ${OLLAMA_MODEL})`);
  console.log(`🩺 Health   → http://localhost:${PORT}/api/health\n`);
});
