'use strict';

const Attempt = require('../models/Attempt');
const MCQSet = require('../models/MCQSet');
const Course = require('../models/Course');
const { createError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/attempts
// Submit answers and get auto-graded result instantly
// ─────────────────────────────────────────────────────────────────────────────
async function submitAttempt(req, res, next) {
  try {
    const { mcqSetId, lectureId, answers, startedAt } = req.body;
    const studentId = req.user.id;

    if (!mcqSetId || !lectureId || !Array.isArray(answers)) {
      throw createError(400, 'mcqSetId, lectureId, and answers[] are required');
    }

    const mcqSet = await MCQSet.findById(mcqSetId);
    if (!mcqSet) throw createError(404, 'MCQSet not found');
    if (mcqSet.status !== 'published') throw createError(409, 'Quiz is not published yet');

    // ── Auto-grade answers ────────────────────────────────────────────────────
    const questionMap = new Map(mcqSet.questions.map((q) => [q.questionId, q]));

    const gradedAnswers = answers.map((answer) => {
      const question = questionMap.get(answer.questionId);
      if (!question) return { questionId: answer.questionId, selectedIndex: answer.selectedIndex, isCorrect: false };
      return {
        questionId: answer.questionId,
        selectedIndex: answer.selectedIndex,
        isCorrect: answer.selectedIndex === question.correctIndex,
      };
    });

    const correctCount = gradedAnswers.filter((a) => a.isCorrect).length;
    const score = gradedAnswers.length > 0 ? Math.round((correctCount / gradedAnswers.length) * 100) : 0;

    // ── Concept breakdown ─────────────────────────────────────────────────────
    const conceptMap = new Map();
    for (const answer of gradedAnswers) {
      const question = questionMap.get(answer.questionId);
      if (!question?.conceptId) continue;

      const key = question.conceptId.toString();
      if (!conceptMap.has(key)) {
        conceptMap.set(key, { conceptId: question.conceptId, correct: 0, total: 0 });
      }
      const entry = conceptMap.get(key);
      entry.total++;
      if (answer.isCorrect) entry.correct++;
    }

    const attempt = await Attempt.create({
      studentId,
      mcqSetId,
      lectureId,
      answers: gradedAnswers,
      score,
      conceptBreakdown: Array.from(conceptMap.values()),
      startedAt: startedAt ? new Date(startedAt) : new Date(),
      submittedAt: new Date(),
      syncStatus: 'synced',
    });

    res.status(201).json({
      attemptId: attempt._id,
      score,
      correct: correctCount,
      total: gradedAnswers.length,
      conceptBreakdown: attempt.conceptBreakdown,
      answers: gradedAnswers,
    });
  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/lectures/:id/attempts
// Returns all attempts for a specific lecture (for Professor Dashboard)
// ─────────────────────────────────────────────────────────────────────────────
async function getLectureAttempts(req, res, next) {
  try {
    const { id: lectureId } = req.params;

    // Verify the professor owns the lecture
    const Lecture = require('../models/Lecture');
    const lecture = await Lecture.findById(lectureId);
    if (!lecture) throw createError(404, 'Lecture not found');
    if (lecture.professorId.toString() !== req.user.id && req.user.role !== 'admin') {
      throw createError(403, 'You do not own this lecture');
    }

    const attempts = await Attempt.find({ lectureId });
    res.json(attempts);
  } catch (err) {
    next(err);
  }
}

module.exports = { submitAttempt, getLectureAttempts };
