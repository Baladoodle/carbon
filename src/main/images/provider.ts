import type OpenAI from 'openai';
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
  toFile,
} from 'openai';
import type { ImageError, ImageErrorCode } from '@core/images/gateway';
import type { ImageQuality } from '@core/images/model';
import { OUTPUT_TOKENS, REFERENCE_IMAGE_TOKENS } from '@core/images/pricing';
import { createHash } from 'node:crypto';
import { sheetLayout } from './pixel';
import { encodePng, type Rgba } from './png';

/**
 * Image providers (docs/IMAGES.md §4). One call in, one PNG out, or a typed
 * error. Providers never retry: the gateway decides, and it never retries a
 * call whose outcome is unknown (Genforge's rule).
 */

export interface ProviderRequest {
  model: string;
  quality: string;
  size: string;
  prompt: string;
  /** Icons ask for a transparent background. */
  background: 'transparent' | 'auto';
  /** PNG bytes of a reference image: the call becomes an edit. */
  reference?: Uint8Array;
  signal?: AbortSignal;
}

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  inputTextTokens?: number;
  inputImageTokens?: number;
}

export interface ProviderResponse {
  png: Uint8Array;
  usage?: ProviderUsage;
  requestId?: string;
}

/** A failed call: the typed error, plus what the HTTP layer said. */
export class ProviderError extends Error {
  constructor(
    readonly error: ImageError,
    readonly httpStatus?: number,
    readonly requestId?: string,
    /** Seconds the server asked us to wait (429). */
    readonly retryAfter?: number,
  ) {
    super(error.message);
    this.name = 'ProviderError';
  }
}

export interface ImageProvider {
  readonly name: 'openai' | 'fake';
  generate(req: ProviderRequest): Promise<ProviderResponse>;
}

const imageError = (code: ImageErrorCode, message: string, unknownOutcome = false): ImageError => ({
  code,
  message,
  unknownOutcome,
});

/** Connection errors where the request certainly never reached the server. */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH']);

function causeCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur && typeof cur === 'object'; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && NOT_SENT.has(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

/** A content-policy refusal: OpenAI answers 400 with `moderation_blocked` or a safety message. */
export function isRefusal(e: APIError): boolean {
  const code = (e.code ?? '').toLowerCase();
  const body = JSON.stringify(e.error ?? {}).toLowerCase();
  return (
    code === 'moderation_blocked' ||
    code === 'content_policy_violation' ||
    body.includes('moderation_blocked') ||
    body.includes('safety system') ||
    body.includes('content policy')
  );
}

/**
 * Maps an SDK error (most specific class first) to a typed error. Anything
 * that may have reached OpenAI without an answer (a timeout, a dropped
 * connection, an abort after sending) is `unknownOutcome`.
 */
export function classifyOpenAiError(e: unknown, sent: boolean): ProviderError {
  if (e instanceof ProviderError) return e;
  if (e instanceof APIUserAbortError || (e instanceof Error && e.name === 'AbortError'))
    return new ProviderError(
      imageError(
        'cancelled',
        sent ? 'cancelled after the request was sent: it may still be charged' : 'cancelled',
        sent,
      ),
    );
  if (e instanceof APIConnectionTimeoutError)
    return new ProviderError(
      imageError('timeout', 'OpenAI did not answer in time; the call may still be charged', true),
    );
  if (e instanceof APIConnectionError) {
    const notSent = causeCode(e);
    return new ProviderError(
      imageError(
        'network',
        notSent
          ? `could not reach OpenAI (${notSent})`
          : 'the connection to OpenAI failed; the call may still be charged',
        !notSent,
      ),
    );
  }
  if (e instanceof APIError) {
    const rid = e.requestID ?? undefined;
    const status = typeof e.status === 'number' ? e.status : undefined;
    const msg = (e.message || 'OpenAI error').slice(0, 500);
    if (e instanceof RateLimitError) {
      const ra = Number(e.headers.get('retry-after') ?? '');
      return new ProviderError(
        imageError('rate_limited', msg),
        429,
        rid,
        Number.isFinite(ra) ? ra : undefined,
      );
    }
    if (e instanceof AuthenticationError || e instanceof PermissionDeniedError)
      return new ProviderError(imageError('no_key', msg), status, rid);
    if (e instanceof BadRequestError)
      return new ProviderError(imageError(isRefusal(e) ? 'refused' : 'bad_request', msg), 400, rid);
    if (e instanceof InternalServerError || (status !== undefined && status >= 500))
      return new ProviderError(imageError('server', msg), status, rid);
    if (status !== undefined && status >= 400 && status < 500)
      return new ProviderError(
        imageError(isRefusal(e as APIError) ? 'refused' : 'bad_request', msg),
        status,
        rid,
      );
    return new ProviderError(imageError('unknown', msg, sent), status, rid);
  }
  return new ProviderError(
    imageError('unknown', e instanceof Error ? e.message.slice(0, 500) : String(e), sent),
  );
}

interface OpenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number };
}

