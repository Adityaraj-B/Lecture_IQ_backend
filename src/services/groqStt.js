import { config } from '../config.js';
import { UpstreamError, readError } from './errors.js';
import { detectLanguage } from './language.js';

// Groq rejects prompts over 896 UTF-8 bytes. Hindi script is 3 bytes per character, so the
// budget is counted in bytes, with headroom. 600 bytes of English is ~150 tokens of context.
const PROMPT_MAX_BYTES = 800;
const PROMPT_TAIL_BYTES = 600;

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

const utf8Bytes = (s) => Buffer.byteLength(s, 'utf8');

/** The end of [text] that fits in [maxBytes], starting at a word boundary when cut. */
function tailWithin(text, maxBytes) {
  const chars = [...text]; // code points, so multi-byte characters are never split
  let bytes = 0;
  let start = chars.length;
  while (start > 0 && bytes + utf8Bytes(chars[start - 1]) <= maxBytes) bytes += utf8Bytes(chars[--start]);
  const tail = chars.slice(start).join('');
  return start > 0 ? tail.replace(/^\S*\s/, '') : tail;
}

export function buildPrompt(subject, previousText) {
  const head = subject ? tailWithin(`Lecture on ${subject}.`, PROMPT_MAX_BYTES - PROMPT_TAIL_BYTES) : '';
  const tail = tailWithin((previousText || '').trim(), Math.min(PROMPT_TAIL_BYTES, PROMPT_MAX_BYTES - utf8Bytes(head) - 1));
  return [head, tail].filter(Boolean).join(' ').trim();
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
