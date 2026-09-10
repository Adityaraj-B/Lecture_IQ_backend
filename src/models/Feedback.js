'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const FeedbackSchema = new Schema(
  {
    professorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    courseId: { type: Schema.Types.ObjectId, ref: 'Course' }, // Optional context
    type: {
      type: String,
      enum: ['classInsight', 'conceptDiagnostic', 'doubtResolution', 'general'],
      default: 'general',
    },
    title: { type: String, required: true },
    message: { type: String, required: true },
    conceptName: { type: String }, // Optional, if feedback is about a specific concept
    isResolved: { type: Boolean, default: false }, // For doubt resolutions
  },
  { timestamps: true }
);

// Lookups for student dashboard
FeedbackSchema.index({ studentId: 1, createdAt: -1 });
// Lookups for professor to see their sent feedback
FeedbackSchema.index({ professorId: 1, createdAt: -1 });

module.exports = mongoose.model('Feedback', FeedbackSchema);
