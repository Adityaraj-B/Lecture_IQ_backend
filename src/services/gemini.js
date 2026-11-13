import { config } from '../config.js';
import { UpstreamError, readError } from './errors.js';
import { GEMINI_SCHEMA, SYSTEM_PROMPT, userPrompt } from './mcq.js';

export const isGeminiConfigured = () => Boolean(config.gemini.apiKey);

/** One call for the whole lecture: a 45-min transcript fits easily in Gemini's context. */
export async function generateWithGemini({ transcript, count, difficulty, subject }) {
  if (!isGeminiConfigured()) throw new UpstreamError('GEMINI_API_KEY is not configured', { status: 503 });

  const url = `${config.gemini.baseUrl}/models/${encodeURIComponent(config.gemini.model)}:generateContent`;
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
    signal: AbortSignal.timeout(90_000),
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
