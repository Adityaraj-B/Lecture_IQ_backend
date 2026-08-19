'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const AnswerSchema = new Schema(
  {
    questionId: { type: String, required: true },
    selectedIndex: { type: Number, required: true },
    isCorrect: { type: Boolean, required: true },
  },
  { _id: false }
);

const ConceptBreakdownSchema = new Schema(
  {
    conceptId: { type: Schema.Types.ObjectId, ref: 'Concept' },
    correct: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false }
);

const AttemptSchema = new Schema(
  {
    studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    mcqSetId: { type: Schema.Types.ObjectId, ref: 'MCQSet', required: true },
    lectureId: { type: Schema.Types.ObjectId, ref: 'Lecture', required: true },
    answers: [AnswerSchema],
    score: { type: Number }, // percentage 0-100
    conceptBreakdown: [ConceptBreakdownSchema],
    startedAt: { type: Date },
    submittedAt: { type: Date, default: Date.now },
    syncStatus: {
      type: String,
      enum: ['synced', 'pending_offline_sync'],
      default: 'synced',
    },
  },
  { timestamps: true }
);

// Index for quick per-student and per-lecture lookups
AttemptSchema.index({ studentId: 1, lectureId: 1 });
AttemptSchema.index({ mcqSetId: 1 });

module.exports = mongoose.model('Attempt', AttemptSchema);
