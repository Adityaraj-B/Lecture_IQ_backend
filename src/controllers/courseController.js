'use strict';

const Course = require('../models/Course');
const User = require('../models/User');
const Attempt = require('../models/Attempt');
const { createError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/courses — list all courses for the professor
// ─────────────────────────────────────────────────────────────────────────────
async function getCourses(req, res, next) {
  try {
    const courses = await Course.find({ professorId: req.user.id })
      .sort({ createdAt: -1 })
      .select('name code section enrolledStudents activeQuiz createdAt');
    res.json(
      courses.map((c) => ({
        _id: c._id,
        name: c.name,
        code: c.code,
        section: c.section,
        enrolledCount: c.enrolledStudents?.length || 0,
        hasActiveQuiz: !!c.activeQuiz?.mcqSetId,
        activeQuiz: c.activeQuiz || null,
        createdAt: c.createdAt,
      }))
    );
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/courses — create a new course
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
      enrolledCount: 0,
      createdAt: course.createdAt,
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/courses/:id/active-quiz
// Student polls this endpoint (every 5 s) to check for a live quiz
// ─────────────────────────────────────────────────────────────────────────────
async function getActiveQuiz(req, res, next) {
  try {
    const { id: courseId } = req.params;
    const studentId = req.user.id;

    const course = await Course.findById(courseId).select('activeQuiz enrolledStudents').lean();
    if (!course) throw createError(404, 'Course not found');

    // Verify student is enrolled (or admin)
    const isEnrolled =
      req.user.role === 'admin' ||
      req.user.role === 'professor' ||
      course.enrolledStudents?.some((s) => s.toString() === studentId);

    if (!isEnrolled) {
      return res.status(403).json({ error: 'You are not enrolled in this course' });
    }

    if (!course.activeQuiz || !course.activeQuiz.mcqSetId) {
      return res.json({ activeQuiz: null });
    }

    // Check if this student already attempted the active quiz
    const Attempt = require('../models/Attempt');
    const existingAttempt = await Attempt.findOne({
      studentId,
      mcqSetId: course.activeQuiz.mcqSetId,
    }).select('score submittedAt').lean();

    res.json({
      activeQuiz: {
        ...course.activeQuiz,
        alreadyAttempted: !!existingAttempt,
        attemptScore: existingAttempt?.score ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/courses/:id/enroll
// Student self-enrolls by course code
// Body: { courseCode }
// ─────────────────────────────────────────────────────────────────────────────
async function enrollStudent(req, res, next) {
  try {
    const { id: courseId } = req.params;
    const studentId = req.user.id;

    if (req.user.role !== 'student' && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only students can enroll in courses' });
    }

    const course = await Course.findById(courseId);
    if (!course) throw createError(404, 'Course not found');

    // Check already enrolled
    if (course.enrolledStudents.some((s) => s.toString() === studentId)) {
      return res.json({ message: 'Already enrolled', courseId, courseName: course.name });
    }

    // Add student
    await Course.findByIdAndUpdate(courseId, {
      $addToSet: { enrolledStudents: studentId },
    });

    // Also add course to user's courses array
    await User.findByIdAndUpdate(studentId, {
      $addToSet: { courses: courseId },
    });

    res.json({ message: 'Enrolled successfully', courseId, courseName: course.name });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/courses/:id/students
// Professor views all enrolled students with their attempt stats for this course
// ─────────────────────────────────────────────────────────────────────────────
async function getCourseStudents(req, res, next) {
  try {
    const { id: courseId } = req.params;

    const course = await Course.findById(courseId)
      .select('enrolledStudents professorId name code')
      .populate('enrolledStudents', 'name email collegeId preferredLanguage')
      .lean();

    if (!course) throw createError(404, 'Course not found');
    if (course.professorId.toString() !== req.user.id && req.user.role !== 'admin') {
      throw createError(403, 'You do not own this course');
    }

    const mongoose = require('mongoose');
    const courseObjId = new mongoose.Types.ObjectId(courseId);

    // Get all attempts for lectures in this course
    const Lecture = require('../models/Lecture');
    const lectures = await Lecture.find({ courseId: courseObjId, status: 'published' }).select('_id').lean();
    const lectureIds = lectures.map((l) => l._id);

    // Aggregate attempt stats per student
    const attemptStats = await Attempt.aggregate([
      { $match: { lectureId: { $in: lectureIds } } },
      {
        $group: {
          _id: '$studentId',
          totalAttempts: { $sum: 1 },
          averageScore: { $avg: '$score' },
          highestScore: { $max: '$score' },
          lastAttemptAt: { $max: '$submittedAt' },
        },
      },
    ]);

    const statsMap = new Map(attemptStats.map((s) => [s._id.toString(), s]));

    const students = (course.enrolledStudents || []).map((student) => {
      const stats = statsMap.get(student._id.toString()) || {
        totalAttempts: 0,
        averageScore: 0,
        highestScore: 0,
        lastAttemptAt: null,
      };
      return {
        studentId: student._id,
        name: student.name,
        email: student.email,
        collegeId: student.collegeId,
        preferredLanguage: student.preferredLanguage,
        totalAttempts: stats.totalAttempts,
        averageScore: Math.round(stats.averageScore || 0),
        highestScore: stats.highestScore || 0,
        lastAttemptAt: stats.lastAttemptAt,
        quizzesCompleted: stats.totalAttempts,
        quizzesAvailable: lectures.length,
      };
    });

    res.json({
      courseId,
      courseName: course.name,
      courseCode: course.code,
      enrolledCount: students.length,
      publishedQuizCount: lectures.length,
      students,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getCourses, createCourse, getActiveQuiz, enrollStudent, getCourseStudents };
