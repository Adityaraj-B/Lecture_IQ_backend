'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { getLectureAnalytics, getProfessorOverallAnalytics, sendStudentFeedback } = require('../controllers/professorController');

// GET /api/professors/:id/analytics — overall stats across all courses & lectures
router.get(
  '/:id/analytics',
  requireAuth,
  requireRole('professor', 'admin'),
  getProfessorOverallAnalytics
);

// GET /api/professors/:id/lectures/:lectureId/analytics — per-lecture breakdown with student table
router.get(
  '/:id/lectures/:lectureId/analytics',
  requireAuth,
  requireRole('professor', 'admin'),
  getLectureAnalytics
);

// POST /api/professors/:id/feedback — send manual feedback to a student
router.post(
  '/:id/feedback',
  requireAuth,
  requireRole('professor', 'admin'),
  sendStudentFeedback
);

module.exports = router;
