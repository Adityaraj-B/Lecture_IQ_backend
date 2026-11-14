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

const common = { windowMs: 60_000, standardHeaders: 'draft-7', legacyHeaders: false };

/**
 * Signed-in limits are counted per account, not per IP address: a whole class on campus
 * Wi-Fi shares one IP, and must not use up each other's allowance.
 */
const perUser = (req) => (req.user ? `user:${req.user.id}` : `ip:${req.ip}`);

// A 45-min lecture = 9 transcribe calls; leave headroom for retries.
export const transcribeLimiter = rateLimit({
  ...common,
  limit: 20,
  keyGenerator: perUser,
  message: { error: 'Too many uploads, slow down' },
});

export const quizLimiter = rateLimit({
  ...common,
  limit: 5,
  keyGenerator: perUser,
  message: { error: 'Too many quiz requests, slow down' },
});

/** Sign-in routes are used before there is an account, so this one is per IP, and generous enough for a class signing up together. */
export const authIpLimiter = rateLimit({
  ...common,
  limit: 300,
  message: { error: 'Too many sign-in attempts from this network, wait a minute' },
});

/** Slows password guessing against any one account. */
export const authAccountLimiter = rateLimit({
  ...common,
  limit: 20,
  keyGenerator: (req) => `email:${String(req.body?.email ?? '').trim().toLowerCase()}`,
  message: { error: 'Too many sign-in attempts, wait a minute' },
});
