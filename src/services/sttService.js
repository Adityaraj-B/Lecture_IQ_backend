'use strict';

/**
 * sttService.js — Speech-to-Text abstraction layer.
 *
 * The STT_PROVIDER env var controls which implementation is used:
 *   'gemini'   → calls Google Gemini Audio Transcription (default)
 *   'mock'     → returns deterministic dummy data (for offline testing only —
 *                never selected automatically for real audio)
 *   'bhashini' → calls Bhashini ULCA API
 *   'google'   → calls Google Cloud Speech-to-Text v1
 *
 * All providers MUST return the same shape:
 * {
 *   text: string,                         // full transcript text
 *   segments: [{
 *     start: number,                      // seconds
 *     end: number,
 *     text: string,
 *     speaker: 'professor' | 'student' | 'unknown',
 *     speakerId: number | null,           // stable index distinguishing
 *                                          // multiple students in the same
 *                                          // lecture (1, 2, 3…). null if the
 *                                          // model couldn't distinguish.
 *     language: string,                   // BCP-47 e.g. 'hi', 'mr', 'en'
 *     confidence: 'high' | 'low',         // 'low' flags speech the model
 *                                          // found hard to make out
 *   }],
 *   language: string,                     // detected primary language
 *   meta: {
 *     provider: string,
 *     model: string | null,
 *     warnings: string[],                 // non-fatal validation concerns —
 *                                          // callers should surface these to
 *                                          // a human before trusting the text
 *   },
 * }
 *
 * IMPORTANT: a failed transcription throws a TranscriptionError. Callers
 * must not treat a caught error as "no speech" — it means the transcript is
 * unknown, not empty. Only an explicit empty `segments: []` with no warnings
 * means "we transcribed this and there was genuinely no speech."
 */

const { getAudioBuffer } = require('../utils/audioStorage');

const provider = (process.env.STT_PROVIDER || 'gemini').toLowerCase();
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;

// Model candidates are configurable via env. Defaults are the current
// (as of Aug 2026) stable Gemini 3 Flash lineup per
// https://ai.google.dev/gemini-api/docs/models, most-capable first, falling
// back to cheaper/lighter variants. Deliberately avoids:
//   - gemini-flash-latest: a hot-swapped alias, more prone to transient
//     overload (this is what threw the 503s in production logs)
//   - gemini-2.5-flash / gemini-2.0-flash: deprecated / restricted for new
//     projects (the 404s in the logs)
// Re-check ai.google.dev/gemini-api/docs/models periodically — Google
// deprecates Gemini models on a matter of months, not years.
const candidateModels = (process.env.STT_GEMINI_MODELS
  ? process.env.STT_GEMINI_MODELS.split(',').map((m) => m.trim())
  : ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']
).filter(Boolean);

const ALLOWED_SPEAKERS = new Set(['professor', 'student', 'unknown']);

class TranscriptionError extends Error {
  constructor(message, { cause, audioUrl } = {}) {
    super(message);
    this.name = 'TranscriptionError';
    this.cause = cause;
    this.audioUrl = audioUrl;
  }
}

// ── WAV duration helper (used only to sanity-check model output) ──────────────
// Parses a standard PCM WAV header. Returns null (not an error) for anything
// it can't confidently parse — duration-based checks are then skipped rather
// than blocking the pipeline on a format we don't understand.
function getWavDurationSeconds(buffer) {
  try {
    if (buffer.length < 44) return null;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (buffer.toString('ascii', 8, 12) !== 'WAVE') return null;

    let offset = 12;
    let byteRate = null;
    let dataSize = null;

    while (offset + 8 <= buffer.length) {
      const chunkId = buffer.toString('ascii', offset, offset + 4);
      const chunkSize = buffer.readUInt32LE(offset + 4);
      const chunkStart = offset + 8;

      if (chunkId === 'fmt ') {
        byteRate = buffer.readUInt32LE(chunkStart + 8);
      } else if (chunkId === 'data') {
        dataSize = chunkSize;
      }

      offset = chunkStart + chunkSize + (chunkSize % 2);
    }

    if (!byteRate || !dataSize) return null;
    return dataSize / byteRate;
  } catch {
    return null;
  }
}

