'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const CourseSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true },
    professorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    enrolledStudents: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    section: { type: String, trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Course', CourseSchema);
