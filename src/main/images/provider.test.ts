import { readFileSync } from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { costNanos, DEFAULT_IMAGE_PRICING } from '@core/images/pricing';
import { filterImage } from './pixel';
import { decodePng } from './png';
import { classifyOpenAiError, OpenAiImageProvider, ProviderError, usageFrom } from './provider';

/**
 * The OpenAI provider through the real SDK over a stubbed `fetch`, answering
 * with the PNGs and usage recorded from real calls (fixtures/images/,
 * `npm run smoke:images`), and with every error shape. Never the network.
 */
const FIX = path.resolve(import.meta.dirname, '../../../fixtures/images');

interface Recorded {
  name: string;
  kind: 'icon' | 'concept';
  attempts: {
    usage: {
      inputTokens: number;
      outputTokens: number;
      inputTextTokens: number;
      inputImageTokens: number;
    };
    costUsd: number;
    size: string;
    model: string;
    requestId: string;
  }[];
}
const calls = JSON.parse(readFileSync(path.join(FIX, 'calls.json'), 'utf8')) as Recorded[];
const recorded = (name: string): Recorded => {
  const r = calls.find((c) => c.name === name);
  if (!r) throw new Error(`no fixture ${name}`);
  return r;
};
const providerPng = (r: Recorded): Buffer =>
  readFileSync(path.join(FIX, r.kind === 'icon' ? `${r.name}.src.png` : `${r.name}.png`));

interface Seen {
  url: string;
  method: string;
  body: unknown;
  contentType: string;
}

function client(answer: (seen: Seen) => Response | Promise<Response>, timeout = 5_000) {
  const seen: Seen[] = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    // The SDK probes multipart support with a data: URL; let the platform answer that.
    if (String(url).startsWith('data:')) return globalThis.fetch(url, init);
    const headers = new Headers(init?.headers);
    const ct = headers.get('content-type') ?? '';
    let body: unknown = init?.body;
    if (typeof body === 'string' && ct.includes('json')) body = JSON.parse(body);
    else if (init?.body instanceof FormData) {
      const form = init.body;
      body = Object.fromEntries([...new Set(form.keys())].map((k) => [k, form.getAll(k)]));
    }
    const s = { url: String(url), method: init?.method ?? 'GET', body, contentType: ct };
    seen.push(s);
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    // Like the platform's fetch: an abort (the SDK's timeout, or the caller's) rejects at once.
    return new Promise<Response>((resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
        once: true,
      });
      Promise.resolve()
        .then(() => answer(s))
        .then(resolve, reject);
    });
  };
  return {
    seen,
    sdk: new OpenAI({
      apiKey: 'sk-test-not-a-key',
      baseURL: 'https://api.openai.com/v1',
      fetch,
      maxRetries: 0,
      timeout,
    }),
  };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-request-id': 'req_test', ...headers },
  });

const okFrom = (r: Recorded): Response => {
  const a = r.attempts[0]!;
  return json(200, {
    created: 1,
    data: [{ b64_json: providerPng(r).toString('base64') }],
    usage: {
      input_tokens: a.usage.inputTokens,
      output_tokens: a.usage.outputTokens,
      total_tokens: a.usage.inputTokens + a.usage.outputTokens,
      input_tokens_details: {
        text_tokens: a.usage.inputTextTokens,
        image_tokens: a.usage.inputImageTokens,
      },
    },
  });
};

const req = {
  model: 'gpt-image-2.6-flare',
  quality: 'low',
  size: '1024x1024',
  prompt: 'A lantern icon',
  background: 'transparent' as const,
};

describe('the OpenAI provider (recorded responses)', () => {
  it('generate: the request shape, and the recorded image and usage come back', async () => {
    const r = recorded('cloud-anklet-icon-flare');
    const c = client(() => okFrom(r));
    const out = await new OpenAiImageProvider(c.sdk).generate(req);
    expect(c.seen[0]).toMatchObject({
      url: 'https://api.openai.com/v1/images/generations',
      method: 'POST',
    });
    expect(c.seen[0]?.body).toEqual({
      model: 'gpt-image-2.6-flare',
      prompt: 'A lantern icon',
      size: '1024x1024',
      quality: 'low',
      background: 'transparent',
      output_format: 'png',
      n: 1,
    });
    expect(Buffer.from(out.png).equals(providerPng(r))).toBe(true);
    expect(out.usage).toEqual(r.attempts[0]?.usage);
    expect(out.requestId).toBe('req_test');
    // The recorded cost is exactly what the pricing table gives for the recorded usage.
    expect(costNanos(DEFAULT_IMAGE_PRICING['gpt-image-2.6-flare'], out.usage ?? {}) / 1e9).toBe(
      r.attempts[0]?.costUsd,
    );
  });

  it('edit: a multipart request with the reference image', async () => {
    const r = recorded('spore-lantern-icon-edit-flare');
    const c = client(() => okFrom(r));
    const ref = new Uint8Array(providerPng(recorded('spore-lantern-concept-flare')));
    const out = await new OpenAiImageProvider(c.sdk).generate({ ...req, reference: ref });
    expect(c.seen[0]?.url).toBe('https://api.openai.com/v1/images/edits');
    // A FormData body: fetch sets the multipart content type itself.
    expect(c.seen[0]?.body).toHaveProperty('image');
    const body = c.seen[0]?.body as Record<string, unknown[]>;
    expect(body.model).toEqual(['gpt-image-2.6-flare']);
    expect(body.background).toEqual(['transparent']);
    expect((body.image?.[0] as File).size).toBe(ref.length);
    expect(out.usage?.inputImageTokens).toBe(1024);
  });

  it('real outputs: icons arrive with a transparent background; the filter makes a 16×16 with hard alpha', () => {
    for (const r of calls.filter((x) => x.kind === 'icon')) {
      const src = decodePng(providerPng(r));
      let clear = 0;
      for (let i = 3; i < src.data.length; i += 4) if ((src.data[i] as number) < 16) clear++;
      expect(clear / (src.width * src.height)).toBeGreaterThan(0.2);
      const icon = filterImage(src, { target: 16, preset: 'item' });
      expect([icon.width, icon.height]).toEqual([16, 16]);
      let opaque = 0;
      for (let i = 3; i < icon.data.length; i += 4) {
        expect([0, 255]).toContain(icon.data[i]);
        if (icon.data[i] === 255) opaque++;
      }
      expect(opaque).toBeGreaterThan(40);
    }
    for (const r of calls.filter((x) => x.kind === 'concept')) {
      const img = decodePng(providerPng(r));
      expect(`${img.width}x${img.height}`).toBe(r.attempts[0]?.size);
    }
  });
});

