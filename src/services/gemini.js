import { config } from '../config.js';
import { UpstreamError, readError } from './errors.js';
import { GEMINI_SCHEMA, SYSTEM_PROMPT, userPrompt } from './mcq.js';

export const isGeminiConfigured = () => Boolean(config.gemini.apiKey);

/** Worth trying the next model: retired (404), rate-limited, overloaded or timed out. */
const tryNextModel = (err) => err.name === 'TimeoutError' || [404, 429, 500, 502, 503, 504].includes(err.status);

/**
 * One call for the whole lecture (a 45-min transcript fits easily in Gemini's context),
 * trying each configured model in turn. Google retires and throttles models often, so
 * no single model name is relied on.
 */
export async function generateWithGemini(input) {
  if (!isGeminiConfigured()) throw new UpstreamError('GEMINI_API_KEY is not configured', { status: 503 });
  let lastError;
  for (const model of config.gemini.models) {
    try {
      return await generateWith(model, input);
    } catch (err) {
      if (!tryNextModel(err)) throw err;
      console.warn(`[quiz] ${model} unavailable (${err.message}); trying the next model`);
      lastError = err;
    }
  }
  throw lastError;
}

async function generateWith(model, { transcript, count, difficulty, subject }) {
  const url = `${config.gemini.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt({ transcript, count, difficulty, subject }) }] }],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
      },
    }),
    signal: AbortSignal.timeout(75_000), // per model, so the whole chain fits in the app's 4-minute wait
  });
  if (!res.ok) throw await readError(res, 'gemini');

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'empty';
    throw new UpstreamError(`gemini returned no content (${reason})`, { status: 502, provider: 'gemini' });
  }
  return JSON.parse(text);
}
