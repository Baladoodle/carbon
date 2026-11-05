import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import {
  AI_ERROR_CODES,
  cancelled,
  ZERO_USAGE,
  type AiCallMeta,
  type AiError,
  type AiGateway,
  type AiLogEntry,
  type AiOutcome,
  type AiRunOptions,
  type AiStatus,
  type Usage,
} from '@core/ai/gateway';
import {
  MOMENT_SCHEMAS,
  type Moment,
  type MomentRequest,
  type MomentResult,
} from '@core/ai/moments';
import { HARD_LIMIT } from '@core/context/packer';
import { promptText } from '@core/prompts/common';
import { JsonArrayStreamer } from '@core/prompts/stream';
import { createPromptRegistry, type PromptRegistry } from '@core/prompts/registry';
import type { BuildOptions, BuiltPrompt, ParsedRequest, PromptBuilder } from '@core/prompts/types';
import type { World } from '@core/model/world';
import type { CoreError } from '@core/util/result';
import { ResultCache } from './cache';
import { backoffMs, classifyError, DEFAULT_RETRY, retryAfterMs, type RetryPolicy } from './errors';
import { AiLogStore, type SentRequest } from './log';
import { cacheKey, toCountParams, toMessageParams, type MessageParams } from './request';
import {
  aiSettings,
  costNanos,
  effortFor,
  MODEL,
  nanosToUsd,
  priceFor,
  usdToNanos,
} from './settings';
import { holdsSecret } from './secrets';

/**
 * The real `AiGateway` (docs/SYSTEM.md §8): every AI request in carbon goes
 * through `run`, in these steps:
 *
 *   validate → off switch → budget → build (packer) → token limit
 *   → content-hash cache → one request per entity → call (typed retries,
 *   streaming for spreads) → stop_reason → validate output → log + spend
 *
 * `run` never throws for expected failures: it resolves to an outcome.
 */

/** No request may exceed this many input tokens (docs/PRODUCT.md §4.6). */
export const REQUEST_LIMIT = 100_000;
/** Above this local estimate, the gateway asks `count_tokens` for the exact figure. */
export const COUNT_THRESHOLD = 80_000;

export interface ClaudeGatewayOptions {
  getWorld: () => World;
  client: Anthropic;
  registry?: PromptRegistry;
  log?: AiLogStore;
  model?: string;
  now?: () => Date;
  /** Abortable sleep, for backoff (tests pass an instant one). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  retry?: RetryPolicy;
  countThreshold?: number;
  cacheSize?: number;
}

interface Cached {
  result: unknown;
  meta: AiCallMeta;
  results: number;
}

const realSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

const usageOf = (m: Anthropic.Message): Usage => ({
  input: m.usage.input_tokens,
  output: m.usage.output_tokens,
  cacheRead: m.usage.cache_read_input_tokens ?? 0,
  cacheWrite: m.usage.cache_creation_input_tokens ?? 0,
});

const errorOf = (e: CoreError): AiError => {
  const code = (AI_ERROR_CODES as readonly string[]).includes(e.code)
    ? (e.code as AiError['code'])
    : 'invalid_output';
  return { code, message: e.message, retryable: false };
};

const countOf = (result: unknown): number => {
  if (!result || typeof result !== 'object') return 0;
  for (const k of ['candidates', 'notes', 'suggestions', 'proposals', 'patterns']) {
    const v = (result as Record<string, unknown>)[k];
    if (Array.isArray(v)) return v.length;
  }
  return 1;
};

const SECRET_ERROR: AiError = {
  code: 'bad_request',
  message:
    'Not sent: the request would contain an API key (it is somewhere in the world’s text). Remove it, then try again.',
  retryable: false,
};

export class ClaudeAiGateway implements AiGateway {
  readonly log$: AiLogStore;
  private readonly registry: PromptRegistry;
  private readonly model: string;
  private readonly cache: ResultCache<Cached>;
  private readonly listeners = new Set<(s: AiStatus) => void>();
  private readonly inflight = new Map<string, AbortController>();
  private enabled = true;
  private pending = 0;
  /** Spend in nano-dollars (integers, so the budget pause is exact). */
  private sessionNanos = 0;
  private monthBaseNanos = 0;
  private seq = 0;
  private lastStatus = '';