// ── Output validation (the actual anti-hallucination check) ───────────────────
// Model output is *claimed* fact, not verified fact. This checks it against
// what we independently know about the audio (its real duration) and basic
// internal consistency, and downgrades trust rather than pretending the
// output is correct.
function validateTranscript(parsed, { audioDurationSec }) {
  const warnings = [];
  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];

  let previousEnd = 0;
  let totalWords = 0;

  for (const [i, seg] of segments.entries()) {
    if (typeof seg.start !== 'number' || typeof seg.end !== 'number') {
      warnings.push(`segment ${i}: missing/invalid start or end timestamp`);
      continue;
    }
    if (seg.end <= seg.start) {
      warnings.push(`segment ${i}: end (${seg.end}) not after start (${seg.start})`);
    }
    if (seg.start < previousEnd - 0.5) {
      // small overlap tolerance for natural turn-taking / crosstalk
      warnings.push(`segment ${i}: overlaps previous segment (start ${seg.start} < prior end ${previousEnd})`);
    }
    if (audioDurationSec != null && seg.end > audioDurationSec + 1) {
      warnings.push(
        `segment ${i}: end (${seg.end}s) exceeds actual audio duration (${audioDurationSec.toFixed(1)}s) — likely fabricated timestamp`,
      );
    }
    if (!ALLOWED_SPEAKERS.has(seg.speaker)) {
      warnings.push(`segment ${i}: unrecognized speaker value "${seg.speaker}"`);
    }
    if (typeof seg.text !== 'string' || seg.text.trim() === '') {
      warnings.push(`segment ${i}: empty text with no content`);
    }

    totalWords += (seg.text || '').trim().split(/\s+/).filter(Boolean).length;
    previousEnd = Math.max(previousEnd, seg.end || previousEnd);
  }

  if (audioDurationSec != null && audioDurationSec > 2) {
    const wordsPerSecond = totalWords / audioDurationSec;
    // Natural lecture speech is roughly 2-3 words/sec. Well above that is a
    // strong signal the model is padding/inventing content rather than
    // transcribing only what it actually heard.
    if (wordsPerSecond > 4.5) {
      warnings.push(
        `word rate (${wordsPerSecond.toFixed(1)}/s) implausibly high for ${audioDurationSec.toFixed(1)}s of audio — possible hallucinated content`,
      );
    }
  }

  return warnings;
}

// ── Google Gemini Multimodal Audio STT ─────────────────────────────────────────

