'use strict';

const router = require('express').Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const { getCourses, createCourse } = require('../controllers/courseController');

// GET /api/courses — list all courses for the professor
router.get('/', requireAuth, requireRole('professor'), getCourses);

// POST /api/courses — create a new course
router.post('/', requireAuth, requireRole('professor'), createCourse);

module.exports = router;
