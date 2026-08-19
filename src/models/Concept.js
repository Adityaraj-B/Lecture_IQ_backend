'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const ConceptSchema = new Schema(
  {
    courseId: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    name: { type: String, required: true, trim: true },
    firstTaughtInLectureId: { type: Schema.Types.ObjectId, ref: 'Lecture' },
    relatedLectureIds: [{ type: Schema.Types.ObjectId, ref: 'Lecture' }],
  },
  { timestamps: true }
);

module.exports = mongoose.model('Concept', ConceptSchema);