async function geminiSTT(audioUrl, langConfig) {
  if (!geminiApiKey) {
    throw new TranscriptionError(
      'GEMINI_API_KEY (or LLM_API_KEY) is not set — cannot transcribe. ' +
      'Set STT_PROVIDER=mock explicitly if you intend to use dummy data.',
      { audioUrl },
    );
  }

  const audioBuffer = await getAudioBuffer(audioUrl);
  if (!audioBuffer || audioBuffer.length === 0) {
    throw new TranscriptionError(`No audio data found at ${audioUrl}`, { audioUrl });
  }

  console.log(`[STT:gemini] Fetched audio buffer: ${audioBuffer.length} bytes from ${audioUrl}`);

  const audioDurationSec = getWavDurationSeconds(audioBuffer);
  if (audioDurationSec == null) {
    console.log('[STT:gemini] Could not determine audio duration from header — duration-based validation will be skipped');
  }

  const base64Audio = audioBuffer.toString('base64');
  const primaryLang = langConfig?.primary || 'hi';
  const alternateLangs = (langConfig?.alternates || ['en', 'mr']).join(', ');

  const prompt = `You are a strict, literal audio transcription system for university classroom lectures. Accuracy matters more than completeness — it is far better to mark something as unclear than to guess.

Primary expected language: ${primaryLang}. Supported languages: ${alternateLangs}.

Rules, in order of importance:

1. NEVER invent, complete, paraphrase, or embellish speech. Transcribe only words you can actually make out in the audio. If a word or phrase is unclear, muffled, or drowned out, write "[inaudible]" in its place rather than guessing a plausible-sounding word.
2. If the audio is silent, is entirely background/room noise, or has no discernible speech at any point, return an empty "text" string and an empty "segments" array []. Do not fabricate a plausible-sounding lecture excerpt to fill the gap.
3. Transcribe verbatim, including false starts, filler words ("um", "uh", repeated words), and code-switching between English, Hindi, and Marathi exactly as spoken. Do not clean up or normalize the speaker's grammar.
4. Speaker diarization — this is critical:
   - Every time the speaker changes, start a new segment. Do not merge two different speakers' words into one segment.
   - "speaker" is "professor" (delivering the lecture), "student" (asking/answering), or "unknown" if you genuinely cannot tell.
   - If more than one distinct student voice speaks during the lecture, assign each a stable "speakerId" integer (1, 2, 3...) so the same student's turns can be linked across the transcript. Use the SAME speakerId every time that same voice recurs. The professor's speakerId should always be 0. Use null for speakerId only if you cannot distinguish voices at all.
   - Base speaker identity on voice characteristics and conversational role, not just on guessing from content.
5. Timestamps must be accurate to the actual audio and must never extend past the end of the provided audio clip.
6. For each segment, set "confidence" to "low" if you had to strain to make out the words or you're not fully certain of the transcription, otherwise "high". Do not mark uncertain content as "high" confidence to make the output look cleaner.
7. Output STRICT JSON only, matching this exact schema (no markdown fences, no commentary before or after):
{
  "text": "<full concatenated transcript, in original spoken language(s)>",
  "segments": [
    {
      "start": 0.0,
      "end": 4.5,
      "text": "<spoken words, verbatim>",
      "speaker": "professor" | "student" | "unknown",
      "speakerId": 0,
      "language": "hi" | "mr" | "en",
      "confidence": "high" | "low"
    }
  ],
  "language": "${primaryLang}"
}`;

  let lastError = null;

  for (const model of candidateModels) {
    try {
      console.log(`[STT:gemini] Transcribing audio with model: ${model} (${audioBuffer.length} bytes)...`);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { inlineData: { mimeType: 'audio/wav', data: base64Audio } },
                { text: prompt },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: 'application/json',
            // Deterministic, literal output — we want the most probable
            // transcription, not a creative one. Sampling temperature is a
            // direct knob on hallucination risk for this kind of task.
            temperature: 0,
            candidateCount: 1,
          },
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`[STT:gemini] Model ${model} returned HTTP ${response.status}: ${errText.slice(0, 150)}`);
        if ([503, 429, 404].includes(response.status)) {
          lastError = new Error(`HTTP ${response.status}: ${errText}`);
          continue;
        }
        throw new Error(`Gemini STT API error: ${response.status} ${errText}`);
      }

      const data = await response.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) throw new Error('Empty response from Gemini STT');

      const parsed = JSON.parse(rawText);
      const warnings = validateTranscript(parsed, { audioDurationSec });

      if (warnings.length > 0) {
        console.warn(`[STT:gemini] Model ${model} output failed validation checks:`, warnings);
        lastError = new Error(`Validation failed: ${warnings.join('; ')}`);
        // Try the next candidate model rather than accepting output we have
        // concrete reason to distrust.
        continue;
      }

      return {
        text: parsed.text || '',
        segments: Array.isArray(parsed.segments) ? parsed.segments : [],
        language: parsed.language || primaryLang,
        meta: { provider: 'gemini', model, warnings: [] },
      };
    } catch (err) {
      lastError = err;
      console.warn(`[STT:gemini] Attempt with ${model} failed: ${err.message}`);
    }
  }

  // Every candidate either errored or failed validation. Do NOT return mock
  // data here — that would silently present fabricated placeholder content
  // as this lecture's real transcript. Fail loudly instead.
  throw new TranscriptionError(
    `All Gemini STT candidate models failed for ${audioUrl}`,
    { cause: lastError, audioUrl },
  );
}

