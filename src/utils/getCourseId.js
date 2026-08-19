#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Course = require('./src/models/Course');

mongoose.connect(process.env.MONGO_URI).then(async () => {
  const c = await Course.findOne({});
  if (c) process.stdout.write(c._id.toString());
  await mongoose.disconnect();
}).catch(err => { console.error(err.message); process.exit(1); });
