'use strict';

const Attempt = require('../models/Attempt');
const MCQSet = require('../models/MCQSet');
const { createError } = require('../middleware/errorHandler');

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/professors/:id/lectures/:lectureId/analytics
// Per-lecture analytics: avg score, distribution, concept heatmap
// ─────────────────────────────────────────────────────────────────────────────
async function getLectureAnalytics(req, res, next) {
  try {
    const { id: professorId, lectureId } = req.params;

    // Auth check — only the owning professor or admin
    if (req.user.role !== 'admin' && req.user.id !== professorId) {
      return res.status(403).json({ error: 'Forbidden — insufficient role' });
    }

    const mongoose = require('mongoose');
    const lectureObjId = new mongoose.Types.ObjectId(lectureId);

    // ── Average score & distribution (MongoDB aggregation) ────────────────────
    const scoreStats = await Attempt.aggregate([
      { $match: { lectureId: lectureObjId } },
      {
        $group: {
          _id: null,
          averageScore: { $avg: '$score' },
          totalStudents: { $sum: 1 },
          scores: { $push: '$score' },
        },
      },
    ]);

    if (!scoreStats.length) {
      return res.json({
        lectureId,
        totalStudents: 0,
        averageScore: 0,
        scoreDistribution: {},
        conceptHeatmap: [],
      });
    }

    const { averageScore, totalStudents, scores } = scoreStats[0];

    // Build score distribution buckets: 0-20, 21-40, 41-60, 61-80, 81-100
    const distribution = { '0-20': 0, '21-40': 0, '41-60': 0, '61-80': 0, '81-100': 0 };
    for (const score of scores) {
      if (score <= 20) distribution['0-20']++;
      else if (score <= 40) distribution['21-40']++;
      else if (score <= 60) distribution['41-60']++;
      else if (score <= 80) distribution['61-80']++;
      else distribution['81-100']++;
    }

    // ── Concept heatmap (avg correctness per concept across class) ────────────
    const conceptHeatmap = await Attempt.aggregate([
      { $match: { lectureId: lectureObjId } },
      { $unwind: '$conceptBreakdown' },
      {
        $group: {
          _id: '$conceptBreakdown.conceptId',
          totalCorrect: { $sum: '$conceptBreakdown.correct' },
          totalAttempted: { $sum: '$conceptBreakdown.total' },
          studentCount: { $sum: 1 },
        },
      },
      {
        $project: {
          conceptId: '$_id',
          totalCorrect: 1,
          totalAttempted: 1,
          studentCount: 1,
          avgCorrectness: {
            $cond: [
              { $gt: ['$totalAttempted', 0] },
              { $multiply: [{ $divide: ['$totalCorrect', '$totalAttempted'] }, 100] },
              0,
            ],
          },
        },
      },
      { $sort: { avgCorrectness: 1 } }, // weakest concepts first
    ]);

    res.json({
      lectureId,
      totalStudents,
      averageScore: Math.round(averageScore),
      scoreDistribution: distribution,
      conceptHeatmap: conceptHeatmap.map((c) => ({
        ...c,
        avgCorrectness: Math.round(c.avgCorrectness),
        difficulty: c.avgCorrectness < 50 ? 'hard_for_class' : c.avgCorrectness < 75 ? 'moderate' : 'well_understood',
      })),
    });
  } catch (err) {
    next(err);
  }
}

module.exports = { getLectureAnalytics };
