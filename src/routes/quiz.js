import { Router } from 'express';
import { config } from '../config.js';
import { UpstreamError } from '../services/errors.js';
import { generateWithGemini, isGeminiConfigured } from '../services/gemini.js';
import { generateWithGroq } from '../services/groqLlm.js';
import { DIFFICULTIES, sanitizeQuestions } from '../services/mcq.js';

export const quizRouter = Router();

const shouldFallBack = (err) =>
  err instanceof SyntaxError || // bad JSON
  err.name === 'TimeoutError' ||
  [429, 500, 502, 503, 504].includes(err.status);

/** POST /v1/quiz  { transcript, count?, difficulty?, subject? } */
quizRouter.post('/', async (req, res, next) => {
  try {
    const transcript = String(req.body?.transcript || '').trim();
    if (transcript.split(/\s+/).length < 60) {
      return res.status(400).json({ error: 'Transcript too short to build a quiz (need ~60+ words)' });
    }
    if (transcript.length > config.limits.maxTranscriptChars) {
      return res.status(413).json({ error: 'Transcript too long' });
    }
    const count = Math.min(25, Math.max(3, Number(req.body.count) || 10));
    const difficulty = DIFFICULTIES.includes(req.body.difficulty) ? req.body.difficulty : 'medium';
    const subject = String(req.body.subject || '').slice(0, 120);
    const input = { transcript, count, difficulty, subject };

    const started = Date.now();
    let provider = 'gemini';
    let questions = [];
    try {
      if (!isGeminiConfigured()) throw new UpstreamError('gemini not configured', { status: 503 });
      questions = sanitizeQuestions(await generateWithGemini(input));
      if (questions.length === 0) throw new UpstreamError('gemini gave no valid questions', { status: 502 });
    } catch (err) {
      if (!shouldFallBack(err)) throw err;
      console.warn(`[quiz] gemini failed (${err.message}); falling back to groq`);
      provider = 'groq';
      questions = sanitizeQuestions(await generateWithGroq(input));
    }

    questions = questions.slice(0, count);
    if (questions.length === 0) {
      throw new UpstreamError('Model returned no valid questions', { status: 502, provider });
    }
    res.json({ questions, provider, difficulty, ms: Date.now() - started });
  } catch (err) {
    next(err);
  }
});
