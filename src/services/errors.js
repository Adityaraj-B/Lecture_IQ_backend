/** Error carrying an HTTP status (and optional retry-after seconds) up to the client. */
export class UpstreamError extends Error {
  constructor(message, { status = 502, retryAfter, provider } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.provider = provider;
  }
}

/**
 * What the user sees for a failure that isn't their fault (server or AI provider trouble).
 * The technical detail (provider name, raw upstream message) is logged, never shown.
 */
export function publicMessage(err, status) {
  if (status === 429) return 'The AI service is busy right now. Please try again in a minute.';
  if (status === 503) return "This feature isn't set up on the server yet. Please contact your administrator.";
  if (status === 504) return 'The AI service took too long to respond. Please try again.';
  if (err.provider === 'groq-stt' && status < 500) return "This part of the recording couldn't be transcribed.";
  if (err.provider && status < 500) return "The AI service couldn't process this request.";
  if (err.provider || status === 502) return 'The AI service had a problem. Please try again.';
  return 'Something went wrong on the server. Please try again.';
}

export function parseRetryAfter(res) {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

export async function readError(res, provider) {
  let detail = '';
  try {
    const body = await res.json();
    detail = body?.error?.message || JSON.stringify(body).slice(0, 300);
  } catch {
    detail = res.statusText;
  }
  return new UpstreamError(`${provider} ${res.status}: ${detail}`, {
    status: res.status === 429 ? 429 : res.status >= 500 ? 502 : res.status,
    retryAfter: parseRetryAfter(res),
    provider,
  });
}
