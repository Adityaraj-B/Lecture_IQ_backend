import { config } from '../config.js';
import { UpstreamError, readError } from './errors.js';
import { GEMINI_SCHEMA, SYSTEM_PROMPT, userPrompt } from './mcq.js';

export const isGeminiConfigured = () => Boolean(config.gemini.apiKey);

/** Worth trying the next model: retired (404), rate-limited, overloaded or timed out. */
const tryNextModel = (err) => err.name === 'TimeoutError' || [404, 429, 500, 502, 503, 504].includes(err.status);

/**
 * One JSON-producing Gemini call, trying each configured model in turn. Google retires
 * and throttles models often, so no single model name is relied on.
 */
export async function geminiJson({ system, prompt, schema, temperature = 0.4 }) {
  if (!isGeminiConfigured()) throw new UpstreamError('GEMINI_API_KEY is not configured', { status: 503 });
  let lastError;
  for (const model of config.gemini.models) {
    try {
      return await callModel(model, { system, prompt, schema, temperature });
    } catch (err) {
      if (!tryNextModel(err)) throw err;
      console.warn(`[llm] ${model} unavailable (${err.message}); trying the next model`);
      lastError = err;
    }
  }
  throw lastError;
}

/** Quiz generation: one call for the whole lecture (a 45-min transcript fits Gemini's context). */
export const generateWithGemini = (input) =>
  geminiJson({ system: SYSTEM_PROMPT, prompt: userPrompt(input), schema: GEMINI_SCHEMA });

async function callModel(model, { system, prompt, schema, temperature }) {
  const url = `${config.gemini.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature, responseMimeType: 'application/json', responseSchema: schema },
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
