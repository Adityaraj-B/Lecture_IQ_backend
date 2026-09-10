'use strict';

const mongoose = require('mongoose');
const Attempt = require('../models/Attempt');
const MCQSet = require('../models/MCQSet');
const Course = require('../models/Course');
const Lecture = require('../models/Lecture');
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

    const courses = await Course.find({
      $or: [
        { _id: { $in: student.courses } },
        { enrolledStudents: studentId },
      ],
    }).select('_id name code');

    if (courses.length === 0) return res.json({ pending: [], completed: [] });

    const courseIds = courses.map((c) => c._id);

    const lectures = await Lecture.find({
      courseId: { $in: courseIds },
      status: 'published',
    }).select('_id courseId title');

    const lectureIds = lectures.map((l) => l._id);
    const mcqSets = await MCQSet.find({
      lectureId: { $in: lectureIds },
      status: 'published',
    }).select('_id lectureId publishedAt questions');

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
// GET /api/students/:id/dashboard   (or /api/students/me/dashboard)
// Full dashboard: overall stats + recent attempts + pending quizzes + concepts
// ─────────────────────────────────────────────────────────────────────────────
async function getStudentDashboard(req, res, next) {
  try {
    // Support both /me/dashboard and /:id/dashboard
    const studentId = req.params.id === 'me' ? req.user.id : req.params.id;

    if (req.user.role !== 'admin' && req.user.id !== studentId) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }

    const studentObjId = new mongoose.Types.ObjectId(studentId);

    // ── 1. Overall stats ─────────────────────────────────────────────────────
    const overallStatsAgg = await Attempt.aggregate([
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
    const stats = overallStatsAgg[0] || {
      totalAttempts: 0,
      averageScore: 0,
      highestScore: 0,
      lowestScore: 0,
    };

    // ── 2. Recent attempts (last 10, with lecture title populated) ───────────
    const recentAttemptDocs = await Attempt.find({ studentId: studentObjId })
      .sort({ submittedAt: -1 })
      .limit(10)
      .select('lectureId mcqSetId score answers submittedAt startedAt')
      .lean();

    // Populate lecture titles
    const recentLectureIds = [...new Set(recentAttemptDocs.map((a) => a.lectureId.toString()))];
    const recentLectures = await Lecture.find({ _id: { $in: recentLectureIds } }).select('title').lean();
    const lectureTitleMap = new Map(recentLectures.map((l) => [l._id.toString(), l.title]));

    // Populate mcqSet question counts
    const recentMcqSetIds = [...new Set(recentAttemptDocs.map((a) => a.mcqSetId.toString()))];
    const recentMcqSets = await MCQSet.find({ _id: { $in: recentMcqSetIds } }).select('questions').lean();
    const mcqQuestionCountMap = new Map(recentMcqSets.map((m) => [m._id.toString(), m.questions.length]));

    const recentAttempts = recentAttemptDocs.map((a) => {
      const totalQuestions = mcqQuestionCountMap.get(a.mcqSetId.toString()) || a.answers.length;
      const timeTakenSeconds = a.startedAt && a.submittedAt
        ? Math.round((new Date(a.submittedAt) - new Date(a.startedAt)) / 1000)
        : null;
      return {
        attemptId: a._id,
        lectureId: a.lectureId,
        mcqSetId: a.mcqSetId,
        lectureTitle: lectureTitleMap.get(a.lectureId.toString()) || 'Untitled Lecture',
        score: a.score ?? 0,
        totalQuestions,
        submittedAt: a.submittedAt,
        timeTakenSeconds,
      };
    });

    // ── 3. Pending quizzes (published quizzes student hasn't attempted) ──────
    const student = await User.findById(studentId).select('courses name preferredLanguage').lean();
    if (!student) throw createError(404, 'Student not found');

    const enrolledCourses = await Course.find({
      $or: [
        { _id: { $in: student.courses || [] } },
        { enrolledStudents: studentObjId },
      ],
    }).select('_id name code activeQuiz').lean();

    const enrolledCourseIds = enrolledCourses.map((c) => c._id);

    const publishedLectures = await Lecture.find({
      courseId: { $in: enrolledCourseIds },
      status: 'published',
    }).select('_id courseId title').lean();

    const publishedLectureIds = publishedLectures.map((l) => l._id);
    const publishedMcqSets = await MCQSet.find({
      lectureId: { $in: publishedLectureIds },
      status: 'published',
    }).select('_id lectureId publishedAt questions').lean();

    // Which ones has this student already attempted?
    const attemptedMcqSetIds = new Set(
      (await Attempt.find({ studentId: studentObjId, mcqSetId: { $in: publishedMcqSets.map((m) => m._id) } })
        .select('mcqSetId').lean())
        .map((a) => a.mcqSetId.toString())
    );

    const allLectureMap = new Map(publishedLectures.map((l) => [l._id.toString(), l]));
    const pendingQuizzes = publishedMcqSets
      .filter((m) => !attemptedMcqSetIds.has(m._id.toString()))
      .map((m) => ({
        mcqSetId: m._id,
        lectureId: m.lectureId,
        lectureTitle: allLectureMap.get(m.lectureId.toString())?.title || 'Untitled Lecture',
        publishedAt: m.publishedAt,
        questionCount: m.questions.length,
      }));

    // ── 4. Concept mastery (sorted weakest first) ────────────────────────────
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

    // ── 5. Active quiz from enrolled courses (polling-based real-time) ────────
    // Return the most recently published activeQuiz across all enrolled courses
    let activeQuiz = null;
    for (const course of enrolledCourses) {
      if (course.activeQuiz && course.activeQuiz.mcqSetId) {
        // Check if student already attempted this
        const alreadyAttempted = attemptedMcqSetIds.has(course.activeQuiz.mcqSetId.toString());
        if (!activeQuiz || new Date(course.activeQuiz.publishedAt) > new Date(activeQuiz.publishedAt)) {
          activeQuiz = {
            ...course.activeQuiz,
            courseId: course._id,
            courseName: course.name,
            alreadyAttempted,
          };
        }
      }
    }

    res.json({
      studentId,
      studentName: student.name,
      preferredLanguage: student.preferredLanguage,
      overall: {
        totalAttempts: stats.totalAttempts,
        averageScore: Math.round(stats.averageScore || 0),
        highestScore: stats.highestScore || 0,
        lowestScore: stats.lowestScore || 0,
      },
      activeQuiz,           // null if no active quiz
      recentAttempts,       // last 10 attempts with lecture titles
      pendingQuizzes,       // all published quizzes not yet attempted
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
