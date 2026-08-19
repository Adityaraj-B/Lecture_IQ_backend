'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Multilingual text sub-schema used for question text and options
const MultilingualTextSchema = new Schema(
  {
    en: { type: String, default: '' },
    hi: { type: String, default: '' },
    mr: { type: String, default: '' },
  },
  { _id: false }
);

const QuestionSchema = new Schema(
  {
    questionId: { type: String, required: true }, // UUID for stable reference
    text: { type: MultilingualTextSchema, required: true },
    options: [MultilingualTextSchema], // exactly 4 elements
    correctIndex: { type: Number, required: true, min: 0, max: 3 },
    conceptId: { type: Schema.Types.ObjectId, ref: 'Concept' },
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      default: 'medium',
    },
    timestampRef: { type: Number }, // seconds into lecture where question is sourced
    sourceSegmentId: { type: Number }, // segment sequence number
    confidenceScore: { type: Number, min: 0, max: 1 },
    professorEdited: { type: Boolean, default: false },
  },
  { _id: false }
);

const MCQSetSchema = new Schema(
  {
    lectureId: { type: Schema.Types.ObjectId, ref: 'Lecture', required: true, unique: true },
    status: {
      type: String,
      enum: ['draft', 'published'],
      default: 'draft',
    },
    questions: [QuestionSchema],
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    publishedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MCQSet', MCQSetSchema);
