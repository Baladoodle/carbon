import { currentVia } from '../agent/via';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { AiGateway } from '@core/ai/gateway';
import { cmd } from '@core/commands/registry';
import {
  BatchPlanRequestSchema,
  BatchRunRequestSchema,
  IconFromConceptRequestSchema,
  ImageEstimateRequestSchema,
  ImageGenerateRequestSchema,
  ImagePromptRequestSchema,
  SheetAcceptRequestSchema,
  SheetCropRequestSchema,
  SheetRunRequestSchema,
  type SheetAcceptRequest,
  type SheetAcceptResult,
  type SheetCropRequest,
  type SheetOutcome,
  type SheetPlan,
  type SheetReview,
  type SheetRunRequest,
  type SheetRunResult,
  type BatchItemResultSchema,
  type BatchPlan,
  type BatchPlanRequest,
  type BatchProgress,
  type BatchResult,
  type BatchRunRequest,
  type IconFromConceptRequest,
  type ImageAttempt,
  type ImageError,
  type ImageErrorCode,
  type ImageEstimate,
  type ImageEstimateRequest,
  type ImageGateway,
  type ImageGenerateRequest,
  type ImageLogEntry,
  type ImagePromptRequest,
  type ImagePromptResult,
  type ImageReceipt,
  type ImageResult,
  type ImageStatus,
} from '@core/images/gateway';
import { sheetLines, sheetPromptWithLines, splitSheets } from '@core/images/sheet';
import {
  ICON_PX,
  SHEET_SIZE,
  imagePaths,
  type ImageModel,
  type ImageQuality,
  type ImageSize,
  type EntityImages,
  type ImageKind,
  type ImageMeta,
} from '@core/images/model';
import {
  costNanos,
  estimateNanos,
  imageSettings,
  nanosToUsd,
  priceOf,
  resolveCall,
  type ImageSettings,
} from '@core/images/pricing';
import type { World } from '@core/model/world';
import type { DispatchResult } from '@shared/ipc';
import type { z } from 'zod';
import { writeFileAtomic } from '../store/atomic';
import { ImageLogStore } from './log';
import { cropSheet, drawGuide, filterImage, sheetLayout, type SheetCell } from '@core/pixel';
import { dataUrl, decodePng, downscale, encodePng, isPng, sha256, type Rgba } from './png';
import { ProviderError, type ImageProvider, type ProviderResponse } from './provider';
import { ulid } from './ulid';

/**
 * The image gateway in main (docs/IMAGES.md §4): the one path from a
 * confirmed prompt to an image in the world.
 *
 *   prompt (Claude) → estimate → [user confirms] → provider call (one
 *   attempt; 429s wait and try again, nothing else does) → decode and check
 *   the PNG → icons: the `item` pixel filter → files written atomically →
 *   `image.add` (one undo step) → log line, spend, status.
 *
 * Genforge's rule holds throughout: a call whose outcome is unknown (a
 * timeout, a dropped connection, an abort after sending) is never retried,
 * and its estimate counts against the budget, because it may have been
 * charged.
 */

export interface ImageSession {
  readonly dir: string;
  readonly world: World;
  dispatch(commands: readonly { type: string; payload: unknown }[], label?: string): DispatchResult;
}

export interface ImageGatewayOptions {
  session: ImageSession;
  ai: AiGateway;
  /** `null`: images are off (no key, CARBON_IMAGES=off), with `offReason`. */
  provider: ImageProvider | null;
  offReason?: string;
  mode?: ImageStatus['mode'];
  now?: () => Date;
  /** Waits for a 429's retry-after (tests pass an instant one). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** How many times a 429 is retried (default 2). Nothing else is retried. */
  rateLimitRetries?: number;
  /** Paid calls at once in a batch (default 2). */
  concurrency?: number;
}

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });

const fail = (
  code: ImageErrorCode,
  message: string,
  receipt?: ImageReceipt,
  unknownOutcome = false,
): ImageResult => ({
  ok: false,
  error: { code, message, unknownOutcome },
  ...(receipt ? { receipt } : {}),
});

/** A key-shaped string in a prompt is refused before anything is sent. */
const SECRET = /\bsk-[A-Za-z0-9_-]{16,}/;

/** Read through a call, so TypeScript doesn't narrow it from an earlier check. */
const aborted = (s: AbortSignal): boolean => s.aborted;

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The line `.gitattributes` needs so git never diffs or merges image bytes as text. */
export const PNG_ATTRIBUTE = '*.png binary';

/**
 * Images are committed with the world (git snapshots), so the world's
 * `.gitattributes` marks PNGs binary. Added once; an existing file keeps its
 * lines and gains this one if it lacks it.
 */
export async function ensureGitAttributes(dir: string): Promise<void> {
  const file = path.join(dir, '.gitattributes');
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text !== null && text.split(/\r?\n/).some((l) => l.trim() === PNG_ATTRIBUTE)) return;
  const next =
    text === null || text === ''
      ? `${PNG_ATTRIBUTE}\n`
      : `${text.replace(/\n?$/, '\n')}${PNG_ATTRIBUTE}\n`;
  await writeFileAtomic(file, next);
}

export class MainImageGateway implements ImageGateway {
  readonly log$ = new ImageLogStore();
  private readonly listeners = new Set<(s: ImageStatus) => void>();
  private readonly controllers = new Map<string, AbortController>();
  private sessionNanos = 0;
  private monthNanos = 0;
  private month = '';
  private pending = 0;
  private readonly thumbs = new Map<string, { dataUrl: string; width: number; height: number }>();
  private readonly now: () => Date;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(private readonly o: ImageGatewayOptions) {
    this.now = o.now ?? (() => new Date());
    this.sleep = o.sleep ?? abortableSleep;
    this.month = this.now().toISOString().slice(0, 7);
  }

