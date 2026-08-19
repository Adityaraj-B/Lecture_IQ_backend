'use strict';

const Course = require('../models/Course');
const createError = require('http-errors');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/courses
// Returns all courses belonging to the authenticated professor
// ─────────────────────────────────────────────────────────────────────────────
async function getCourses(req, res, next) {
  try {
    const courses = await Course.find({ professorId: req.user.id })
      .sort({ createdAt: -1 })
      .select('name code section createdAt');
    res.json(courses);
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/courses
// Creates a new course for the authenticated professor
// Body: { name, code, section? }
// ─────────────────────────────────────────────────────────────────────────────
async function createCourse(req, res, next) {
  try {
    const { name, code, section } = req.body;
    if (!name || !name.trim()) throw createError(400, 'Course name is required');
    if (!code || !code.trim()) throw createError(400, 'Course code is required');

    const course = await Course.create({
      name: name.trim(),
      code: code.trim().toUpperCase(),
      section: section?.trim() || undefined,
      professorId: req.user.id,
    });

    res.status(201).json({
      _id: course._id,
      name: course.name,
      code: course.code,
      section: course.section,
      createdAt: course.createdAt,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getCourses, createCourse };
