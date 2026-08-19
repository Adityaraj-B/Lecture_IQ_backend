'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { submitAttempt } = require('../controllers/attemptController');

// POST /api/attempts — student submits answers
router.post('/', requireAuth, requireRole('student'), submitAttempt);

module.exports = router;