  constructor(private readonly opts: ClaudeGatewayOptions) {
    this.registry = opts.registry ?? createPromptRegistry();
    this.log$ = opts.log ?? new AiLogStore();
    this.model = opts.model ?? MODEL;
    this.cache = new ResultCache(opts.cacheSize ?? 500);
  }

  // ── status ───────────────────────────────────────────────────────────────

  /** Starts the JSONL log in the world directory and loads this month's spend. */
  async attach(worldDir: string): Promise<void> {
    this.log$.attach(worldDir);
    this.monthBaseNanos = usdToNanos(await this.log$.monthSpend(this.month()));
    this.emit();
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private month(): string {
    return this.now().toISOString().slice(0, 7);
  }

  private budgetState(): {
    budget: { sessionUsd: number; monthUsd: number };
    paused: boolean;
    reason?: string;
  } {
    const { budget } = aiSettings(this.opts.getWorld().settings);
    const month = this.monthBaseNanos + this.sessionNanos;
    if (this.sessionNanos >= usdToNanos(budget.sessionUsd))
      return {
        budget,
        paused: true,
        reason: `Session budget of $${budget.sessionUsd.toFixed(2)} reached`,
      };
    if (month >= usdToNanos(budget.monthUsd))
      return {
        budget,
        paused: true,
        reason: `Monthly budget of $${budget.monthUsd.toFixed(2)} reached`,
      };
    return { budget, paused: false };
  }

  status(): AiStatus {
    const b = this.budgetState();
    const reason = !this.enabled ? 'AI is off for this session' : b.paused ? b.reason : undefined;
    return {
      mode: 'real',
      enabled: this.enabled,
      ...(reason ? { reason } : {}),
      model: this.model,
      spend: {
        sessionUsd: nanosToUsd(this.sessionNanos),
        monthUsd: nanosToUsd(this.monthBaseNanos + this.sessionNanos),
      },
      budget: b.budget,
      paused: b.paused,
      pending: this.pending,
    };
  }

  onStatus(listener: (s: AiStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) for (const ac of this.inflight.values()) ac.abort();
    this.emit();
  }

  /** Re-emits the status if it changed (called when settings change, e.g. a raised budget). */
  refresh(): void {
    this.emit();
  }

  log(limit = 200): Promise<AiLogEntry[]> {
    return Promise.resolve(this.log$.list(limit));
  }

  /** The request a logged call sent, for the AI log overlay. */
  request(id: string): SentRequest | undefined {
    return this.log$.request(id);
  }

  private emit(force = false): void {
    const s = this.status();
    const key = JSON.stringify(s);
    if (!force && key === this.lastStatus) return;
    this.lastStatus = key;
    for (const l of this.listeners) l(s);
  }

  // ── run ──────────────────────────────────────────────────────────────────

  async run<M extends Moment>(
    moment: M,
    request: MomentRequest<M>,
    options: AiRunOptions<M> = {},
  ): Promise<AiOutcome<M>> {
    const parsed = MOMENT_SCHEMAS[moment].request.safeParse(request);
    if (!parsed.success)
      return {
        ok: false,
        error: { code: 'bad_request', message: z.prettifyError(parsed.error), retryable: false },
      };
    const req = parsed.data as ParsedRequest<M>;
    const entityOf = (): string | undefined =>
      'entityId' in req && typeof req.entityId === 'string' ? req.entityId : undefined;
    const trigger = 'trigger' in req && typeof req.trigger === 'string' ? req.trigger : undefined;
    const base = {
      moment,
      ...(entityOf() ? { entity: entityOf() } : {}),
      ...(trigger ? { trigger } : {}),
      ...(options.via ? { via: options.via } : {}),
    };

    if (!this.enabled)
      return this.finish(
        base,
        {
          ok: false,
          error: { code: 'disabled', message: 'AI is off for this session', retryable: false },
        },
        { attempts: 0 },
      );
    const budget = this.budgetState();
    if (budget.paused)
      return this.finish(
        base,
        {
          ok: false,
          error: {
            code: 'budget',
            message: `${budget.reason ?? 'Budget reached'}. Raise it to continue.`,
            retryable: false,
          },
        },
        { attempts: 0 },
      );
    const builder = this.registry.get(moment);
    if (!builder)
      return this.finish(
        base,
        {
          ok: false,
          error: { code: 'unknown', message: `no prompt builder for ${moment}`, retryable: false },
        },
        { attempts: 0 },
      );

    const world = this.opts.getWorld();
    const settings = aiSettings(world.settings);
    const effort = effortFor(settings, moment);
    const maxTokens = settings.maxTokens[moment];
    const buildOptions: BuildOptions = {
      ...(effort ? { effort } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      pack: { budget: settings.packBudget },
    };
    const first = builder.build(world, req, buildOptions);
    if (!first.ok)
      return this.finish(base, { ok: false, error: errorOf(first.error) }, { attempts: 0 });
    let built = first.value;
    const entity = built.entity ?? entityOf();
    const logBase = { ...base, ...(entity ? { entity } : {}) };
    let params = toMessageParams(built, this.model);
    if (holdsSecret(params, this.opts.client.apiKey))
      return this.finish(logBase, { ok: false, error: SECRET_ERROR }, { attempts: 0 });

    // One request per entity: a new trigger cancels the stale one.
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) ac.abort();
    const slot = entity ?? `#${++this.seq}`;
    this.inflight.get(slot)?.abort();
    this.inflight.set(slot, ac);
    this.pending++;
    this.emit();
    const started = this.now().getTime();
    try {
      // Token limit: estimate locally; count exactly near the limit; re-pack once if over.
      let counted: number | undefined;
      if (built.estimate > (this.opts.countThreshold ?? COUNT_THRESHOLD)) {
        counted = await this.count(params, ac.signal);
        if (counted !== undefined && counted >= HARD_LIMIT) {
          const shrink = Math.floor(settings.packBudget * ((HARD_LIMIT * 0.85) / counted));
          const again = builder.build(world, req, { ...buildOptions, pack: { budget: shrink } });
          if (again.ok) {
            built = again.value;
            params = toMessageParams(built, this.model);
            if (holdsSecret(params, this.opts.client.apiKey))
              return this.finish(logBase, { ok: false, error: SECRET_ERROR }, { attempts: 0 });
            counted = await this.count(params, ac.signal);
          }
        }
        if (counted !== undefined && counted >= REQUEST_LIMIT)
          return this.finish(
            logBase,
            {
              ok: false,
              error: {
                code: 'too_large',
                message: `The request would be ${counted} tokens (limit ${REQUEST_LIMIT})`,
                retryable: false,
              },
            },
            { attempts: 0, estimate: built.estimate, counted },
          );
      }
      if (ac.signal.aborted)
        return this.finish(logBase, cancelled(), { attempts: 0, estimate: built.estimate });

      const key = cacheKey(moment, params);
      const hit = this.cache.get(key);
      if (hit) {
        if (moment === 'spread' && options.onPartial)
          for (const c of (hit.result as MomentResult<'spread'>).candidates)
            (options.onPartial as (c: unknown) => void)(c);
        const meta: AiCallMeta = {
          ...hit.meta,
          usage: ZERO_USAGE,
          costUsd: 0,
          latencyMs: 0,
          cached: true,
        };
        return this.finish(
          logBase,
          { ok: true, result: hit.result as MomentResult<M>, meta },
          {
            attempts: 0,
            outcome: 'cached',
            results: hit.results,
            estimate: built.estimate,
            ...(counted !== undefined ? { counted } : {}),
          },
        );
      }

      const sent: SentRequest = {
        text: promptText(built),
        params: {
          model: params.model,
          max_tokens: params.max_tokens,
          effort: built.effort,
          stream: built.stream,
        },
      };
      const { attempts, outcome } = await this.callWithRetries(
        builder,
        req,
        world,
        built,
        params,
        ac.signal,
        options,
      );
      const latencyMs = Math.max(0, this.now().getTime() - started);
      const nanos = costNanos(outcome.usage, priceFor(settings, this.model));
      const meta: AiCallMeta = {
        moment,
        requestHash: key,
        model: this.model,
        usage: outcome.usage,
        costUsd: nanosToUsd(nanos),
        latencyMs,
        cached: false,
        dropped: outcome.ok ? outcome.dropped : 0,
      };
      this.sessionNanos += nanos;
      const extra = {
        attempts,
        estimate: built.estimate,
        ...(counted !== undefined ? { counted } : {}),
        ...(outcome.stopReason ? { stopReason: outcome.stopReason } : {}),
        sent,
        ...(settings.debug ? { full: params } : {}),
      };
      if (!outcome.ok)
        return this.finish(logBase, { ok: false, error: outcome.error, meta }, extra);
      const results = countOf(outcome.result);
      this.cache.set(key, { result: outcome.result, meta, results });
      return this.finish(
        logBase,
        { ok: true, result: outcome.result as MomentResult<M>, meta },
        { ...extra, results },
      );
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
      if (this.inflight.get(slot) === ac) this.inflight.delete(slot);
      this.pending--;
      this.emit();
    }
  }

  private async count(params: MessageParams, signal: AbortSignal): Promise<number | undefined> {
    try {
      const r = await this.opts.client.messages.countTokens(toCountParams(params), {
        signal,
        maxRetries: 0,
      });
      return r.input_tokens;
    } catch {
      // Counting is a safety check: on failure, rely on the conservative local estimate.
      return undefined;
    }
  }

  private async callWithRetries<M extends Moment>(
    builder: PromptBuilder<M>,
    req: ParsedRequest<M>,
    world: World,
    built: BuiltPrompt,
    params: MessageParams,
    signal: AbortSignal,
    options: AiRunOptions<M>,
  ): Promise<{
    attempts: number;
    outcome:
      | { ok: true; result: unknown; dropped: number; usage: Usage; stopReason?: string }
      | { ok: false; error: AiError; usage: Usage; stopReason?: string };
  }> {
    const policy = this.opts.retry ?? DEFAULT_RETRY;
    const random = this.opts.random ?? Math.random;
    const sleep = this.opts.sleep ?? realSleep;
    let usage: Usage = ZERO_USAGE;
    const add = (u: Usage): void => {
      usage = {
        input: usage.input + u.input,
        output: usage.output + u.output,
        cacheRead: usage.cacheRead + u.cacheRead,
        cacheWrite: usage.cacheWrite + u.cacheWrite,
      };
    };
    for (let attempt = 0; ; attempt++) {
      const partials = { sent: 0, dropped: 0 };
      try {
        const message = await this.callOnce(
          builder,
          req,
          world,
          built,
          params,
          signal,
          options,
          partials,
        );
        add(usageOf(message));
        const stopReason = message.stop_reason ?? undefined;
        const tail = stopReason ? { stopReason } : {};
        if (stopReason === 'refusal')
          return {
            attempts: attempt + 1,
            outcome: {
              ok: false,
              error: { code: 'refused', message: 'Claude declined this request', retryable: false },
              usage,
              ...tail,
            },
          };
        if (stopReason === 'max_tokens')
          return {
            attempts: attempt + 1,
            outcome: {
              ok: false,
              error: {
                code: 'truncated',
                message: `The answer was cut off at ${built.maxTokens} tokens`,
                retryable: false,
              },
              usage,
              ...tail,
            },
          };
        if (stopReason === 'model_context_window_exceeded')
          return {
            attempts: attempt + 1,
            outcome: {
              ok: false,
              error: {
                code: 'too_large',
                message: 'The request exceeded the context window',
                retryable: false,
              },
              usage,
              ...tail,
            },
          };
        const text = message.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          return {
            attempts: attempt + 1,
            outcome: {
              ok: false,
              error: {
                code: 'invalid_output',
                message: 'The answer was not valid JSON',
                retryable: false,
              },
              usage,
              ...tail,
            },
          };
        }
        const parsed = builder.parse(raw, world, req);
        if (!parsed.ok)
          return {
            attempts: attempt + 1,
            outcome: { ok: false, error: errorOf(parsed.error), usage, ...tail },
          };
        const checked = MOMENT_SCHEMAS[built.moment].result.safeParse(parsed.value.result);
        if (!checked.success)
          return {
            attempts: attempt + 1,
            outcome: {
              ok: false,
              error: {
                code: 'invalid_output',
                message: z.prettifyError(checked.error),
                retryable: false,
              },
              usage,
              ...tail,
            },
          };
        return {
          attempts: attempt + 1,
          outcome: {
            ok: true,
            result: checked.data,
            dropped: parsed.value.dropped,
            usage,
            ...tail,
          },
        };
      } catch (e) {
        const error = classifyError(e, signal.aborted);
        // Once candidates have been shown, a retry would show them twice: fail instead.
        const last = attempt + 1 >= policy.attempts || partials.sent > 0;
        if (!error.retryable || last)
          return { attempts: attempt + 1, outcome: { ok: false, error, usage } };
        await sleep(backoffMs(policy, attempt, random, retryAfterMs(e)), signal);
        if (signal.aborted)
          return { attempts: attempt + 1, outcome: { ok: false, error: cancelled().error, usage } };
      }
    }
  }

