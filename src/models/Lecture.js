'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const AudioChunkSchema = new Schema(
  {
    sequence: { type: Number, required: true },
    audioUrl: { type: String, required: true },
    status: {
      type: String,
      enum: ['pending', 'uploaded', 'transcribed', 'failed'],
      default: 'pending',
    },
  },
  { _id: false }
);

const LectureSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    professorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, trim: true },
    recordedAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: [
        'recording',
        'uploading',
        'processing',
        'ready_for_review',
        'published',
        'failed',
      ],
      default: 'recording',
    },
    audioChunks: [AudioChunkSchema],
    durationSeconds: { type: Number },
    language: {
      primary: { type: String, default: 'hi' },
      alternates: [{ type: String }],
    },
    processingError: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Lecture', LectureSchema);
