require('dotenv').config();
const mongoose = require('mongoose');
const { Student, Teacher, GeneratedQuiz, GeneratedLesson, QuizResult, QuizUpload } = require('./models');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/smartgap_ai';

async function seed() {
  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB:', MONGO_URI);

  // Clear ALL existing data
  await Promise.all([
    Student.deleteMany({}),
    Teacher.deleteMany({}),
    QuizResult.deleteMany({}),
    QuizUpload.deleteMany({}),
    GeneratedQuiz.deleteMany({}),
    GeneratedLesson.deleteMany({}),
  ]);
  console.log('🧹 Cleared all existing data');

  // ── CREATE TEACHER ─────────────────────────────────────
  // MUST use .create() not insertMany — so bcrypt pre('save') hook runs
  const teacher = await Teacher.create({
    name:      'Mrs. Sarah Johnson',
    teacherId: 'TCH-001',
    email:     'sarah.johnson@school.edu',
    password:  'teacher123',
    subject:   'Physics',
    grade:     'Grade 10',
    section:   'Section A',
  });
  console.log('👩‍🏫 Teacher created:', teacher.name, '| password hashed:', teacher.password.startsWith('$2'));

  // ── CREATE STUDENTS ────────────────────────────────────
  // IMPORTANT: Use Student.create() one at a time — NOT insertMany()
  // insertMany() SKIPS Mongoose middleware, so passwords are NOT hashed
  // Student.create() triggers pre('save') → bcrypt hashes the password
  const studentData = [
    { name: 'Abhishek',     email: 'alex@gmail.com',   studentId: 'STU-01',  password: 'pass12'  },
    { name: 'Ravi Kumar',   email: 'ravi@school.edu',  studentId: 'STU-002', password: 'pass123' },
    { name: 'Meera Patel',  email: 'meera@school.edu', studentId: 'STU-003', password: 'pass123' },
    { name: 'Priya Sharma', email: 'priya@school.edu', studentId: 'STU-004', password: 'pass123' },
    { name: 'Sara Ahmed',   email: 'sara@school.edu',  studentId: 'STU-005', password: 'pass123' },
    { name: 'Chen Wei',     email: 'chen@school.edu',  studentId: 'STU-006', password: 'pass123' },
  ];

  const students = [];
  for (const data of studentData) {
    const s = await Student.create(data);
    console.log(`  ✓ ${s.name.padEnd(15)} email: ${s.email.padEnd(25)} id: ${s.studentId.padEnd(8)} hashed: ${s.password.startsWith('$2') ? '✅' : '❌'}`);
    students.push(s);
  }
  console.log(`\n🎓 ${students.length} students created with bcrypt-hashed passwords`);

  // ── QUIZ UPLOAD BY TEACHER ─────────────────────────────
  await QuizUpload.create({
    teacherId:     teacher._id,
    subject:       'Physics',
    topic:         'Laws of Motion',
    title:         'Chapter 4 Assessment – Laws of Motion',
    notes:         "Newton's Laws: First law - inertia. Second law - F=ma. Third law - action-reaction pairs. Free body diagrams show all forces acting on an object.",
    questionCount: 10,
  });
  console.log('📤 Teacher quiz upload created\n');

  console.log('✅ SEED COMPLETE!\n');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('LOGIN CREDENTIALS:');
  console.log('');
  console.log('STUDENTS:');
  studentData.forEach(s =>
    console.log(`  Name: ${s.name.padEnd(15)} Email: ${s.email.padEnd(26)} ID: ${s.studentId.padEnd(8)} Pass: ${s.password}`)
  );
  console.log('');
  console.log('TEACHER:');
  console.log('  Name: Mrs. Sarah Johnson   ID: TCH-001   Pass: teacher123');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await mongoose.disconnect();
  console.log('\n✅ Disconnected. Run your server and login!');
}

seed().catch(err => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});