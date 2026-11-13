import { randomInt } from 'node:crypto';

export const DIFFICULTIES = ['easy', 'medium', 'hard'];

const DIFFICULTY_HINT = {
  easy: 'Mostly direct recall of definitions and key facts. Distractors clearly wrong to someone who listened.',
  medium: 'Balanced: about 40% recall, 40% understanding, 20% application. Distractors plausible.',
  hard: 'Mostly understanding and application: compare, predict, apply to a new example. Distractors are common misconceptions.',
};

/** Shared by every generator: lectures may be Hindi or Hinglish, but everything students see is English. */
export const ENGLISH_ONLY = `- The lecture may be in English, Hindi (Devanagari) or Hinglish (Hindi and English mixed, often in Roman script).
- ALWAYS write your output in clear English, whatever the lecture language. Translate Hindi or Hinglish content faithfully; keep technical terms in their standard English form.`;

export const SYSTEM_PROMPT = `You write multiple-choice quiz questions from a university lecture transcript.
Rules:
- Use ONLY facts, definitions, examples and claims actually stated in the lecture. Never add outside knowledge.
- Ignore administrative chatter: attendance, announcements, deadlines, jokes, audio glitches.
- The transcript is machine-generated and may contain recognition errors; infer the intended technical term.
- Spread questions across the whole lecture (beginning, middle, end), not just one topic.
- Mix recall, understanding and application questions.
- Exactly 4 options per question, one correct. Distractors must be plausible, similar in length and style to the answer.
- Never use "All of the above", "None of the above", "Both A and B" or similar.
- Each explanation (1-2 sentences) refers back to what the lecturer said, e.g. "The lecturer explained that...".
- "topic" is a 1-4 word label for the concept tested.
${ENGLISH_ONLY}`;

export function userPrompt({ transcript, count, difficulty, subject, part }) {
  return [
    subject ? `Subject: ${subject}` : null,
    `Difficulty: ${difficulty}. ${DIFFICULTY_HINT[difficulty]}`,
    part ? `This is part ${part.index} of ${part.total} of the lecture.` : null,
    `Write exactly ${count} questions.`,
    'Respond with JSON: {"questions":[{"question":"...","options":["...","...","...","..."],"answerIndex":0,"explanation":"...","topic":"..."}]}',
    '',
    'TRANSCRIPT:',
    '"""',
    transcript,
    '"""',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Gemini responseSchema (OpenAPI subset). */
export const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    questions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          question: { type: 'STRING' },
          options: { type: 'ARRAY', items: { type: 'STRING' }, minItems: 4, maxItems: 4 },
          answerIndex: { type: 'INTEGER' },
          explanation: { type: 'STRING' },
          topic: { type: 'STRING' },
        },
        required: ['question', 'options', 'answerIndex', 'explanation', 'topic'],
        propertyOrdering: ['question', 'options', 'answerIndex', 'explanation', 'topic'],
      },
    },
  },
  required: ['questions'],
};

const BANNED_OPTION = /\b(all|none|both|neither) of (the )?(above|these|them)\b|^both [a-d] and [a-d]$/i;

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Validates and dedupes questions; shuffles options unless `shuffle` is false
 * (publishing keeps the order the professor reviewed). Returns only well-formed questions.
 */
export function sanitizeQuestions(raw, { shuffle: reorder = true } = {}) {
  const list = Array.isArray(raw?.questions) ? raw.questions : Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const out = [];

  for (const q of list) {
    if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) continue;
    const question = q.question.trim();
    const options = q.options.map((o) => String(o ?? '').trim().replace(/^[A-Da-d][.)]\s+/, ''));
    const answerIndex = Number(q.answerIndex);

    if (!question || options.length !== 4) continue;
    if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex > 3) continue;
    if (options.some((o) => !o || BANNED_OPTION.test(o))) continue;
    if (new Set(options.map(norm)).size !== 4) continue;

    const key = norm(question);
    if (seen.has(key)) continue;
    seen.add(key);

    const correct = options[answerIndex];
    const shuffled = reorder ? shuffle(options) : options;
    out.push({
      question,
      options: shuffled,
      answerIndex: shuffled.indexOf(correct),
      explanation: String(q.explanation ?? '').trim(),
      topic: String(q.topic ?? '').trim() || 'General',
    });
  }
  return out;
}

/** Splits text into ~maxChars chunks on sentence boundaries. */
export function chunkTranscript(text, maxChars = 9000) {
  const sentences = text.match(/[^.!?\n]+[.!?\n]*\s*/g) || [text];
  const chunks = [];
  let cur = '';
  for (const s of sentences) {
    if (cur.length + s.length > maxChars && cur) {
      chunks.push(cur.trim());
      cur = '';
    }
    // Hard-split pathological sentences (Whisper output without punctuation).
    if (s.length > maxChars) {
      for (let i = 0; i < s.length; i += maxChars) chunks.push(s.slice(i, i + maxChars).trim());
      continue;
    }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

/** Distributes `count` questions across parts proportional to their length (min 1 each). */
export function distribute(count, lengths) {
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  const alloc = lengths.map((l) => Math.max(1, Math.floor((count * l) / total)));
  let diff = count - alloc.reduce((a, b) => a + b, 0);
  for (let i = 0; diff !== 0 && i < 1000; i++) {
    const idx = i % alloc.length;
    if (diff > 0) {
      alloc[idx]++;
      diff--;
    } else if (alloc[idx] > 1) {
      alloc[idx]--;
      diff++;
    }
  }
  return alloc;
}
