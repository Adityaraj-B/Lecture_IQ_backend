'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const {
  startLecture,
  uploadChunk,
  finalizeLecture,
  getLectureStatus,
  getTranscript,
  getMCQDraft,
  patchMCQDraft,
  publishLecture,
  getUserLectures,
} = require('../controllers/lectureController');
const { getLectureAttempts } = require('../controllers/attemptController');

// GET /api/lectures — returns all lectures for the authenticated user (professor)
router.get('/', requireAuth, requireRole('professor'), getUserLectures);

// GET /api/lectures/:id/attempts — returns attempts for a lecture
router.get('/:id/attempts', requireAuth, requireRole('professor'), getLectureAttempts);

// POST /api/lectures/start — professor creates a new lecture session
router.post('/start', requireAuth, requireRole('professor'), startLecture);

// POST /api/lectures/:id/chunk — professor uploads an audio chunk
router.post(
  '/:id/chunk',
  requireAuth,
  requireRole('professor'),
  upload.single('audio'),
  uploadChunk
);

// POST /api/lectures/:id/finalize — professor signals end of recording
router.post('/:id/finalize', requireAuth, requireRole('professor'), finalizeLecture);

// GET /api/lectures/:id/status — polling fallback for any authenticated user
router.get('/:id/status', requireAuth, getLectureStatus);

// GET /api/lectures/:id/transcript — returns transcript segments
router.get('/:id/transcript', requireAuth, getTranscript);

// GET /api/lectures/:id/mcq-draft — professor retrieves the draft MCQSet
router.get('/:id/mcq-draft', requireAuth, requireRole('professor'), getMCQDraft);

// PATCH /api/lectures/:id/mcq-draft — professor edits the draft
router.patch('/:id/mcq-draft', requireAuth, requireRole('professor'), patchMCQDraft);

// POST /api/lectures/:id/publish — professor publishes the quiz
router.post('/:id/publish', requireAuth, requireRole('professor'), publishLecture);

module.exports = router;