  /** Starts the JSONL log in the world and loads this month's spend. */
  async attach(): Promise<void> {
    this.log$.attach(this.o.session.dir);
    this.month = this.now().toISOString().slice(0, 7);
    this.monthNanos = await this.log$.load(this.month);
    this.emit();
  }

  private get settings(): ImageSettings {
    return imageSettings(this.o.session.world.settings);
  }

  // ── status and budget ──────────────────────────────────────────────────

  private pauseReason(s: ImageSettings): string | undefined {
    const b = s.budget;
    if (this.sessionNanos >= Math.round(b.sessionUsd * 1e9))
      return `Session image budget of $${b.sessionUsd.toFixed(2)} reached`;
    if (this.monthNanos >= Math.round(b.monthUsd * 1e9))
      return `Monthly image budget of $${b.monthUsd.toFixed(2)} reached`;
    return undefined;
  }

  status(): ImageStatus {
    const s = this.settings;
    const off = this.o.provider === null;
    const paused = off ? undefined : this.pauseReason(s);
    const reason = off ? (this.o.offReason ?? 'Images are off') : paused;
    return {
      mode: off ? 'off' : (this.o.mode ?? 'real'),
      enabled: !off,
      ...(reason ? { reason } : {}),
      model: s.model,
      quality: s.quality,
      spend: { sessionUsd: nanosToUsd(this.sessionNanos), monthUsd: nanosToUsd(this.monthNanos) },
      budget: { sessionUsd: s.budget.sessionUsd, monthUsd: s.budget.monthUsd },
      paused: paused !== undefined,
      pending: this.pending,
    };
  }

