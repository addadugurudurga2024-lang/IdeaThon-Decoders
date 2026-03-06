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
    name:      'Mr.Prem',
    teacherId: 'TCH-001',
    email:     'prem@gmail.com',
    password:  'prem123',
    subject:   'Dedicated',
    grade:     'Grade 1',
    section:   'Scope',
  });
  console.log('Teacher created:', teacher.name, '| password hashed:', teacher.password.startsWith('$2'));

  const studentData = [
    { name: 'A Abhishek',     email: 'abhishek@gmail.com',   studentId: '24BRS1362',  password: 'pass12'  },
    { name: 'Rohith K',   email: 'rohith@gmail.com',  studentId: '24BRS1304', password: 'pass123' },
    { name: 'Meera',  email: 'meera@gmail.com', studentId: '24BYB1169', password: 'pass123' },
    { name: 'Priya', email: 'priya@gmail.com', studentId: '24BCE1352', password: 'pass123' },
    { name: 'Rohith S',   email: 'rohith.s@gmail.com',  studentId: '24BCE5245', password: 'pass123' },
    { name: 'Chetan',     email: 'chetan@gmail.com',  studentId: '24BRS1301', password: 'pass123' },
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
  console.log('Teacher quiz upload created\n');

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
