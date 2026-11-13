import { config } from '../config.js';
import { UpstreamError } from './errors.js';
import { geminiJson, isGeminiConfigured } from './gemini.js';
import { callGroq } from './groqLlm.js';

/**
 * Groq's free tier allows ~8K tokens/minute, so the fallback prompt is capped at roughly
 * 4K tokens of source text (~16K chars) plus instructions and the answer.
 */
export const GROQ_TEXT_BUDGET = 16_000;

const fallsBack = (err) =>
  err instanceof SyntaxError || err.name === 'TimeoutError' || [404, 408, 429, 500, 502, 503, 504].includes(err.status);

/**
 * JSON from the LLM: Gemini (model chain) first, Groq as the fallback.
 * `prompt(budget)` builds the user prompt; it gets a smaller source-text budget for Groq.
 */
export async function generateJson({ system, prompt, schema, temperature = 0.4, label = 'llm' }) {
  if (isGeminiConfigured()) {
    try {
      return { json: await geminiJson({ system, prompt: prompt(Infinity), schema, temperature }), provider: 'gemini' };
    } catch (err) {
      if (!fallsBack(err)) throw err;
      console.warn(`[${label}] gemini failed (${err.message}); falling back to groq`);
    }
  }
  if (!config.groq.apiKey) throw new UpstreamError('No AI provider is configured', { status: 503 });
  const json = await callGroq([
    { role: 'system', content: `${system}\nRespond with JSON only.` },
    { role: 'user', content: prompt(GROQ_TEXT_BUDGET) },
  ]);
  return { json, provider: 'groq' };
}

/**
 * Shortens text to about `maxChars` by keeping evenly spaced slices, so the beginning,
 * middle and end of a lecture are all represented.
 */
export function condense(text, maxChars) {
  if (text.length <= maxChars) return text;
  const slices = 8;
  const size = Math.floor(maxChars / slices);
  const step = (text.length - size) / (slices - 1);
  return Array.from({ length: slices }, (_, i) => text.slice(Math.round(i * step), Math.round(i * step) + size).trim()).join('\n[…]\n');
}

const STOP = new Set(
  'the a an and or of to in on for is are was were be by with as at it this that from what which how why when who does do did can could would should about into than then there their they you your we our not no yes if'.split(' '),
);
const words = (s) => String(s).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu)?.filter((w) => !STOP.has(w)) ?? [];

/**
 * Picks the passages most relevant to `query` by word overlap: cheap retrieval that keeps
 * prompts small (and inside free-tier token limits) without an embeddings service.
 * `passages` are { text, ... }; returns the best `k` in their original order.
 */
export function relevantPassages(passages, query, k = 4) {
  const q = new Set(words(query));
  if (q.size === 0) return passages.slice(0, k);
  return passages
    .map((p, i) => {
      const w = words(p.text);
      const hits = w.filter((x) => q.has(x)).length;
      return { p, i, score: hits / Math.sqrt(w.length + 1) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.p);
}

/** Splits lecture sections into ~1.2K-char passages that remember roughly when they were said. */
export function passagesOf(sections, size = 1200) {
  const out = [];
  for (const s of sections) {
    const sentences = s.text.match(/[^.!?।]+[.!?।]*\s*/g) ?? [s.text];
    let buf = '';
    for (const sentence of sentences) {
      if (buf.length + sentence.length > size && buf) {
        out.push({ text: buf.trim(), startMs: s.startMs });
        buf = '';
      }
      buf += sentence;
    }
    if (buf.trim()) out.push({ text: buf.trim(), startMs: s.startMs });
  }
  return out;
}