// ── Mock implementation (offline testing only) ─────────────────────────────────

function mockSTT(audioUrl, langConfig) {
  console.log(`[STT:mock] Processing ${audioUrl} | lang: ${JSON.stringify(langConfig)}`);

  const baseTime = Math.random() * 60;
  return {
    text: 'In today lecture we explore binary search trees and their traversal algorithms with O(log N) time complexity.',
    segments: [
      {
        start: baseTime,
        end: baseTime + 4.2,
        text: 'In today lecture we explore binary search trees.',
        speaker: 'professor',
        speakerId: 0,
        language: langConfig?.primary || 'en',
        confidence: 'high',
      },
      {
        start: baseTime + 4.5,
        end: baseTime + 12.8,
        text: 'Binary search tree maintains left child smaller and right child larger than the parent.',
        speaker: 'professor',
        speakerId: 0,
        language: langConfig?.primary || 'en',
        confidence: 'high',
      },
      {
        start: baseTime + 13.0,
        end: baseTime + 16.0,
        text: 'Can you clarify the worst case search complexity?',
        speaker: 'student',
        speakerId: 1,
        language: langConfig?.primary || 'en',
        confidence: 'high',
      },
    ],
    language: langConfig?.primary || 'en',
    meta: { provider: 'mock', model: null, warnings: [] },
  };
}

// ── Bhashini implementation ────────────────────────────────────────────────────

async function bhashiniSTT(audioUrl, langConfig) {
  // TODO: replace stub with real Bhashini ULCA API call
  const apiKey = process.env.BHASHINI_API_KEY;
  const userId = process.env.BHASHINI_USER_ID;
  if (!apiKey || !userId) {
    throw new TranscriptionError(
      'BHASHINI_API_KEY and BHASHINI_USER_ID must be set for bhashini provider',
      { audioUrl },
    );
  }

  throw new TranscriptionError('Bhashini STT not yet implemented', { audioUrl });
}

// ── Google Cloud STT implementation ───────────────────────────────────────────

async function googleSTT(audioUrl, langConfig) {
  // TODO: replace stub with real Google Cloud Speech-to-Text call
  const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyFile) {
    throw new TranscriptionError(
      'GOOGLE_APPLICATION_CREDENTIALS must be set for google provider',
      { audioUrl },
    );
  }

  throw new TranscriptionError('Google Cloud STT not yet implemented', { audioUrl });
}

// ── Public interface ──────────────────────────────────────────────────────────

/**
 * callSTT(audioUrl, langConfig) → { text, segments, language, meta }
 * Throws TranscriptionError if transcription could not be produced or
 * failed validation on every attempt. Callers must treat a thrown error as
 * "unknown", never silently substitute empty/mock content for real audio.
 *
 * @param {string} audioUrl  - Cloudinary secure URL (https://res.cloudinary.com/...)
 *                             or legacy local path for backward compatibility
 * @param {{ primary: string, alternates: string[] }} langConfig - language config from Lecture doc
 */
async function callSTT(audioUrl, langConfig) {
  switch (provider) {
    case 'gemini':
      return geminiSTT(audioUrl, langConfig);
    case 'mock':
      return mockSTT(audioUrl, langConfig);
    case 'bhashini':
      return bhashiniSTT(audioUrl, langConfig);
    case 'google':
      return googleSTT(audioUrl, langConfig);
    default:
      return geminiSTT(audioUrl, langConfig);
  }
}

module.exports = { callSTT, TranscriptionError };