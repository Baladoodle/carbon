import Anthropic from '@anthropic-ai/sdk';
import type { AiError } from '@core/ai/gateway';

/**
 * Maps SDK errors onto carbon's AI errors, most specific first (the SDK's
 * typed error classes, never message matching). `retryable` says whether the
 * gateway may try again: 429, 5xx (including 529 overloaded) and connection
 * errors back off and retry; 400-class errors never do.
 */
export function classifyError(e: unknown, aborted: boolean): AiError {
  if (aborted || e instanceof Anthropic.APIUserAbortError)
    return { code: 'cancelled', message: 'cancelled', retryable: false };
  if (e instanceof Anthropic.RateLimitError)
    return {
      code: 'rate_limited',
      message: 'Rate limited by the Claude API (429)',
      retryable: true,
    };
  if (e instanceof Anthropic.AuthenticationError)
    return { code: 'no_key', message: 'The API key was rejected (401)', retryable: false };
  if (e instanceof Anthropic.PermissionDeniedError)
    return {
      code: 'no_key',
      message: 'The API key may not use this model (403)',
      retryable: false,
    };
  if (e instanceof Anthropic.BadRequestError)
    return {
      code: 'bad_request',
      message: `The Claude API rejected the request (400): ${short(e)}`,
      retryable: false,
    };
  if (e instanceof Anthropic.NotFoundError)
    return { code: 'bad_request', message: `Not found (404): ${short(e)}`, retryable: false };
  if (e instanceof Anthropic.UnprocessableEntityError)
    return {
      code: 'bad_request',
      message: `Unprocessable request (422): ${short(e)}`,
      retryable: false,
    };
  if (e instanceof Anthropic.InternalServerError)
    return { code: 'server', message: `The Claude API failed (${e.status})`, retryable: true };
  if (e instanceof Anthropic.APIConnectionTimeoutError)
    return { code: 'network', message: 'The Claude API timed out', retryable: true };
  if (e instanceof Anthropic.APIConnectionError)
    return { code: 'network', message: 'Could not reach the Claude API', retryable: true };
  if (e instanceof Anthropic.APIError) {
    const status = typeof e.status === 'number' ? e.status : 0;
    if (status === 413)
      return { code: 'too_large', message: 'The request is too large (413)', retryable: false };
    if (status === 408 || status === 409 || status >= 500)
      return { code: 'server', message: `The Claude API failed (${status})`, retryable: true };
    return {
      code: 'unknown',
      message: `Claude API error ${status}: ${short(e)}`,
      retryable: false,
    };
  }
  return {
    code: 'unknown',
    message: e instanceof Error ? e.message : 'unknown error',
    retryable: false,
  };
}

/** The error's own message, without the request id noise, trimmed for one line. */
function short(e: { error?: unknown; message: string }): string {
  const body = e.error as { error?: { message?: unknown } } | undefined;
  const msg = typeof body?.error?.message === 'string' ? body.error.message : e.message;
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** `retry-after` in milliseconds, when the API sent one. */
export function retryAfterMs(e: unknown): number | undefined {
  if (!(e instanceof Anthropic.APIError)) return undefined;
  const headers = e.headers as unknown as Headers | undefined; // APIError's headers are typed `any`
  const h = headers?.get('retry-after');
  if (!h) return undefined;
  const s = Number(h);
  return Number.isFinite(s) && s >= 0 ? Math.min(s * 1000, 60_000) : undefined;
}

export interface RetryPolicy {
  /** Attempts in total (first try included). */
  attempts: number;
  baseMs: number;
  maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 4, baseMs: 500, maxMs: 8_000 };

/** Exponential backoff with full jitter, or the server's retry-after. */
export function backoffMs(
  policy: RetryPolicy,
  attempt: number,
  random: () => number,
  after?: number,
): number {
  if (after !== undefined) return after;
  const cap = Math.min(policy.maxMs, policy.baseMs * 2 ** attempt);
  return Math.round(cap / 2 + (random() * cap) / 2);
}
