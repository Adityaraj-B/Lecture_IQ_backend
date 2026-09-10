'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  getCourses,
  createCourse,
  getActiveQuiz,
  enrollStudent,
  getCourseStudents,
} = require('../controllers/courseController');

// GET /api/courses — list all courses for the professor
router.get('/', requireAuth, requireRole('professor'), getCourses);

// POST /api/courses — create a new course
router.post('/', requireAuth, requireRole('professor'), createCourse);

// GET /api/courses/:id/active-quiz — student polls for a live quiz (every 5 s)
router.get('/:id/active-quiz', requireAuth, getActiveQuiz);

// POST /api/courses/:id/enroll — student self-enrolls
router.post('/:id/enroll', requireAuth, requireRole('student'), enrollStudent);

// GET /api/courses/:id/students — professor views enrolled students + stats
router.get('/:id/students', requireAuth, requireRole('professor', 'admin'), getCourseStudents);

module.exports = router;
