const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

// ── STUDENT ──────────────────────────────────────────────
const studentSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  studentId: { type: String, required: true, unique: true },
  password:  { type: String, required: true },
  grade:     { type: String, default: 'Grade 10' },
  section:   { type: String, default: 'Section A' },
  subjects: {
    physics:   { type: Number, default: 0 },
    math:      { type: Number, default: 0 },
    chemistry: { type: Number, default: 0 },
  },
  topicScores: [{
    subject:  String,
    topic:    String,
    score:    Number,
    attempts: { type: Number, default: 1 },
  }],
  weakTopics: [{
    subject: String,
    topic:   String,
    score:   Number,
  }],
  quizzesTaken:  { type: Number, default: 0 },
  lessonsViewed: { type: Number, default: 0 },
}, { timestamps: true });

studentSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});
studentSchema.methods.matchPassword = function (pw) {
  return bcrypt.compare(pw, this.password);
};

// ── TEACHER ──────────────────────────────────────────────
const teacherSchema = new mongoose.Schema({
  name:      { type: String, required: true },
  teacherId: { type: String, required: true, unique: true },
  email:     { type: String, required: true, unique: true, lowercase: true },
  password:  { type: String, required: true },
  subject:   { type: String, default: 'Physics' },
  grade:     { type: String, default: 'Grade 10' },
  section:   { type: String, default: 'Section A' },
}, { timestamps: true });

teacherSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});
teacherSchema.methods.matchPassword = function (pw) {
  return bcrypt.compare(pw, this.password);
};

// ── GENERATED QUIZ (phi3 → stored in DB) ─────────────────
const generatedQuizSchema = new mongoose.Schema({
  subject:      { type: String, required: true },
  topic:        { type: String, required: true },
  title:        { type: String, required: true },
  difficulty:   { type: String, enum: ['easy','medium','hard'], default: 'medium' },
  generatedBy:  { type: String, default: 'ollama/phi3' },
  teacherId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', default: null },
  questions: [{
    question:    { type: String, required: true },
    options:     [{ type: String }],
    answer:      { type: Number },
    concept:     { type: String },
    explanation: { type: String },
  }],
  timesAttempted: { type: Number, default: 0 },
  avgScore:       { type: Number, default: 0 },
}, { timestamps: true });

// ── GENERATED LESSON (phi3 → stored in DB) ───────────────
const generatedLessonSchema = new mongoose.Schema({
  topic:       { type: String, required: true },
  subject:     { type: String, required: true },
  generatedBy: { type: String, default: 'ollama/phi3' },
  tagline:     String,
  explanation: String,
  keyFormula:  String,
  keyFormulaExplained: String,
  commonMistakes:      [String],
  practiceQuestions: [{
    q: String,
    a: String,
  }],
  viewCount:  { type: Number, default: 0 },
  lastViewed: { type: Date },
}, { timestamps: true });

// ── QUIZ RESULT ───────────────────────────────────────────
const quizResultSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
  quizId:    { type: mongoose.Schema.Types.ObjectId, ref: 'GeneratedQuiz', default: null },
  subject:   { type: String, required: true },
  topic:     { type: String, required: true },
  score:     { type: Number, required: true },
  totalQ:    { type: Number, required: true },
  correctQ:  { type: Number, required: true },
  answers: [{
    question:       String,
    concept:        String,
    selectedOption: Number,
    correctOption:  Number,
    isCorrect:      Boolean,
  }],
  aiAnalysis: {
    summary:         String,
    correctConcepts: [String],
    weakConcepts:    [String],
    diagnosis:       String,
    nextSteps:       [String],
    generatedBy:     { type: String, default: 'ollama/phi3' },
  },
  takenAt: { type: Date, default: Date.now },
}, { timestamps: true });

// ── QUIZ UPLOAD ───────────────────────────────────────────
const quizUploadSchema = new mongoose.Schema({
  teacherId:       { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
  subject:         { type: String, required: true },
  topic:           { type: String, required: true },
  title:           { type: String, required: true },
  notes:           { type: String, default: '' },
  difficulty:      { type: String, default: 'medium' },
  questionCount:   { type: Number, default: 10 },
  generatedQuizId: { type: mongoose.Schema.Types.ObjectId, ref: 'GeneratedQuiz', default: null },
}, { timestamps: true });

// ── QUIZ ASSIGNMENT (teacher assigns quiz to class) ───────
const quizAssignmentSchema = new mongoose.Schema({
  teacherId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Teacher', required: true },
  quizId:       { type: mongoose.Schema.Types.ObjectId, ref: 'GeneratedQuiz', required: true },
  subject:      { type: String, required: true },
  topic:        { type: String, required: true },
  title:        { type: String, required: true },
  instructions: { type: String, default: '' },
  dueDate:      { type: Date, default: null },
  isActive:     { type: Boolean, default: true },
}, { timestamps: true });

module.exports = {
  Student:         mongoose.model('Student',         studentSchema),
  Teacher:         mongoose.model('Teacher',         teacherSchema),
  GeneratedQuiz:   mongoose.model('GeneratedQuiz',   generatedQuizSchema),
  GeneratedLesson: mongoose.model('GeneratedLesson', generatedLessonSchema),
  QuizResult:      mongoose.model('QuizResult',      quizResultSchema),
  QuizUpload:      mongoose.model('QuizUpload',      quizUploadSchema),
  QuizAssignment:  mongoose.model('QuizAssignment',  quizAssignmentSchema),
};
