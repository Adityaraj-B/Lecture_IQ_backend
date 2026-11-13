import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../config.js';
import { UpstreamError, readError } from './errors.js';
import { SYSTEM_PROMPT, chunkTranscript, distribute, userPrompt } from './mcq.js';

const MAX_WAIT_S = 65;
const MAX_ATTEMPTS = 4;

async function callGroq(messages) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${config.groq.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${config.groq.apiKey}` },
      body: JSON.stringify({
        model: config.groq.llmModel,
        messages,
        temperature: 0.4,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(90_000),
    });
    if (res.ok) {
      const data = await res.json();
      return JSON.parse(data?.choices?.[0]?.message?.content || '{}');
    }
    const err = await readError(res, 'groq-llm');
    // Free tier is ~8K tokens/min: wait out the window instead of failing.
    const wait = err.retryAfter ?? 20;
    if (res.status === 429 && attempt < MAX_ATTEMPTS && wait <= MAX_WAIT_S) {
      await sleep((wait + 1) * 1000);
      continue;
    }
    throw err;
  }
}

/** Fallback path: the transcript is too big for Groq's TPM, so split it into ~9K-char parts. */
export async function generateWithGroq({ transcript, count, difficulty, subject }) {
  if (!config.groq.apiKey) throw new UpstreamError('GROQ_API_KEY is not configured', { status: 503 });

  const parts = chunkTranscript(transcript, 9000);
  // One spare question per part so validation drops don't leave us short.
  const alloc = distribute(count, parts.map((p) => p.length)).map((n) => n + 1);
  const questions = [];

  for (let i = 0; i < parts.length; i++) {
    const json = await callGroq([
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: userPrompt({
          transcript: parts[i],
          count: alloc[i],
          difficulty,
          subject,
          part: parts.length > 1 ? { index: i + 1, total: parts.length } : null,
        }),
      },
    ]);
    if (Array.isArray(json?.questions)) questions.push(...json.questions);
  }
  return { questions };
}