describe('the OpenAI provider (errors)', () => {
  const fail = async (
    answer: () => Response | Promise<Response>,
    timeout?: number,
  ): Promise<ProviderError> => {
    const c = client(answer, timeout);
    try {
      await new OpenAiImageProvider(c.sdk, timeout).generate(req);
    } catch (e) {
      expect(c.seen).toHaveLength(1); // the SDK never retries
      return e as ProviderError;
    }
    throw new Error('expected a failure');
  };

  it('429 → rate_limited with retry-after, known outcome', async () => {
    const e = await fail(() =>
      json(429, { error: { message: 'slow down', type: 'requests' } }, { 'retry-after': '7' }),
    );
    expect(e.error).toEqual({
      code: 'rate_limited',
      message: expect.any(String) as string,
      unknownOutcome: false,
    });
    expect(e.retryAfter).toBe(7);
    expect(e.httpStatus).toBe(429);
  });

  it('5xx → server', async () => {
    for (const status of [500, 502, 503]) {
      const e = await fail(() =>
        json(status, { error: { message: 'oops', type: 'server_error' } }),
      );
      expect(e.error.code).toBe('server');
      expect(e.httpStatus).toBe(status);
    }
  });

  it('a content-policy refusal → refused (moderation_blocked, or a safety message)', async () => {
    const a = await fail(() =>
      json(400, {
        error: {
          message: 'Your request was rejected as a result of our safety system.',
          type: 'image_generation_user_error',
          code: 'moderation_blocked',
        },
      }),
    );
    expect(a.error.code).toBe('refused');
    const b = await fail(() =>
      json(400, {
        error: { message: 'rejected by the safety system', type: 'invalid_request_error' },
      }),
    );
    expect(b.error.code).toBe('refused');
    const c = await fail(() =>
      json(400, {
        error: { message: 'Invalid size', type: 'invalid_request_error', param: 'size' },
      }),
    );
    expect(c.error.code).toBe('bad_request');
  });

  it('401 and 403 → no_key', async () => {
    expect((await fail(() => json(401, { error: { message: 'bad key' } }))).error.code).toBe(
      'no_key',
    );
    expect(
      (await fail(() => json(403, { error: { message: 'no access to model' } }))).error.code,
    ).toBe('no_key');
  });

  it('a timeout → timeout with an unknown outcome (it may be charged)', async () => {
    const e = await fail(() => new Promise<Response>(() => undefined), 50);
    expect(e.error).toMatchObject({ code: 'timeout', unknownOutcome: true });
  });

  it('a refused connection was never sent; a reset one may have been', async () => {
    const refused = await fail(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });
    expect(refused.error).toMatchObject({ code: 'network', unknownOutcome: false });
    const reset = await fail(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    expect(reset.error).toMatchObject({ code: 'network', unknownOutcome: true });
  });

  it('no image in a 200 → invalid_output', async () => {
    const e = await fail(() => json(200, { created: 1, data: [] }));
    expect(e.error.code).toBe('invalid_output');
  });

  it('an abort after sending is cancelled with an unknown outcome; before sending, a known one', async () => {
    const ac = new AbortController();
    const c = client(
      () =>
        new Promise<Response>((_r, reject) => {
          ac.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const p = new OpenAiImageProvider(c.sdk).generate({ ...req, signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    const e = (await p.catch((x: unknown) => x)) as ProviderError;
    expect(e.error).toMatchObject({ code: 'cancelled', unknownOutcome: true });
    const pre = new AbortController();
    pre.abort();
    const e2 = (await new OpenAiImageProvider(client(() => json(200, {})).sdk)
      .generate({ ...req, signal: pre.signal })
      .catch((x: unknown) => x)) as ProviderError;
    expect(e2.error).toMatchObject({ code: 'cancelled', unknownOutcome: false });
  });

  it('usage without details, and no usage at all', () => {
    expect(usageFrom({ input_tokens: 10, output_tokens: 20 })).toEqual({
      inputTokens: 10,
      outputTokens: 20,
    });
    expect(usageFrom(undefined)).toBeUndefined();
    expect(classifyOpenAiError(new Error('weird'), true).error).toMatchObject({
      code: 'unknown',
      unknownOutcome: true,
    });
  });
});
