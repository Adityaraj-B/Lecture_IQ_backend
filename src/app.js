'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const { errorHandler } = require('./middleware/errorHandler');

const app = express();

// ── Security & parsing middleware ────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── API Routes (mounted after Step 2+) ───────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/courses',    require('./routes/courses'));
app.use('/api/lectures',   require('./routes/lectures'));
app.use('/api/attempts',   require('./routes/attempts'));
app.use('/api/students',   require('./routes/students'));
app.use('/api/professors', require('./routes/professors'));

// ── 404 catch-all ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler (must be last) ───────────────────────────────────────
app.use(errorHandler);

module.exports = app;