  private async callOnce<M extends Moment>(
    builder: PromptBuilder<M>,
    req: ParsedRequest<M>,
    world: World,
    built: BuiltPrompt,
    params: MessageParams,
    signal: AbortSignal,
    options: AiRunOptions<M>,
    partials: { sent: number; dropped: number },
  ): Promise<Anthropic.Message> {
    const client = this.opts.client;
    if (!built.stream) return client.messages.create(params, { signal, maxRetries: 0 });
    const stream = client.messages.stream(params, { signal, maxRetries: 0 });
    const spec = builder.stream;
    if (spec) {
      const streamer = new JsonArrayStreamer(spec.arrayKey);
      let index = 0;
      stream.on('text', (delta) => {
        for (const raw of streamer.push(delta)) {
          const item = raw === undefined ? null : spec.item(raw, index, world, req);
          index++;
          if (item === null) partials.dropped++;
          else if (!signal.aborted) {
            partials.sent++;
            options.onPartial?.(item);
          }
        }
      });
    }
    return stream.finalMessage();
  }

  private finish<M extends Moment>(
    base: { moment: Moment; entity?: string; trigger?: string; via?: 'agent' },
    outcome: AiOutcome<M>,
    extra: {
      attempts: number;
      outcome?: AiLogEntry['outcome'];
      results?: number;
      estimate?: number;
      counted?: number;
      stopReason?: string;
      sent?: SentRequest;
      full?: unknown;
    },
  ): AiOutcome<M> {
    const at = this.now().toISOString();
    const id = `ai-${at.replace(/[^0-9]/g, '').slice(0, 17)}-${++this.seq}`;
    const kind: AiLogEntry['outcome'] =
      extra.outcome ??
      (outcome.ok ? 'ok' : outcome.error.code === 'cancelled' ? 'cancelled' : 'error');
    this.log$.add(
      {
        id,
        at,
        ...base,
        outcome: kind,
        ...(outcome.ok ? {} : { error: outcome.error }),
        ...(outcome.meta ? { meta: outcome.meta } : {}),
        ...(extra.results !== undefined ? { results: extra.results } : {}),
        attempts: extra.attempts,
        ...(extra.stopReason ? { stopReason: extra.stopReason } : {}),
        ...(extra.estimate !== undefined ? { estimate: extra.estimate } : {}),
        ...(extra.counted !== undefined ? { counted: extra.counted } : {}),
        ...(extra.full !== undefined ? { request: extra.full } : {}),
      },
      extra.sent,
    );
    this.emit();
    return outcome;
  }
}
