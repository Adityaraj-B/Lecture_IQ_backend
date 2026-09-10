'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const ActiveQuizSchema = new Schema(
  {
    mcqSetId: { type: Schema.Types.ObjectId, ref: 'MCQSet' },
    lectureId: { type: Schema.Types.ObjectId, ref: 'Lecture' },
    lectureTitle: { type: String },
    publishedAt: { type: Date },
    questionCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const CourseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    professorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    enrolledStudents: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    section: { type: String, trim: true },
    // Denormalized active quiz — set when professor publishes, cleared when expired
    activeQuiz: { type: ActiveQuizSchema, default: null },
  },
  { timestamps: true }
);

// Fast lookup by professor
CourseSchema.index({ professorId: 1 });
// Fast enroll-by-code lookup
CourseSchema.index({ code: 1, professorId: 1 });

module.exports = mongoose.model('Course', CourseSchema);
