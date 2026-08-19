'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { getStudentQuizzes, getStudentDashboard } = require('../controllers/studentController');

// GET /api/students/:id/quizzes
router.get('/:id/quizzes', requireAuth, getStudentQuizzes);

// GET /api/students/:id/dashboard
router.get('/:id/dashboard', requireAuth, getStudentDashboard);

module.exports = router;