export function usageFrom(u: OpenAiUsage | undefined | null): ProviderUsage | undefined {
  if (!u) return undefined;
  const out: ProviderUsage = {};
  if (typeof u.input_tokens === 'number') out.inputTokens = u.input_tokens;
  if (typeof u.output_tokens === 'number') out.outputTokens = u.output_tokens;
  const d = u.input_tokens_details;
  if (typeof d?.text_tokens === 'number') out.inputTextTokens = d.text_tokens;
  if (typeof d?.image_tokens === 'number') out.inputImageTokens = d.image_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * OpenAI's Images API through the official SDK: `images.generate`, or
 * `images.edit` with the reference image. PNG output; a transparent
 * background for icons. The SDK's own retries are off.
 */
export class OpenAiImageProvider implements ImageProvider {
  readonly name = 'openai' as const;

  constructor(
    private readonly client: OpenAI,
    private readonly timeoutMs = 180_000,
  ) {}

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    if (req.signal?.aborted) throw new ProviderError(imageError('cancelled', 'cancelled', false));
    const common = {
      model: req.model,
      prompt: req.prompt,
      size: req.size as '1024x1024',
      quality: req.quality as 'low',
      background: req.background,
      output_format: 'png' as const,
      n: 1,
    };
    const opts = {
      timeout: this.timeoutMs,
      maxRetries: 0,
      ...(req.signal ? { signal: req.signal } : {}),
    };
    let sent = false;
    try {
      sent = true;
      const { data, request_id } = req.reference
        ? await this.client.images
            .edit(
              {
                ...common,
                image: await toFile(req.reference, 'reference.png', { type: 'image/png' }),
              },
              opts,
            )
            .withResponse()
        : await this.client.images.generate(common, opts).withResponse();
      const b64 = data.data?.[0]?.b64_json;
      if (!b64)
        throw new ProviderError(
          imageError('invalid_output', 'OpenAI returned no image'),
          200,
          request_id ?? undefined,
        );
      const usage = usageFrom(data.usage);
      return {
        png: new Uint8Array(Buffer.from(b64, 'base64')),
        ...(usage ? { usage } : {}),
        ...(request_id ? { requestId: request_id } : {}),
      };
    } catch (e) {
      throw classifyOpenAiError(e, sent);
    }
  }
}

/**
 * A deterministic icon sheet for a sheet prompt ("A sprite sheet of N … on a
 * C×R grid"): one disc per cell on transparency, coloured by the cell's line,
 * so cropping and review run on something sheet-shaped.
 */
export function fakeSheet(prompt: string, size: string): Rgba | null {
  const m = /A sprite sheet of (\d+) .*? on a (\d+)×(\d+) grid/.exec(prompt);
  if (!m) return null;
  const n = Number(m[1]);
  const cols = Number(m[2]);
  const rows = Number(m[3]);
  const [w0, h0] = size.split('x').map(Number);
  const W = Math.max(64, Math.round((w0 ?? 1024) / 8));
  const H = Math.max(64, Math.round((h0 ?? 1024) / 8));
  const layout = sheetLayout(n, { w: W, h: H }, { cols, rows });
  const lines = prompt.split('\n').filter((l) => /^row \d+, col \d+: /.test(l));
  const data = new Uint8ClampedArray(W * H * 4);
  for (const cell of layout.cells) {
    const hex = createHash('sha256')
      .update(lines[cell.index] ?? String(cell.index))
      .digest();
    const cx = cell.x + cell.w / 2;
    const cy = cell.y + cell.h / 2;
    const r = Math.min(cell.w, cell.h) * 0.32;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++)
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r || x < 0 || y < 0 || x >= W || y >= H) continue;
        const o = (y * W + x) * 4;
        data[o] = hex[0] as number;
        data[o + 1] = hex[1] as number;
        data[o + 2] = hex[2] as number;
        data[o + 3] = 255;
      }
  }
  return { width: W, height: H, data };
}

