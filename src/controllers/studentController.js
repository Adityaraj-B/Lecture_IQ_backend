'use strict';

const Attempt = require('../models/Attempt');
const MCQSet = require('../models/MCQSet');
const Course = require('../models/Course');
const User = require('../models/User');
const { createError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/:id/quizzes
// Lists published quizzes for the student's enrolled courses
// ─────────────────────────────────────────────────────────────────────────────
async function getStudentQuizzes(req, res, next) {
  try {
    const { id: studentId } = req.params;

    // Only allow students to view their own data (or admin)
    if (req.user.role !== 'admin' && req.user.id !== studentId) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }

    const student = await User.findById(studentId).select('courses');
    if (!student) throw createError(404, 'Student not found');

    // Get all published MCQSets for the student's enrolled courses
    const courses = await Course.find({
      $or: [
        { _id: { $in: student.courses } },
        { enrolledStudents: studentId },
      ],
    }).select('_id name code');

    if (courses.length === 0) return res.json({ pending: [], completed: [] });

    const courseIds = courses.map((c) => c._id);

    // Get published MCQSets for these courses via Lecture join
    const Lecture = require('../models/Lecture');
    const lectures = await Lecture.find({
      courseId: { $in: courseIds },
      status: 'published',
    }).select('_id courseId title');

    const lectureIds = lectures.map((l) => l._id);
    const mcqSets = await MCQSet.find({
      lectureId: { $in: lectureIds },
      status: 'published',
    }).select('_id lectureId publishedAt questions');

    // Find which ones the student already attempted
    const attempts = await Attempt.find({
      studentId,
      mcqSetId: { $in: mcqSets.map((m) => m._id) },
    }).select('mcqSetId score submittedAt');

    const attemptedSetIds = new Set(attempts.map((a) => a.mcqSetId.toString()));

    const lectureMap = new Map(lectures.map((l) => [l._id.toString(), l]));
    const attemptMap = new Map(attempts.map((a) => [a.mcqSetId.toString(), a]));

    const pending = [];
    const completed = [];

    for (const mcqSet of mcqSets) {
      const lecture = lectureMap.get(mcqSet.lectureId.toString());
      const quizInfo = {
        mcqSetId: mcqSet._id,
        lectureId: mcqSet.lectureId,
        lectureTitle: lecture?.title,
        publishedAt: mcqSet.publishedAt,
        questionCount: mcqSet.questions.length,
      };

      if (attemptedSetIds.has(mcqSet._id.toString())) {
        const attempt = attemptMap.get(mcqSet._id.toString());
        completed.push({ ...quizInfo, score: attempt.score, submittedAt: attempt.submittedAt });
      } else {
        pending.push(quizInfo);
      }
    }

    res.json({ pending, completed });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/students/:id/dashboard
// Aggregates concept mastery across all attempts
// ─────────────────────────────────────────────────────────────────────────────
async function getStudentDashboard(req, res, next) {
  try {
    const { id: studentId } = req.params;

    if (req.user.role !== 'admin' && req.user.id !== studentId) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }

    const mongoose = require('mongoose');
    const studentObjId = new mongoose.Types.ObjectId(studentId);

    // MongoDB aggregation — concept mastery summary
    const conceptMastery = await Attempt.aggregate([
      { $match: { studentId: studentObjId } },
      { $unwind: '$conceptBreakdown' },
      {
        $group: {
          _id: '$conceptBreakdown.conceptId',
          totalCorrect: { $sum: '$conceptBreakdown.correct' },
          totalAttempted: { $sum: '$conceptBreakdown.total' },
        },
      },
      {
        $project: {
          conceptId: '$_id',
          totalCorrect: 1,
          totalAttempted: 1,
          masteryPercent: {
            $cond: [
              { $gt: ['$totalAttempted', 0] },
              { $multiply: [{ $divide: ['$totalCorrect', '$totalAttempted'] }, 100] },
              0,
            ],
          },
        },
      },
      { $sort: { masteryPercent: 1 } }, // weakest first
    ]);

    // Overall stats
    const overallStats = await Attempt.aggregate([
      { $match: { studentId: studentObjId } },
      {
        $group: {
          _id: null,
          totalAttempts: { $sum: 1 },
          averageScore: { $avg: '$score' },
          highestScore: { $max: '$score' },
          lowestScore: { $min: '$score' },
        },
      },
    ]);

    const stats = overallStats[0] || { totalAttempts: 0, averageScore: 0, highestScore: 0, lowestScore: 0 };

    res.json({
      studentId,
      overall: {
        totalAttempts: stats.totalAttempts,
        averageScore: Math.round(stats.averageScore || 0),
        highestScore: stats.highestScore || 0,
        lowestScore: stats.lowestScore || 0,
      },
      conceptMastery: conceptMastery.map((c) => ({
        ...c,
        masteryPercent: Math.round(c.masteryPercent),
        strength: c.masteryPercent >= 75 ? 'strong' : c.masteryPercent >= 50 ? 'average' : 'weak',
      })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getStudentQuizzes, getStudentDashboard };
