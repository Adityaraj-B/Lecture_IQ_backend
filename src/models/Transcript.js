'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const SegmentSchema = new Schema(
  {
    sequence: { type: Number, required: true },
    startTime: { type: Number }, // seconds
    endTime: { type: Number },   // seconds
    text: { type: String, required: true },
    speaker: {
      type: String,
      enum: ['professor', 'student', 'unknown'],
      default: 'unknown',
    },
    language: { type: String },
    sttStatus: {
      type: String,
      enum: ['success', 'failed'],
      default: 'success',
    },
  },
  { _id: false }
);

const TranscriptSchema = new Schema(
  {
    lectureId: { type: Schema.Types.ObjectId, ref: 'Lecture', required: true, unique: true },
    segments: [SegmentSchema],
    fullTextConcatenated: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Transcript', TranscriptSchema);