  onStatus(listener: (s: ImageStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Re-sends the status (settings changed: the budget or the model). */
  refresh(): void {
    this.emit();
  }

  private emit(): void {
    const s = this.status();
    for (const l of this.listeners) l(s);
  }

  private addSpend(nanos: number): void {
    const m = this.now().toISOString().slice(0, 7);
    if (m !== this.month) {
      this.month = m;
      this.monthNanos = 0;
    }
    this.sessionNanos += nanos;
    this.monthNanos += nanos;
  }

  async log(limit?: number): Promise<ImageLogEntry[]> {
    await Promise.resolve();
    return this.log$.recent(limit);
  }

  /** Each logged call, as it's logged (the module forwards them to the renderer). */
  onLogged?: (e: ImageLogEntry) => void;

  // ── prompt and estimate ────────────────────────────────────────────────

  async prompt(req: ImagePromptRequest, signal?: AbortSignal): Promise<ImagePromptResult> {
    const r = ImagePromptRequestSchema.safeParse(req);
    if (!r.success)
      return {
        ok: false,
        error: { code: 'bad_request', message: r.error.message, unknownOutcome: false },
      };
    if (!has(this.o.session.world.entities, r.data.entityId))
      return {
        ok: false,
        error: {
          code: 'not_found',
          message: `no entity "${r.data.entityId}"`,
          unknownOutcome: false,
        },
      };
    const via = currentVia();
    const out = await this.o.ai.run('image_prompt', r.data, {
      ...(signal ? { signal } : {}),
      ...(via ? { via } : {}),
    });
    if (!out.ok)
      return {
        ok: false,
        error: {
          code: out.error.code === 'cancelled' ? 'cancelled' : 'prompt_failed',
          message: `Claude couldn't write the prompt: ${out.error.message}`,
          unknownOutcome: false,
        },
      };
    return { ok: true, prompt: out.result.prompt, claudeCostUsd: out.meta.costUsd };
  }

  estimate(req: ImageEstimateRequest): ImageEstimate {
    const r = ImageEstimateRequestSchema.parse(req);
    const s = this.settings;
    const call = resolveCall(s, r.kind, r);
    const per = estimateNanos(s, { ...call, promptChars: r.promptChars });
    const remaining = Math.round(s.budget.sessionUsd * 1e9) - this.sessionNanos;
    return {
      ...call,
      calls: r.calls,
      perCallUsd: nanosToUsd(per),
      totalUsd: nanosToUsd(per * r.calls),
      remainingUsd: nanosToUsd(remaining),
    };
  }

  // ── one paid call ──────────────────────────────────────────────────────

  cancel(id: string): void {
    this.controllers.get(id)?.abort();
  }

  async generate(req: ImageGenerateRequest, signal?: AbortSignal): Promise<ImageResult> {
    const parsed = ImageGenerateRequestSchema.safeParse(req);
    if (!parsed.success) return fail('bad_request', parsed.error.message);
    const r = parsed.data;
    const ac = new AbortController();
    const prev = this.controllers.get(r.requestId);
    prev?.abort();
    this.controllers.set(r.requestId, ac);
    const relay = (): void => ac.abort();
    signal?.addEventListener('abort', relay, { once: true });
    try {
      return await this.generateOne(r, ac.signal);
    } finally {
      signal?.removeEventListener('abort', relay);
      if (this.controllers.get(r.requestId) === ac) this.controllers.delete(r.requestId);
    }
  }

  private async generateOne(
    r: z.output<typeof ImageGenerateRequestSchema>,
    signal: AbortSignal,
    batchId?: string,
  ): Promise<ImageResult> {
    const world = this.o.session.world;
    const s = this.settings;
    const call = resolveCall(s, r.kind, r);
    const receipt: ImageReceipt = {
      entity: r.entityId,
      kind: r.kind,
      prompt: r.prompt,
      attempts: [],
      costUsd: 0,
    };
    if (!this.o.provider) return fail('disabled', this.o.offReason ?? 'Images are off', receipt);
    if (!has(world.entities, r.entityId))
      return fail('not_found', `no entity "${r.entityId}"`, receipt);
    const paused = this.pauseReason(s);
    if (paused) return fail('budget', paused, receipt);
    if (SECRET.test(r.prompt))
      return fail('bad_request', 'the prompt contains something shaped like an API key', receipt);
    let reference: Uint8Array | undefined;
    if (r.reference) {
      const meta = world.images?.[r.entityId]?.all.find((m) => m.id === r.reference);
      if (!meta) return fail('not_found', `no image "${r.reference}" for "${r.entityId}"`, receipt);
      reference = await this.readPng(
        r.entityId,
        meta.id,
        meta.origin.by === 'filter' ? 'png' : 'src',
      );
      if (!reference) return fail('not_found', `the reference image's file is missing`, receipt);
    }
    if (signal.aborted) return fail('cancelled', 'cancelled', receipt);

    const { response, error: callError } = await this.paidCall(
      receipt,
      call,
      r.prompt,
      r.kind === 'icon' ? 'transparent' : 'auto',
      reference,
      signal,
    );

    const finish = (result: ImageResult): ImageResult => {
      this.logCall(
        receipt,
        result.ok ? { ok: true, image: result.image.id } : { ok: false, error: result.error },
        call,
        reference !== undefined,
        batchId,
      );
      this.emit();
      return result;
    };

    if (!response) {
      const e = callError ?? {
        code: 'unknown' as const,
        message: 'no response',
        unknownOutcome: true,
      };
      return finish({ ok: false, error: e, receipt });
    }
    // The pixels: check what came back is a PNG we can read.
    let decoded;
    try {
      if (!isPng(response.png)) throw new Error('not a PNG');
      decoded = decodePng(response.png);
    } catch (e) {
      return finish(
        fail(
          'invalid_output',
          `the image couldn't be read (${e instanceof Error ? e.message : 'bad bytes'})`,
          receipt,
        ),
      );
    }
    const id = ulid(this.now().getTime());
    const isIcon = r.kind === 'icon';
    const output = isIcon
      ? encodePng(
          filterImage(decoded, { target: { w: ICON_PX, h: ICON_PX }, preset: 'item' }).image,
        )
      : response.png;
    const usage = response.usage;
    const meta: ImageMeta = {
      id,
      entity: r.entityId,
      kind: r.kind,
      origin:
        this.o.provider.name === 'fake'
          ? { by: 'fake', prompt: r.prompt, size: call.size }
          : {
              by: 'openai',
              model: call.model,
              quality: call.quality,
              size: call.size,
              prompt: r.prompt,
              ...(response.requestId ? { requestId: response.requestId } : {}),
              ...(r.reference ? { reference: r.reference } : {}),
            },
      usage: {
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        images: 1,
      },
      costUsd: receipt.costUsd,
      created: this.now().toISOString(),
      width: isIcon ? ICON_PX : decoded.width,
      height: isIcon ? ICON_PX : decoded.height,
      hashes: { output: sha256(output), ...(isIcon ? { source: sha256(response.png) } : {}) },
    };
    receipt.image = id;
    const added = await this.addToWorld(meta, output, isIcon ? response.png : undefined, r.select);
    if (!added.ok) return finish({ ok: false, error: added.error, receipt });
    return finish({ ok: true, image: meta, receipt });
  }

  /**
   * One paid call with its receipt and spend: a rate limit waits and tries
   * again (it's known not to have run); nothing else is retried. A call whose
   * outcome is unknown counts at its estimate.
   */
  private async paidCall(
    receipt: ImageReceipt,
    call: { model: ImageModel; quality: ImageQuality; size: ImageSize },
    prompt: string,
    background: 'transparent' | 'auto',
    reference: Uint8Array | undefined,
    signal: AbortSignal,
  ): Promise<{ response?: ProviderResponse; error?: ImageError }> {
    const provider = this.o.provider;
    if (!provider)
      return { error: { code: 'disabled', message: 'Images are off', unknownOutcome: false } };
    const s = this.settings;
    const price = priceOf(s, call.model);
    const estimate = estimateNanos(s, {
      ...call,
      promptChars: prompt.length,
      reference: reference !== undefined,
    });
    const retries = this.o.rateLimitRetries ?? 2;
    this.pending++;
    this.emit();
    let response: ProviderResponse | undefined;
    let lastError: ProviderError | undefined;
    let totalNanos = 0;
    try {
      for (let attempt = 0; attempt <= retries; attempt++) {
        const t0 = Date.now();
        const at = this.now().toISOString();
        try {
          response = await provider.generate({
            model: call.model,
            quality: call.quality,
            size: call.size,
            prompt,
            background,
            ...(reference ? { reference } : {}),
            signal,
          });
          const nanos = response.usage ? costNanos(price, response.usage) : estimate;
          totalNanos += nanos;
          receipt.attempts.push(
            this.attemptOf(at, t0, call, reference !== undefined, {
              status: 'ok',
              nanos,
              costFrom: response.usage ? 'usage' : 'estimate',
              ...(response.requestId ? { requestId: response.requestId } : {}),
              ...(response.usage ? { usage: response.usage } : {}),
            }),
          );
          break;
        } catch (e) {
          const pe =
            e instanceof ProviderError
              ? e
              : new ProviderError({
                  code: 'unknown',
                  message: e instanceof Error ? e.message : String(e),
                  unknownOutcome: true,
                });
          lastError = pe;
          // A call that may have been charged counts at its estimate; a known failure costs nothing.
          const nanos = pe.error.unknownOutcome ? estimate : 0;
          totalNanos += nanos;
          receipt.attempts.push(
            this.attemptOf(at, t0, call, reference !== undefined, {
              status: pe.error.unknownOutcome ? 'unknown' : 'error',
              nanos,
              costFrom: pe.error.unknownOutcome ? 'estimate' : 'none',
              error: pe.error,
              ...(pe.httpStatus !== undefined ? { httpStatus: pe.httpStatus } : {}),
              ...(pe.requestId ? { requestId: pe.requestId } : {}),
            }),
          );
          // Only a rate limit is known not to have run: wait and try again. Nothing else retries.
          if (pe.error.code !== 'rate_limited' || attempt === retries || aborted(signal)) break;
          const wait = Math.min(
            30_000,
            Math.max(1_000, (pe.retryAfter ?? 2 ** attempt * 2) * 1000),
          );
          try {
            await this.sleep(wait, signal);
          } catch {
            break;
          }
        }
      }
    } finally {
      this.pending--;
      this.addSpend(totalNanos);
      receipt.costUsd = nanosToUsd(totalNanos);
    }

    return response
      ? { response }
      : {
          error: lastError?.error ?? {
            code: 'unknown',
            message: 'no response',
            unknownOutcome: true,
          },
        };
  }

  private attemptOf(
    at: string,
    t0: number,
    call: { model: string; quality: string; size: string },
    edit: boolean,
    x: {
      status: ImageAttempt['status'];
      nanos: number;
      costFrom: ImageAttempt['costFrom'];
      requestId?: string;
      usage?: ImageAttempt['usage'];
      error?: ImageError;
      httpStatus?: number;
    },
  ): ImageAttempt {
    return {
      at,
      provider: this.o.provider?.name ?? 'fake',
      endpoint: edit ? 'edit' : 'generate',
      model: call.model,
      quality: call.quality,
      size: call.size,
      status: x.status,
      latencyMs: Math.max(0, Date.now() - t0),
      costUsd: nanosToUsd(x.nanos),
      costFrom: x.costFrom,
      ...(x.httpStatus !== undefined ? { httpStatus: x.httpStatus } : {}),
      ...(x.requestId ? { requestId: x.requestId } : {}),
      ...(x.usage ? { usage: x.usage } : {}),
      ...(x.error ? { error: x.error } : {}),
    };
  }

  private logCall(
    receipt: ImageReceipt,
    result: { ok: true; image: string } | { ok: false; error: ImageError },
    call: { model: string; quality: string; size: string },
    edit: boolean,
    batchId?: string,
  ): void {
    for (const a of receipt.attempts) {
      const entry: ImageLogEntry = {
        id: ulid(this.now().getTime()),
        at: a.at,
        provider: a.provider,
        entity: receipt.entity,
        kind: receipt.kind,
        endpoint: edit ? 'edit' : 'generate',
        model: call.model,
        size: call.size,
        quality: call.quality,
        outcome:
          a.status === 'ok'
            ? result.ok
              ? 'ok'
              : 'error'
            : a.error?.code === 'cancelled'
              ? 'cancelled'
              : a.status,
        ...(a.status === 'ok' && !result.ok
          ? { error: result.error }
          : a.error
            ? { error: a.error }
            : {}),
        ...(a.usage ? { usage: a.usage } : {}),
        costUsd: a.costUsd,
        costFrom: a.costFrom,
        latencyMs: a.latencyMs,
        ...(a.requestId ? { requestId: a.requestId } : {}),
        ...(a.status === 'ok' && result.ok ? { image: result.image } : {}),
        ...(batchId ? { batchId } : {}),
        ...(currentVia() ? { via: 'agent' as const } : {}),
      };
      this.log$.add(entry);
      this.onLogged?.(entry);
    }
  }

  /** Writes the files (atomically, the PNGs first), then `image.add`. */
  private async addToWorld(
    meta: ImageMeta,
    png: Uint8Array,
    src: Uint8Array | undefined,
    select: boolean,
  ): Promise<{ ok: true } | { ok: false; error: ImageError }> {
    const dir = this.o.session.dir;
    const p = imagePaths(meta.entity, meta.id);
    try {
      await ensureGitAttributes(dir);
      await mkdir(path.join(dir, 'images', meta.entity), { recursive: true });
      if (src) await writeFileAtomic(path.join(dir, p.src), src);
      await writeFileAtomic(path.join(dir, p.png), png);
    } catch (e) {
      return {
        ok: false,
        error: {
          code: 'io',
          message: `the image couldn't be saved: ${e instanceof Error ? e.message : String(e)}`,
          unknownOutcome: false,
        },
      };
    }
    // The .json and selection are written by the store, from the command's patch.
    const d = this.o.session.dispatch([cmd('image.add', { image: meta, select })]);
    if (!d.ok)
      return {
        ok: false,
        error: {
          code: d.error.code === 'entity.not_found' ? 'not_found' : 'io',
          message: d.error.message,
          unknownOutcome: false,
        },
      };
    return { ok: true };
  }

  private async readPng(
    entity: string,
    id: string,
    variant: 'png' | 'src',
  ): Promise<Uint8Array | undefined> {
    const p = imagePaths(entity, id);
    const dir = this.o.session.dir;
    const tryRead = async (rel: string): Promise<Uint8Array | undefined> => {
      try {
        return new Uint8Array(await readFile(path.join(dir, rel)));
      } catch {
        return undefined;
      }
    };
    // A concept has no separate source: its .png is the provider's image.
    return variant === 'src' ? ((await tryRead(p.src)) ?? (await tryRead(p.png))) : tryRead(p.png);
  }

  // ── the free icon ──────────────────────────────────────────────────────

  async iconFromConcept(req: IconFromConceptRequest): Promise<ImageResult> {
    const parsed = IconFromConceptRequestSchema.safeParse(req);
    if (!parsed.success) return fail('bad_request', parsed.error.message);
    const r = parsed.data;
    const world = this.o.session.world;
    if (!has(world.entities, r.entityId)) return fail('not_found', `no entity "${r.entityId}"`);
    const imgs: EntityImages | undefined = world.images?.[r.entityId];
    const fromId = r.from ?? imgs?.concept;
    const from = imgs?.all.find((m) => m.id === fromId);
    if (!fromId || !from) return fail('not_found', 'no concept image to make the icon from');
    if (from.kind !== 'concept') return fail('bad_request', `"${fromId}" is not a concept image`);
    const bytes = await this.readPng(r.entityId, from.id, 'src');
    if (!bytes) return fail('not_found', "the concept image's file is missing");
    let decoded;
    try {
      decoded = decodePng(bytes);
    } catch {
      return fail('invalid_output', "the concept image couldn't be read");
    }
    const filtered = filterImage(decoded, { target: { w: ICON_PX, h: ICON_PX }, preset: 'item' });
    const output = encodePng(filtered.image);
    const meta: ImageMeta = {
      id: ulid(this.now().getTime()),
      entity: r.entityId,
      kind: 'icon',
      origin: {
        by: 'filter',
        from: from.id,
        preset: 'item',
        // What ran (pixel's report): the settings and the Genforge revision.
        settings: {
          target: ICON_PX,
          settings: filtered.report.settings,
          upstream: filtered.report.upstream,
        },
      },
      created: this.now().toISOString(),
      width: ICON_PX,
      height: ICON_PX,
      hashes: { output: sha256(output), source: sha256(bytes) },
    };
    const receipt: ImageReceipt = {
      entity: r.entityId,
      kind: 'icon',
      prompt: '',
      attempts: [],
      image: meta.id,
      costUsd: 0,
    };
    const added = await this.addToWorld(meta, output, undefined, r.select);
    if (!added.ok) return { ok: false, error: added.error, receipt };
    return { ok: true, image: meta, receipt };
  }

  // ── batches ────────────────────────────────────────────────────────────

  async batchPlan(req: BatchPlanRequest, signal?: AbortSignal): Promise<BatchPlan> {
    const r = BatchPlanRequestSchema.parse(req);
    const s = this.settings;
    const call = resolveCall(s, r.kind, r);
    const ac = new AbortController();
    if (r.requestId) this.controllers.set(r.requestId, ac);
    const relay = (): void => ac.abort();
    signal?.addEventListener('abort', relay, { once: true });
    const world = this.o.session.world;
    let claude = 0;
    type Item = BatchPlan['items'][number];
    const items: Item[] = [...new Set(r.entityIds)].map((entityId) => {
      const e = world.entities[entityId];
      if (!e) return { entityId, name: entityId, skip: 'not_found' as const };
      if (!r.replace && world.images?.[entityId]?.[r.kind])
        return { entityId, name: e.name, skip: 'has_image' as const };
      return { entityId, name: e.name };
    });
    const todo = items.filter((i) => !i.skip);
    if (r.kind === 'icon') {
      // Icons batch as sheets (IMAGES.md §2a): lines from the entities, no Claude call per item.
      signal?.removeEventListener('abort', relay);
      if (r.requestId && this.controllers.get(r.requestId) === ac)
        this.controllers.delete(r.requestId);
      const sheetCall = resolveCall(s, 'icon', { ...r, size: SHEET_SIZE });
      const sheets = this.planSheets(
        todo.map((i) => i.entityId),
        sheetCall,
      );
      const lineOf = new Map(
        sheets.flatMap((x) => x.items.map((i) => [i.entityId, i.line] as const)),
      );
      for (const i of todo) {
        const line = lineOf.get(i.entityId);
        if (line !== undefined) i.line = line;
      }
      const total = sheets.reduce((n, x) => n + Math.round(x.estimateUsd * 1e9), 0);
      const remaining = Math.round(s.budget.sessionUsd * 1e9) - this.sessionNanos;
      return {
        kind: r.kind,
        ...sheetCall,
        items,
        calls: sheets.length,
        estimate: {
          ...sheetCall,
          calls: sheets.length,
          perCallUsd: sheets[0]?.estimateUsd ?? 0,
          totalUsd: nanosToUsd(total),
          remainingUsd: nanosToUsd(remaining),
        },
        claudeCostUsd: 0,
        sheets,
      };
    }
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const item = todo[next++] as Item;
        if (ac.signal.aborted) {
          item.skip = 'prompt_failed';
          item.error = { code: 'cancelled', message: 'cancelled', unknownOutcome: false };
          continue;
        }
        const out = await this.prompt({ entityId: item.entityId, kind: r.kind }, ac.signal);
        if (out.ok) {
          item.prompt = out.prompt;
          claude += out.claudeCostUsd;
        } else {
          item.skip = 'prompt_failed';
          item.error = out.error;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(4, todo.length) }, worker));
    } finally {
      signal?.removeEventListener('abort', relay);
      if (r.requestId && this.controllers.get(r.requestId) === ac)
        this.controllers.delete(r.requestId);
    }
    const ready = items.filter((i) => i.prompt !== undefined);
    const chars = ready.reduce((n, i) => n + (i.prompt?.length ?? 0), 0);
    const est = this.estimate({
      kind: r.kind,
      ...call,
      calls: 1,
      promptChars: ready.length > 0 ? Math.round(chars / ready.length) : 600,
    });
    return {
      kind: r.kind,
      ...call,
      items,
      calls: ready.length,
      estimate: {
        ...est,
        calls: ready.length,
        totalUsd: nanosToUsd(Math.round(est.perCallUsd * 1e9) * ready.length),
      },
      claudeCostUsd: claude,
    };
  }

  async batchRun(
    req: BatchRunRequest,
    onProgress?: (p: BatchProgress) => void,
  ): Promise<BatchResult> {
    const r = BatchRunRequestSchema.parse(req);
    const ac = new AbortController();
    this.controllers.get(r.batchId)?.abort();
    this.controllers.set(r.batchId, ac);
    type ItemResult = z.output<typeof BatchItemResultSchema>;
    const results: (ItemResult | undefined)[] = r.items.map(() => undefined);
    const running = new Set<string>();
    let done = 0;
    let cost = 0;
    const progress = (item?: ItemResult): void =>
      onProgress?.({
        batchId: r.batchId,
        total: r.items.length,
        done,
        running: [...running],
        ...(item ? { item } : {}),
        costUsd: cost,
      });
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < r.items.length) {
        const index = next++;
        const it = r.items[index] as (typeof r.items)[number];
        let result: ImageResult;
        const paused = this.o.provider ? this.pauseReason(this.settings) : undefined;
        if (ac.signal.aborted) result = fail('cancelled', 'the batch was cancelled');
        else if (paused) result = fail('budget', paused);
        else {
          running.add(it.entityId);
          progress();
          result = await this.generateOne(
            {
              requestId: `${r.batchId}:${index}`,
              entityId: it.entityId,
              kind: r.kind,
              prompt: it.prompt,
              select: r.select,
              ...(r.model ? { model: r.model } : {}),
              ...(r.quality ? { quality: r.quality } : {}),
              ...(r.size ? { size: r.size } : {}),
            },
            ac.signal,
            r.batchId,
          );
          running.delete(it.entityId);
        }
        cost += result.ok ? result.receipt.costUsd : (result.receipt?.costUsd ?? 0);
        done++;
        const item = { entityId: it.entityId, result };
        results[index] = item;
        progress(item);
      }
    };
    try {
      await Promise.all(
        Array.from({ length: Math.min(this.o.concurrency ?? 2, r.items.length) }, worker),
      );
    } finally {
      if (this.controllers.get(r.batchId) === ac) this.controllers.delete(r.batchId);
    }
    return {
      batchId: r.batchId,
      items: results.map(
        (x, i) =>
          x ?? { entityId: r.items[i]?.entityId ?? '', result: fail('cancelled', 'not run') },
      ),
      costUsd: cost,
      cancelled: ac.signal.aborted,
    };
  }

  // ── icon sheets (IMAGES.md §2a) ───────────────────────────────────────

  /** Plans the sheets of an icon batch: layout, lines, and the estimate per sheet. No call. */
  private planSheets(
    entityIds: readonly string[],
    call: { model: ImageModel; quality: ImageQuality },
    lines?: ReadonlyMap<string, string>,
  ): SheetPlan[] {
    const world = this.o.session.world;
    const s = this.settings;
    const [w, h] = SHEET_SIZE.split('x').map(Number) as [number, number];
    return splitSheets(entityIds).map((ids, index) => {
      const layout = sheetLayout(ids.length, { w, h });
      const defaults = sheetLines(world, ids, layout);
      const items = ids.map((entityId, i) => ({
        entityId,
        name: world.entities[entityId]?.name ?? entityId,
        line: lines?.get(entityId) ?? defaults[i] ?? entityId,
      }));
      const prompt = sheetPromptWithLines(
        world,
        ids,
        layout,
        items.map((i) => i.line),
      );
      return {
        index,
        cols: layout.cols,
        rows: layout.rows,
        size: SHEET_SIZE,
        items,
        estimateUsd: nanosToUsd(
          estimateNanos(s, {
            ...call,
            size: SHEET_SIZE,
            promptChars: prompt.length,
            reference: true,
          }),
        ),
      };
    });
  }

  async sheetRun(
    req: SheetRunRequest,
    onProgress?: (p: BatchProgress) => void,
  ): Promise<SheetRunResult> {
    const r = SheetRunRequestSchema.parse(req);
    const s = this.settings;
    const call = resolveCall(s, 'icon', { ...r, size: SHEET_SIZE });
    const ac = new AbortController();
    this.controllers.get(r.batchId)?.abort();
    this.controllers.set(r.batchId, ac);
    const lines = new Map(r.items.map((i) => [i.entityId, i.line]));
    const ids = [...new Set(r.items.map((i) => i.entityId))];
    const plans = this.planSheets(ids, call, lines);
    const sheets: SheetOutcome[] = [];
    let cost = 0;
    const progress = (running: string[]): void =>
      onProgress?.({
        batchId: r.batchId,
        total: plans.length,
        done: sheets.length,
        running,
        costUsd: cost,
      });
    try {
      // Sheets run one at a time: each is up to 100 icons already.
      for (const plan of plans) {
        const entityIds = plan.items.map((i) => i.entityId);
        const paused = this.o.provider ? this.pauseReason(this.settings) : undefined;
        let out: SheetOutcome;
        if (ac.signal.aborted)
          out = {
            ok: false,
            error: { code: 'cancelled', message: 'the batch was cancelled', unknownOutcome: false },
            entityIds,
          };
        else if (paused)
          out = {
            ok: false,
            error: { code: 'budget', message: paused, unknownOutcome: false },
            entityIds,
          };
        else {
          progress(entityIds);
          out = await this.oneSheet(plan, call, ac.signal, r.batchId);
        }
        cost += out.receipt?.costUsd ?? 0;
        sheets.push(out);
        progress([]);
      }
    } finally {
      if (this.controllers.get(r.batchId) === ac) this.controllers.delete(r.batchId);
    }
    return { batchId: r.batchId, sheets, costUsd: cost, cancelled: ac.signal.aborted };
  }

  private async oneSheet(
    plan: SheetPlan,
    call: { model: ImageModel; quality: ImageQuality; size: ImageSize },
    signal: AbortSignal,
    batchId: string,
  ): Promise<SheetOutcome> {
    const world = this.o.session.world;
    const entityIds = plan.items.map((i) => i.entityId);
    const missing = entityIds.find((id) => !has(world.entities, id));
    const failed = (error: ImageError, receipt?: ImageReceipt): SheetOutcome => ({
      ok: false,
      error,
      ...(receipt ? { receipt } : {}),
      entityIds,
    });
    if (!this.o.provider)
      return failed({
        code: 'disabled',
        message: this.o.offReason ?? 'Images are off',
        unknownOutcome: false,
      });
    if (missing)
      return failed({
        code: 'not_found',
        message: `no entity "${missing}"`,
        unknownOutcome: false,
      });
    const [w, h] = plan.size.split('x').map(Number) as [number, number];
    const layout = sheetLayout(plan.items.length, { w, h }, { cols: plan.cols, rows: plan.rows });
    const prompt = sheetPromptWithLines(
      world,
      entityIds,
      layout,
      plan.items.map((i) => i.line),
    );
    const owner = entityIds[0] as string;
    const receipt: ImageReceipt = {
      entity: owner,
      kind: 'sheet',
      prompt,
      attempts: [],
      costUsd: 0,
    };
    if (SECRET.test(prompt))
      return failed(
        {
          code: 'bad_request',
          message: 'a line contains something shaped like an API key',
          unknownOutcome: false,
        },
        receipt,
      );
    // The guide (faint cell boxes) goes with the prompt as the reference image.
    const guide = encodePng(drawGuide(layout));
    const { response, error } = await this.paidCall(
      receipt,
      call,
      prompt,
      'transparent',
      guide,
      signal,
    );
    const finish = (out: SheetOutcome): SheetOutcome => {
      this.logCall(
        receipt,
        out.ok ? { ok: true, image: out.review.sheet.id } : { ok: false, error: out.error },
        call,
        true,
        batchId,
      );
      this.emit();
      return out;
    };
    if (!response)
      return finish(
        failed(error ?? { code: 'unknown', message: 'no response', unknownOutcome: true }, receipt),
      );
    let decoded: Rgba;
    try {
      if (!isPng(response.png)) throw new Error('not a PNG');
      decoded = decodePng(response.png);
    } catch (e) {
      return finish(
        failed(
          {
            code: 'invalid_output',
            message: `the sheet couldn't be read (${e instanceof Error ? e.message : 'bad bytes'})`,
            unknownOutcome: false,
          },
          receipt,
        ),
      );
    }
    const id = ulid(this.now().getTime());
    const usage = response.usage;
    const meta: ImageMeta = {
      id,
      entity: owner,
      kind: 'sheet',
      origin:
        this.o.provider.name === 'fake'
          ? { by: 'fake', prompt, size: call.size }
          : {
              by: 'openai',
              model: call.model,
              quality: call.quality,
              size: call.size,
              prompt,
              ...(response.requestId ? { requestId: response.requestId } : {}),
            },
      usage: {
        ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
        ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
        images: 1,
      },
      costUsd: receipt.costUsd,
      created: this.now().toISOString(),
      width: decoded.width,
      height: decoded.height,
      hashes: { output: sha256(response.png) },
      sheet: {
        cols: layout.cols,
        rows: layout.rows,
        gutter: layout.gutter,
        canvas: layout.canvas,
        cells: entityIds.map((entity, index) => ({ index, entity })),
      },
    };
    receipt.image = id;
    const added = await this.addToWorld(meta, response.png, undefined, false);
    if (!added.ok) return finish(failed(added.error, receipt));
    return finish({ ok: true, review: this.review(meta, decoded), receipt });
  }

  /** Crops and filters every cell of a sheet, for the review. Pure work; no call. */
  private review(meta: ImageMeta, sheet: Rgba): SheetReview {
    const grid = meta.sheet;
    if (!grid) throw new Error('not a sheet');
    const layout = sheetLayout(grid.cells.length, grid.canvas, {
      cols: grid.cols,
      rows: grid.rows,
      gutter: grid.gutter,
    });
    const cells = cropSheet(sheet, layout);
    const small = (img: Rgba, max: number): { dataUrl: string; width: number; height: number } => {
      const d = downscale(img, max);
      return { dataUrl: dataUrl(encodePng(d)), width: d.width, height: d.height };
    };
    return {
      sheet: meta,
      preview: small(sheet, 1024),
      cells: cells.map((c) => {
        const cell = layout.cells[c.index] as SheetCell;
        const icon = c.crop
          ? filterImage(c.crop, { target: { w: ICON_PX, h: ICON_PX }, preset: 'item' }).image
          : null;
        return {
          index: c.index,
          entityId: grid.cells[c.index]?.entity ?? '',
          row: cell.row,
          col: cell.col,
          flags: c.flags,
          crop: c.crop ? small(c.crop, 128) : null,
          icon: icon
            ? { dataUrl: dataUrl(encodePng(icon)), width: ICON_PX, height: ICON_PX }
            : null,
        };
      }),
    };
  }

  private sheetMeta(entityId: string, imageId: string): ImageMeta | undefined {
    const m = this.o.session.world.images?.[entityId]?.all.find((x) => x.id === imageId);
    return m?.kind === 'sheet' ? m : undefined;
  }

  async sheetCrop(req: SheetCropRequest): Promise<SheetReview | null> {
    const r = SheetCropRequestSchema.parse(req);
    const meta = this.sheetMeta(r.entityId, r.imageId);
    if (!meta) return null;
    const bytes = await this.readPng(r.entityId, r.imageId, 'png');
    if (!bytes) return null;
    try {
      return this.review(meta, decodePng(bytes));
    } catch {
      return null;
    }
  }

  async sheetAccept(req: SheetAcceptRequest): Promise<SheetAcceptResult> {
    const r = SheetAcceptRequestSchema.parse(req);
    const no = (code: ImageErrorCode, message: string): SheetAcceptResult => ({
      ok: false,
      error: { code, message, unknownOutcome: false },
    });
    const meta = this.sheetMeta(r.entityId, r.imageId);
    const grid = meta?.sheet;
    if (!meta || !grid) return no('not_found', `no sheet "${r.imageId}" for "${r.entityId}"`);
    const bytes = await this.readPng(r.entityId, r.imageId, 'png');
    if (!bytes) return no('not_found', "the sheet's file is missing");
    let sheet: Rgba;
    try {
      sheet = decodePng(bytes);
    } catch {
      return no('invalid_output', "the sheet couldn't be read");
    }
    const layout = sheetLayout(grid.cells.length, grid.canvas, {
      cols: grid.cols,
      rows: grid.rows,
      gutter: grid.gutter,
    });
    const cropped = cropSheet(sheet, layout);
    const world = this.o.session.world;
    const images: ImageMeta[] = [];
    const files: { meta: ImageMeta; png: Uint8Array; src: Uint8Array }[] = [];
    for (const index of [...new Set(r.cells)].sort((a, b) => a - b)) {
      const c = cropped[index];
      const entity = grid.cells[index]?.entity;
      if (!c || !entity) return no('bad_request', `the sheet has no cell ${index}`);
      if (!c.crop) return no('bad_request', `cell ${index} is empty`);
      if (!has(world.entities, entity))
        return no('not_found', `no entity "${entity}" (cell ${index})`);
      const src = encodePng(c.crop);
      const png = encodePng(
        filterImage(c.crop, { target: { w: ICON_PX, h: ICON_PX }, preset: 'item' }).image,
      );
      const m: ImageMeta = {
        id: ulid(this.now().getTime()),
        entity,
        kind: 'icon',
        origin: { by: 'sheet', sheet: meta.id, cell: index, preset: 'item' },
        created: this.now().toISOString(),
        width: ICON_PX,
        height: ICON_PX,
        hashes: { output: sha256(png), source: sha256(src) },
      };
      images.push(m);
      files.push({ meta: m, png, src });
    }
    // Files first (atomic each), then one transaction: one undo step for the whole review.
    try {
      await ensureGitAttributes(this.o.session.dir);
      for (const f of files) {
        const p = imagePaths(f.meta.entity, f.meta.id);
        await mkdir(path.join(this.o.session.dir, 'images', f.meta.entity), { recursive: true });
        await writeFileAtomic(path.join(this.o.session.dir, p.src), f.src);
        await writeFileAtomic(path.join(this.o.session.dir, p.png), f.png);
      }
    } catch (e) {
      return no('io', `the icons couldn't be saved: ${e instanceof Error ? e.message : String(e)}`);
    }
    const d = this.o.session.dispatch(
      images.map((image) => cmd('image.add', { image, select: r.select })),
      `Accept ${images.length} icon${images.length === 1 ? '' : 's'}`,
    );
    if (!d.ok) return no('io', d.error.message);
    return { ok: true, images };
  }

  // ── files ──────────────────────────────────────────────────────────────

  /** An image as a data URL (`thumb`: at most 256px, cached). Null when the file is missing. */
  async file(
    entity: string,
    imageId: string,
    variant: 'png' | 'src' | 'thumb',
  ): Promise<{ dataUrl: string; width: number; height: number } | null> {
    if (variant === 'thumb') {
      const key = `${entity}/${imageId}`;
      const hit = this.thumbs.get(key);
      if (hit) return hit;
      const bytes = await this.readPng(entity, imageId, 'png');
      if (!bytes) return null;
      try {
        const img = decodePng(bytes);
        const small = downscale(img, 256);
        const out = {
          dataUrl: dataUrl(small === img ? bytes : encodePng(small)),
          width: small.width,
          height: small.height,
        };
        if (this.thumbs.size > 2_000) this.thumbs.clear();
        this.thumbs.set(key, out);
        return out;
      } catch {
        return null;
      }
    }
    const bytes = await this.readPng(entity, imageId, variant);
    if (!bytes) return null;
    try {
      const img = decodePng(bytes);
      return { dataUrl: dataUrl(bytes), width: img.width, height: img.height };
    } catch {
      return null;
    }
  }

  /**
   * "Delete image files": removes the files of every image that is no longer
   * in the world (removed, or of a deleted entity), for one entity or all.
   * Images still in the world are never touched. Undoing a removal after
   * this brings the metadata back without its pixels (`images:file` → null).
   */
  async deleteFiles(entityId?: string): Promise<{ removed: number; bytes: number }> {
    const root = path.join(this.o.session.dir, 'images');
    const world = this.o.session.world;
    let entities: string[];
    try {
      entities = entityId ? [entityId] : await readdir(root);
    } catch {
      return { removed: 0, bytes: 0 };
    }
    let removed = 0;
    let bytes = 0;
    // Images of entities that no longer exist leave the world first (one undo step).
    const orphans = Object.entries(world.images ?? {})
      .filter(([e]) => !has(world.entities, e) && (!entityId || e === entityId))
      .flatMap(([e, imgs]) => imgs.all.map((m) => cmd('image.remove', { entity: e, image: m.id })));
    if (orphans.length > 0) this.o.session.dispatch(orphans, 'Delete image files');
    const after = this.o.session.world;
    for (const e of entities) {
      if (e.startsWith('.')) continue;
      const keep = new Set((after.images?.[e]?.all ?? []).map((m) => m.id));
      const folder = path.join(root, e);
      let names: string[];
      try {
        names = await readdir(folder);
      } catch {
        continue;
      }
      for (const n of names) {
        const m = /^([0-9A-HJKMNP-TV-Z]{26})(?:\.src)?\.(png|json)$/.exec(n);
        if (!m || keep.has(m[1] as string)) continue;
        // A .json of a removed image is the store's to remove; only the pixels are purged here.
        if (m[2] === 'json') continue;
        try {
          const st = await stat(path.join(folder, n));
          await rm(path.join(folder, n));
          removed++;
          bytes += st.size;
          this.thumbs.delete(`${e}/${m[1]}`);
        } catch {
          // Already gone.
        }
      }
      try {
        if ((await readdir(folder)).length === 0) await rm(folder, { recursive: true });
      } catch {
        // Not empty, or gone.
      }
    }
    return { removed, bytes };
  }

  async flush(): Promise<void> {
    await this.log$.flush();
  }
}

export type { ImageKind };
