/** Error carrying an HTTP status (and optional retry-after seconds) up to the client. */
export class UpstreamError extends Error {
  constructor(message, { status = 502, retryAfter, provider } = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.provider = provider;
  }
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
