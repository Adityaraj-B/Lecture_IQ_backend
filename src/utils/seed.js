'use strict';

/**
 * Seed script — creates one test User (professor), Course, and Lecture.
 * Run with: npm run seed
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const { connectDB } = require('../config/db');
const User = require('../models/User');
const Course = require('../models/Course');
const Lecture = require('../models/Lecture');

async function seed() {
  await connectDB();

  // ── Clean up previous seed data ─────────────────────────────────────────────
  await User.deleteMany({ email: 'prof.test@lectureiq.dev' });
  await Course.deleteMany({ code: 'CS101-SEED' });

  // ── Create professor user ────────────────────────────────────────────────────
  const passwordHash = await bcrypt.hash('password123', 10);
  const professor = await User.create({
    role: 'professor',
    name: 'Dr. Test Professor',
    email: 'prof.test@lectureiq.dev',
    passwordHash,
    collegeId: 'COLLEGE-001',
    preferredLanguage: 'en',
  });
  console.log('[Seed] Created User:', professor._id, professor.email);

  // ── Create course ────────────────────────────────────────────────────────────
  const course = await Course.create({
    name: 'Introduction to Computer Science',
    code: 'CS101-SEED',
    professorId: professor._id,
    section: 'A',
  });
  console.log('[Seed] Created Course:', course._id, course.code);

  // ── Create lecture ───────────────────────────────────────────────────────────
  const lecture = await Lecture.create({
    courseId: course._id,
    professorId: professor._id,
    title: 'Lecture 1 — Introduction',
    status: 'recording',
    language: { primary: 'en', alternates: ['hi'] },
  });
  console.log('[Seed] Created Lecture:', lecture._id, lecture.title);

  console.log('\n✅ Seed complete. MongoDB collections created successfully.');
  console.log('   Test login → email: prof.test@lectureiq.dev | password: password123');

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error('[Seed] Error:', err);
  process.exit(1);
});
