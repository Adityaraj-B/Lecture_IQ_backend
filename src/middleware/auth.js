import { timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Keeps casual traffic off the free quota. Replace with Firebase Auth after the pitch. */
export function requireAppKey(req, res, next) {
  if (!config.appKey) return next();
  const key = req.get('x-app-key') || '';
  if (!safeEqual(key, config.appKey)) {
    return res.status(401).json({ error: 'Invalid or missing x-app-key' });
  }
  next();
}

// A 45-min lecture = 9 transcribe calls; leave headroom for retries.
export const transcribeLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many uploads, slow down' },
});

// Slows password guessing; a class signing up at once stays well under it.
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts, wait a minute' },
});

export const quizLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many quiz requests, slow down' },
});