/** A deterministic picture for a prompt: a two-colour gradient with a disc, or a silhouette on transparency for icons. */
export function fakePicture(prompt: string, size: string, transparent: boolean): Rgba {
  const [w0, h0] = size.split('x').map(Number);
  // Small, so tests stay fast; the size is only recorded.
  const w = Math.max(16, Math.round((w0 ?? 1024) / 16));
  const h = Math.max(16, Math.round((h0 ?? 1024) / 16));
  const hex = createHash('sha256').update(prompt).digest('hex');
  const n = (i: number): number => parseInt(hex.slice(i * 2, i * 2 + 2) || '80', 16);
  const a = [n(0), n(1), n(2)];
  const b = [n(3), n(4), n(5)];
  const c = [255 - n(6), 255 - n(7), 255 - n(8)];
  const data = new Uint8ClampedArray(w * h * 4);
  const cx = w * (0.3 + (n(9) / 255) * 0.4);
  const cy = h * (0.3 + (n(10) / 255) * 0.4);
  const r = Math.min(w, h) * (0.2 + (n(11) / 255) * 0.15);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const t = (x + y) / (w + h);
      const o = (y * w + x) * 4;
      const inDisc = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      const col = inDisc ? c : a.map((v, i) => v * (1 - t) + (b[i] as number) * t);
      data[o] = col[0] as number;
      data[o + 1] = col[1] as number;
      data[o + 2] = col[2] as number;
      data[o + 3] = transparent && !inDisc ? 0 : 255;
    }
  return { width: w, height: h, data };
}

export interface FakeProviderOptions {
  delayMs?: number;
  /** Every call fails with this code (to see error UI). */
  failWith?: ImageErrorCode;
}

/**
 * The deterministic provider behind `CARBON_IMAGES=fake` and every test: the
 * same prompt and size give the same PNG, with usage shaped like OpenAI's
 * (output tokens by quality), so costs, the budget and the log behave as in
 * the real thing.
 */
export class FakeImageProvider implements ImageProvider {
  readonly name = 'fake' as const;
  calls = 0;

  constructor(private readonly opts: FakeProviderOptions = {}) {}

  async generate(req: ProviderRequest): Promise<ProviderResponse> {
    this.calls++;
    if (this.opts.delayMs)
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        req.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(new ProviderError(imageError('cancelled', 'cancelled', false)));
          },
          { once: true },
        );
      });
    if (req.signal?.aborted) throw new ProviderError(imageError('cancelled', 'cancelled', false));
    if (this.opts.failWith)
      throw new ProviderError(
        imageError(
          this.opts.failWith,
          `fake failure: ${this.opts.failWith}`,
          this.opts.failWith === 'timeout',
        ),
        this.opts.failWith === 'rate_limited' ? 429 : undefined,
      );
    const sheet = fakeSheet(req.prompt, req.size);
    const png = sheet
      ? encodePng(sheet)
      : encodePng(
          fakePicture(
            req.prompt + (req.reference ? ':edit' : ''),
            req.size,
            req.background === 'transparent',
          ),
        );
    const table = OUTPUT_TOKENS[req.quality as ImageQuality] as Record<string, number> | undefined;
    const out = table?.[req.size] ?? OUTPUT_TOKENS.low['1024x1024'];
    const text = Math.max(1, Math.ceil(req.prompt.length / 4));
    const image = req.reference ? REFERENCE_IMAGE_TOKENS : 0;
    return {
      png,
      usage: {
        inputTokens: text + image,
        inputTextTokens: text,
        inputImageTokens: image,
        outputTokens: out,
      },
      requestId: `fake_${createHash('sha256').update(req.prompt).digest('hex').slice(0, 12)}`,
    };
  }
}
