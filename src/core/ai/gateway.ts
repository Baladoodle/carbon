import { z } from 'zod';
import {
  MomentSchema,
  type Moment,
  type MomentPartial,
  type MomentRequest,
  type MomentResult,
} from './moments';

/** Token usage of one call (Anthropic's four counters). */
export const UsageSchema = z.object({
  input: z.number().int().min(0),
  output: z.number().int().min(0),
  cacheRead: z.number().int().min(0),
  cacheWrite: z.number().int().min(0),
});
export type Usage = z.infer<typeof UsageSchema>;
export const ZERO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** What happened on a call, for the AI log and the cost meter. */
export const AiCallMetaSchema = z.object({
  moment: MomentSchema,
  /** Hash of the canonical request plus the moment: the content cache key. */
  requestHash: z.string(),
  model: z.string(),
  usage: UsageSchema,
  costUsd: z.number().min(0),
  latencyMs: z.number().min(0),
  /** Served from the content-hash cache (no API call, no cost). */
  cached: z.boolean(),
  /** Items in the output that failed validation and were dropped. */
  dropped: z.number().int().min(0),
});
export type AiCallMeta = z.infer<typeof AiCallMetaSchema>;

export const AI_ERROR_CODES = [
  'disabled', // AI off for the session (ctrl+shift+a) or not configured
  'no_key', // no API key
  'budget', // the spend budget is reached; paused until raised
  'cancelled', // a newer request or the user cancelled it
  'rate_limited', // 429 after retries
  'server', // 5xx after retries
  'network', // network failure after retries
  'bad_request', // 400: not retried
  'too_large', // the packed request would exceed the hard token limit
  'invalid_output', // the output failed validation entirely
  'not_found', // the request references an entity that doesn't exist
  'unknown',
] as const;
export const AiErrorSchema = z.object({
  code: z.enum(AI_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
});
export type AiError = z.infer<typeof AiErrorSchema>;

export type AiOutcome<M extends Moment> =
  | { ok: true; result: MomentResult<M>; meta: AiCallMeta }
  | { ok: false; error: AiError; meta?: AiCallMeta };

export const AiStatusSchema = z.object({
  /** `real`: the Claude API; `fake`: FakeAiGateway; `off`: no AI. */
  mode: z.enum(['real', 'fake', 'off']),
  enabled: z.boolean(),
  /** Why it's disabled or paused, for the surfaces to say so. */
  reason: z.string().optional(),
  model: z.string(),
  spend: z.object({ sessionUsd: z.number(), monthUsd: z.number() }),
  budget: z.object({ sessionUsd: z.number(), monthUsd: z.number() }),
  paused: z.boolean(),
  /** Requests in flight. */
  pending: z.number().int().min(0),
});
export type AiStatus = z.infer<typeof AiStatusSchema>;

/** One line of the AI log (`ai-log/<date>.jsonl`, and the ctrl+l overlay). */
export const AiLogEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  moment: MomentSchema,
  /** The entity in focus, if any. */
  entity: z.string().optional(),
  outcome: z.enum(['ok', 'error', 'cancelled', 'cached']),
  error: AiErrorSchema.optional(),
  meta: AiCallMetaSchema.optional(),
  /** Number of results shown (candidates, notes, suggestions). */
  results: z.number().int().min(0).optional(),
});
export type AiLogEntry = z.infer<typeof AiLogEntrySchema>;

export interface AiRunOptions<M extends Moment> {
  /** Cancels the call; the outcome is then `{ ok: false, error: { code: 'cancelled' } }`. */
  signal?: AbortSignal;
  /** Streamed pieces as they arrive (spread candidates). Each is already validated. */
  onPartial?: (partial: MomentPartial<M>) => void;
}

/**
 * The single entry point for AI in carbon (docs/SYSTEM.md §8). Implementations:
 *  - `FakeAiGateway` (src/core/ai/fake.ts): deterministic, offline, for tests and UI work
 *  - the real gateway (src/main/ai, package W4): Claude API, cache, log, budget
 *  - the renderer's IPC client (src/renderer/ai/client.ts): forwards to the main process
 *
 * `run` never throws for expected failures: it resolves to an outcome.
 */
export interface AiGateway {
  run<M extends Moment>(
    moment: M,
    request: MomentRequest<M>,
    options?: AiRunOptions<M>,
  ): Promise<AiOutcome<M>>;
  /** The latest status (cheap, synchronous). */
  status(): AiStatus;
  /** Calls `listener` whenever the status changes; returns an unsubscribe function. */
  onStatus(listener: (status: AiStatus) => void): () => void;
  /** The off switch (ctrl+shift+a): disables or re-enables AI for the session. */
  setEnabled(enabled: boolean): void;
  /** Most recent log entries, newest last. */
  log(limit?: number): Promise<AiLogEntry[]>;
}

/** An outcome for a cancelled call. */
export const cancelled = (): { ok: false; error: AiError } => ({
  ok: false,
  error: { code: 'cancelled', message: 'cancelled', retryable: false },
});
