import { config } from '../config.js';
import { UpstreamError, readError } from './errors.js';
import { detectLanguage } from './language.js';

// Whisper's prompt window is 224 tokens; ~150 tokens of context ≈ 600 chars.
const PROMPT_TAIL_CHARS = 600;

const NO_SPEECH_MAX = 0.6;
const LOGPROB_MIN = -1;

// Phrases Whisper famously invents over silence.
const KNOWN_HALLUCINATIONS = [
  /^thanks? (you )?for watching[.!]?$/i,
  /^please subscribe[.!]?$/i,
  /^subtitles? by .*$/i,
  /^\[?(music|silence|applause)\]?$/i,
  /^you$/i,
];

export function buildPrompt(subject, previousText) {
  const tail = (previousText || '').slice(-PROMPT_TAIL_CHARS);
  // Start the tail at a word boundary so the prompt doesn't begin mid-word.
  const trimmedTail = tail.length === PROMPT_TAIL_CHARS ? tail.replace(/^\S*\s/, '') : tail;
  const head = subject ? `Lecture on ${subject}.` : '';
  return [head, trimmedTail].filter(Boolean).join(' ').trim();
}

/** Drops likely hallucinated segments and repetition loops. */
export function filterSegments(segments) {
  const kept = [];
  let last = '';
  for (const seg of segments || []) {
    const text = (seg.text || '').trim();
    if (!text) continue;
    if (seg.no_speech_prob > NO_SPEECH_MAX && seg.avg_logprob < LOGPROB_MIN) continue;
    if (KNOWN_HALLUCINATIONS.some((re) => re.test(text))) continue;
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '');
    if (norm && norm === last) continue; // consecutive repeat
    last = norm;
    kept.push({ start: seg.start, end: seg.end, text });
  }
  return kept;
}

/** No `language` is sent, so Whisper auto-detects English, Hindi or Hinglish speech. */
export async function transcribe({ buffer, filename, mimetype, subject, previousText }) {
  if (!config.groq.apiKey) throw new UpstreamError('GROQ_API_KEY is not configured', { status: 503 });

  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/m4a' }), filename || 'chunk.m4a');
  form.append('model', config.groq.sttModel);
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0');
  const prompt = buildPrompt(subject, previousText);
  if (prompt) form.append('prompt', prompt);

  const res = await fetch(`${config.groq.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groq.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw await readError(res, 'groq-stt');

  const data = await res.json();
  const segments = filterSegments(data.segments);
  const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  return {
    text,
    segments,
    language: detectLanguage(text),
    duration: data.duration ?? null,
  };
}
