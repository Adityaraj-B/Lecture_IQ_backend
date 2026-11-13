import { Router } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { transcribe } from '../services/groqStt.js';

const upload = multer({
  storage: multer.memoryStorage(), // never touches disk
  limits: { fileSize: config.limits.maxUploadBytes, files: 1 },
});

export const transcribeRouter = Router();

/**
 * POST /v1/transcribe  (multipart/form-data)
 *   file          audio chunk (.m4a)
 *   subject?      lecture subject, primes Whisper vocabulary
 *   previousText? tail of the previous chunk's transcript (continuity)
 *   language?     ISO-639-1; omit for auto-detect (handles Hinglish)
 */
transcribeRouter.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Missing audio "file"' });
    const started = Date.now();
    const result = await transcribe({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      subject: String(req.body.subject || '').slice(0, 120),
      previousText: String(req.body.previousText || '').slice(-2000),
      language: String(req.body.language || '').slice(0, 5) || undefined,
    });
    res.json({ ...result, provider: 'groq', ms: Date.now() - started });
  } catch (err) {
    next(err);
  }
});
