import express from 'express';
import multer from 'multer';
import { describeConfig } from './config.js';
import { authLimiter, quizLimiter, requireAppKey, transcribeLimiter } from './middleware/auth.js';
import { authenticate } from './middleware/session.js';
import { assignmentsRouter } from './routes/assignments.js';
import { authRouter } from './routes/auth.js';
import { analyticsRouter, eventsRouter } from './routes/classroom.js';
import { coursesRouter } from './routes/courses.js';
import { studentsRouter } from './routes/students.js';
import { quizRouter } from './routes/quiz.js';
import { transcribeRouter } from './routes/transcribe.js';
import { EventHub } from './services/events.js';

export function createApp({ db, secret, hub = new EventHub() }) {
  const app = express();
  app.set('trust proxy', 1); // Render sits behind one proxy; needed for per-IP rate limits
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  // Public and cheap: the app pings this when Record is pressed, to wake Render's free tier.
  app.get('/health', (_req, res) => res.json({ ok: true, ...describeConfig(), uptime: Math.round(process.uptime()) }));

  // Opening the bare URL in a browser should confirm the server is up, not look like an error.
  app.get('/', (_req, res) => res.json({ ok: true, service: 'LectureIQ API', health: '/health' }));

  const session = authenticate({ db, secret });

  app.use('/v1', requireAppKey);
  app.use('/v1/transcribe', transcribeLimiter, transcribeRouter);
  app.use('/v1/quiz', quizLimiter, quizRouter);
  app.use('/v1/auth', authLimiter, authRouter({ db, secret, authenticate: session }));
  app.use('/v1/courses', session, coursesRouter({ db, hub }));
  app.use('/v1/assignments', session, assignmentsRouter({ db, hub }));
  app.use('/v1/analytics', session, analyticsRouter({ db }));
  app.use('/v1/students', session, studentsRouter({ db }));
  app.use('/v1/events', session, eventsRouter({ hub }));

  app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err instanceof multer.MulterError) {
      return res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: err.message });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Body too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    const status = err.status >= 400 && err.status < 600 ? err.status : 500;
    if (err.retryAfter != null) res.set('retry-after', String(Math.ceil(err.retryAfter)));
    if (status >= 500) console.error('[error]', err.message);
    res.status(status).json({ error: err.message || 'Internal error', provider: err.provider });
  });

  return app;
}
