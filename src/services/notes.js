import { condense, generateJson, passagesOf, relevantPassages } from './llm.js';
import { ENGLISH_ONLY } from './mcq.js';

const str = (v, max) => String(v ?? '').trim().slice(0, max);

const NOTES_SYSTEM = `You write concise study notes for students from a university lecture transcript.
Rules:
- Use only what the lecturer said. Never add outside facts.
- Ignore administrative chatter, jokes and audio glitches.
- The transcript is machine-generated; infer the intended technical terms.
- "summary": 4-6 sentences covering the whole lecture.
- "keyPoints": 6-10 short, self-contained takeaways a student should remember.
- "topics": 3-8 labels of 1-4 words for the concepts covered.
- "flashcards": 8-15 cards; "front" is a short question or term, "back" a 1-2 sentence answer from the lecture.
${ENGLISH_ONLY}`;

const NOTES_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    keyPoints: { type: 'ARRAY', items: { type: 'STRING' } },
    topics: { type: 'ARRAY', items: { type: 'STRING' } },
    flashcards: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { front: { type: 'STRING' }, back: { type: 'STRING' } },
        required: ['front', 'back'],
      },
    },
  },
  required: ['summary', 'keyPoints', 'topics', 'flashcards'],
};

/** One AI call per shared lecture: summary, key points, topics and flashcards, all in English. */
export async function buildNotes({ transcript, subject }) {
  const { json, provider } = await generateJson({
    label: 'notes',
    system: NOTES_SYSTEM,
    schema: NOTES_SCHEMA,
    prompt: (budget) =>
      [
        subject ? `Subject: ${subject}` : null,
        'Respond with JSON: {"summary":"...","keyPoints":["..."],"topics":["..."],"flashcards":[{"front":"...","back":"..."}]}',
        'TRANSCRIPT:',
        '"""',
        condense(transcript, budget),
        '"""',
      ]
        .filter(Boolean)
        .join('\n'),
  });
  const list = (v, max, n) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);
  const notes = {
    summary: str(json?.summary, 2000),
    keyPoints: list(json?.keyPoints, 300, 12),
    topics: list(json?.topics, 60, 10),
    flashcards: (Array.isArray(json?.flashcards) ? json.flashcards : [])
      .map((c) => ({ front: str(c?.front, 200), back: str(c?.back, 500) }))
      .filter((c) => c.front && c.back)
      .slice(0, 20),
  };
  if (!notes.summary || notes.keyPoints.length === 0) throw Object.assign(new Error('The AI returned empty notes'), { status: 502 });
  return { ...notes, provider };
}

const ASK_SYSTEM = `You answer a student's question about one university lecture, using ONLY the lecture excerpts provided.
Rules:
- If the excerpts don't cover the question, say the lecture didn't cover it. Never use outside knowledge.
- 2-5 sentences, plain and direct.
- "used" lists the numbers of the excerpts you relied on.
${ENGLISH_ONLY}`;

const ASK_SCHEMA = {
  type: 'OBJECT',
  properties: { answer: { type: 'STRING' }, used: { type: 'ARRAY', items: { type: 'INTEGER' } } },
  required: ['answer', 'used'],
};

/** Answers from the 4 most relevant passages only: small prompts, inside free-tier token limits. */
export async function askLecture({ sections, question, subject }) {
  const picked = relevantPassages(passagesOf(sections), question, 4);
  const { json, provider } = await generateJson({
    label: 'ask',
    system: ASK_SYSTEM,
    schema: ASK_SCHEMA,
    temperature: 0.2,
    prompt: () =>
      [
        subject ? `Lecture subject: ${subject}` : null,
        ...picked.map((p, i) => `Excerpt ${i + 1}:\n"""${p.text}"""`),
        `Question: ${question}`,
        'Respond with JSON: {"answer":"...","used":[1]}',
      ]
        .filter(Boolean)
        .join('\n\n'),
  });
  const used = (Array.isArray(json?.used) ? json.used : []).map(Number).filter((n) => n >= 1 && n <= picked.length);
  return {
    answer: str(json?.answer, 2000) || "Sorry, I couldn't find that in this lecture.",
    // Where in the recording the answer came from (approximate: the 5-minute chunk it was in).
    moments: [...new Set(used)].map((n) => picked[n - 1].startMs),
    provider,
  };
}
