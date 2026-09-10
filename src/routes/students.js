'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { getStudentQuizzes, getStudentDashboard } = require('../controllers/studentController');

// GET /api/students/me/dashboard — authenticated student's own dashboard
// No role guard here — the controller enforces that students only see their own data.
// This allows admins to also view student dashboards.
router.get('/me/dashboard', requireAuth, getStudentDashboard);

// GET /api/students/:id/quizzes
router.get('/:id/quizzes', requireAuth, getStudentQuizzes);

// GET /api/students/:id/dashboard — works with explicit ID (or "me")
router.get('/:id/dashboard', requireAuth, getStudentDashboard);

module.exports = router;
