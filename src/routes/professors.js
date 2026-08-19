'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { getLectureAnalytics } = require('../controllers/professorController');

// GET /api/professors/:id/lectures/:lectureId/analytics
router.get(
  '/:id/lectures/:lectureId/analytics',
  requireAuth,
  requireRole('professor', 'admin'),
  getLectureAnalytics
);

module.exports = router;
