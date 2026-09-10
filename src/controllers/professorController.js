'use strict';

const mongoose = require('mongoose');
const Attempt = require('../models/Attempt');
const MCQSet = require('../models/MCQSet');
const Lecture = require('../models/Lecture');
const Course = require('../models/Course');
const User = require('../models/User');
const { createError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/professors/:id/analytics
// Overall professor stats across ALL lectures and courses
// ─────────────────────────────────────────────────────────────────────────────
async function getProfessorOverallAnalytics(req, res, next) {
  try {
    const { id: professorId } = req.params;

    if (req.user.role !== 'admin' && req.user.id !== professorId) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }

    const professorObjId = new mongoose.Types.ObjectId(professorId);

    // All lectures for this professor
    const lectures = await Lecture.find({ professorId: professorObjId })
      .select('_id status durationSeconds courseId title')
      .lean();

    const publishedLectures = lectures.filter((l) => l.status === 'published');
    const lectureIds = lectures.map((l) => l._id);
    const publishedLectureIds = publishedLectures.map((l) => l._id);

    // Total recording seconds
    const totalRecordingSeconds = lectures.reduce((sum, l) => sum + (l.durationSeconds || 0), 0);

    // Attempt stats across all published lectures
    const attemptStats = await Attempt.aggregate([
      { $match: { lectureId: { $in: publishedLectureIds } } },
      {
        $group: {
          _id: null,
          totalAttempts: { $sum: 1 },
          averageScore: { $avg: '$score' },
          uniqueStudents: { $addToSet: '$studentId' },
        },
      },
    ]);

    const attemptData = attemptStats[0] || { totalAttempts: 0, averageScore: 0, uniqueStudents: [] };

    // Questions generated across all published MCQSets
    const mcqSets = await MCQSet.find({ lectureId: { $in: publishedLectureIds } })
      .select('questions')
      .lean();
    const totalQuestionsGenerated = mcqSets.reduce((sum, m) => sum + m.questions.length, 0);

    // Distinct courses
    const courseIds = [...new Set(lectures.map((l) => l.courseId.toString()))];
    const courses = await Course.find({ _id: { $in: courseIds } })
      .select('name code enrolledStudents')
      .lean();
    const totalEnrolledStudents = courses.reduce((sum, c) => sum + (c.enrolledStudents?.length || 0), 0);

    res.json({
      professorId,
      totalLectures: lectures.length,
      publishedLectures: publishedLectures.length,
      totalCourses: courseIds.length,
      totalRecordingSeconds,
      totalQuestionsGenerated,
      totalEnrolledStudents,
      totalAttempts: attemptData.totalAttempts,
      uniqueStudentsEngaged: attemptData.uniqueStudents.length,
      averageScore: Math.round(attemptData.averageScore || 0),
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/professors/:id/lectures/:lectureId/analytics
// Per-lecture analytics: avg score, distribution, concept heatmap, per-student rows
// ─────────────────────────────────────────────────────────────────────────────
async function getLectureAnalytics(req, res, next) {
  try {
    const { id: professorId, lectureId } = req.params;

    if (req.user.role !== 'admin' && req.user.id !== professorId) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }

    const lectureObjId = new mongoose.Types.ObjectId(lectureId);

    // Verify lecture belongs to this professor
    const lecture = await Lecture.findById(lectureObjId).select('professorId courseId title').lean();
    if (!lecture) throw createError(404, 'Lecture not found');
    if (lecture.professorId.toString() !== professorId && req.user.role !== 'admin') {
      throw createError(403, 'You do not own this lecture');
    }

    // How many students are enrolled in the lecture's course?
    const course = await Course.findById(lecture.courseId).select('enrolledStudents name code').lean();
    const enrolledCount = course?.enrolledStudents?.length || 0;

    // ── Fetch all attempts for this lecture (with student populated) ──────────
    const attempts = await Attempt.find({ lectureId: lectureObjId })
      .select('studentId answers score conceptBreakdown submittedAt startedAt')
      .populate('studentId', 'name email collegeId')
      .sort({ submittedAt: -1 })
      .lean();

    if (!attempts.length) {
      return res.json({
        lectureId,
        lectureTitle: lecture.title,
        courseName: course?.name,
        courseCode: course?.code,
        enrolledCount,
        participantsCount: 0,
        participationRate: 0,
        averageScore: 0,
        scoreDistribution: { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 },
        conceptHeatmap: [],
        topMissedQuestions: [],
        students: [],
      });
    }

    // ── Score distribution ────────────────────────────────────────────────────
    const distribution = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
    let scoreSum = 0;
    for (const attempt of attempts) {
      const score = attempt.score ?? 0;
      scoreSum += score;
      if (score <= 20) distribution['0-20']++;
      else if (score <= 40) distribution['21-40']++;
      else if (score <= 60) distribution['41-60']++;
      else if (score <= 80) distribution['61-80']++;
      else distribution['81-100']++;
    }
    const averageScore = Math.round(scoreSum / attempts.length);

    // ── Concept heatmap ───────────────────────────────────────────────────────
    const conceptMap = new Map();
    for (const attempt of attempts) {
      for (const cb of attempt.conceptBreakdown || []) {
        const key = cb.conceptId?.toString() || 'unknown';
        if (!conceptMap.has(key)) {
          conceptMap.set(key, { conceptId: cb.conceptId, totalCorrect: 0, totalAttempted: 0, studentCount: 0 });
        }
        const entry = conceptMap.get(key);
        entry.totalCorrect += cb.correct || 0;
        entry.totalAttempted += cb.total || 0;
        entry.studentCount++;
      }
    }

    const conceptHeatmap = Array.from(conceptMap.values())
      .map((c) => ({
        conceptId: c.conceptId,
        totalCorrect: c.totalCorrect,
        totalAttempted: c.totalAttempted,
        studentCount: c.studentCount,
        avgCorrectness: c.totalAttempted > 0 ? Math.round((c.totalCorrect / c.totalAttempted) * 100) : 0,
      }))
      .map((c) => ({
        ...c,
        difficulty: c.avgCorrectness < 50 ? 'hard_for_class' : c.avgCorrectness < 75 ? 'moderate' : 'well_understood',
      }))
      .sort((a, b) => a.avgCorrectness - b.avgCorrectness); // weakest first

    // ── Top missed questions ──────────────────────────────────────────────────
    const questionWrongCount = new Map();
    for (const attempt of attempts) {
      for (const answer of attempt.answers || []) {
        if (!answer.isCorrect) {
          const count = questionWrongCount.get(answer.questionId) || 0;
          questionWrongCount.set(answer.questionId, count + 1);
        }
      }
    }
    const topMissedQuestions = Array.from(questionWrongCount.entries())
      .map(([questionId, wrongCount]) => ({ questionId, wrongCount, wrongRate: Math.round((wrongCount / attempts.length) * 100) }))
      .sort((a, b) => b.wrongCount - a.wrongCount)
      .slice(0, 5);

    // ── Per-student rows ──────────────────────────────────────────────────────
    const students = attempts.map((attempt) => {
      const student = attempt.studentId;
      const timeTakenSeconds = attempt.startedAt && attempt.submittedAt
        ? Math.round((new Date(attempt.submittedAt) - new Date(attempt.startedAt)) / 1000)
        : null;
      const wrongAnswers = (attempt.answers || [])
        .filter((a) => !a.isCorrect)
        .map((a) => a.questionId);

      return {
        studentId: student?._id || attempt.studentId,
        studentName: student?.name || 'Unknown',
        studentEmail: student?.email || '',
        collegeId: student?.collegeId || '',
        score: attempt.score ?? 0,
        timeTakenSeconds,
        submittedAt: attempt.submittedAt,
        wrongQuestionIds: wrongAnswers,
      };
    });

    res.json({
      lectureId,
      lectureTitle: lecture.title,
      courseName: course?.name,
      courseCode: course?.code,
      enrolledCount,
      participantsCount: attempts.length,
      participationRate: enrolledCount > 0 ? Math.round((attempts.length / enrolledCount) * 100) : 0,
      averageScore,
      scoreDistribution: distribution,
      conceptHeatmap,
      topMissedQuestions,
      students, // per-student table: name, score, time, wrong questions
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/professors/:id/feedback
// Send manual feedback from professor to a student
// ─────────────────────────────────────────────────────────────────────────────
async function sendStudentFeedback(req, res, next) {
  try {
    const professorId = req.params.id === 'me' ? req.user.id : req.params.id;

    if (req.user.role !== 'admin' && req.user.id !== professorId) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }

    const Feedback = require('../models/Feedback');
    const { studentId, title, message, type = 'classInsight', conceptName } = req.body;

    if (!studentId || !title || !message) {
      throw createError(400, 'studentId, title, and message are required');
    }

    const feedback = new Feedback({
      professorId,
      studentId,
      title,
      message,
      type,
      conceptName,
    });

    await feedback.save();
    return res.status(201).json(feedback);
  } catch (err) {
    next(err);
  }
}

module.exports = {
  getProfessorOverallAnalytics,
  getLectureAnalytics,
  sendStudentFeedback,
};
