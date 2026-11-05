import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Moment, MomentRequest } from '@core/ai/moments';
import { sampleWorld } from '@core/testing/sample';
import type { World } from '@core/model/world';
import { FixtureFetch, fixtureClient, replyJson, replyStream, type Responder } from './fixtures';
import { ClaudeAiGateway } from './gateway';
import { MODEL } from './settings';

/**
 * Gateway hardening (review-b). Each block here was a real defect, shown
 * failing before its fix.
 */

const instant = (): Promise<void> => Promise.resolve();

function setup(responders: Responder[] = [], world: World = sampleWorld()) {
  const f = new FixtureFetch(responders);
  let w = world;
  const g = new ClaudeAiGateway({
    getWorld: () => w,
    client: fixtureClient(f),
    sleep: () => instant(),
    random: () => 0.5,
    now: () => new Date('2026-11-04T10:00:00.000Z'),
  });
  return { f, g, setWorld: (x: World) => (w = x) };
}

const ok = (result: unknown, usage?: { input_tokens: number; output_tokens: number }): Response =>
  replyJson({ text: JSON.stringify(result), ...(usage ? { usage } : {}) });

const critique = (id = 'glide'): MomentRequest<'critique'> => ({
  entityId: id,
  trigger: 'on_demand',
});

/** A stream that starts, writes `text`, then fails with an SSE `error` event (no HTTP status). */
function failingStream(text: string, type: string, message: string): Response {
  const enc = new TextEncoder();
  const ev = (name: string, data: unknown): Uint8Array =>
    enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(
        ev('message_start', {
          type: 'message_start',
          message: {
            id: 'm',
            type: 'message',
            role: 'assistant',
            model: MODEL,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 1 },
          },
        }),
      );
      c.enqueue(
        ev('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      );
      if (text)
        c.enqueue(
          ev('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          }),
        );
      c.enqueue(ev('error', { type: 'error', error: { type, message } }));
      c.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

const spreadReq: MomentRequest<'spread'> = {
  spot: { type: 'cell', band: 'low-sky', lane: 'items' },
  move: 'fill',
  count: 1,
};

const candidate = {
  kind: 'item',
  name: 'Kite Lung',
  identity: 'Kite Lung changes how you climb.',
  description: '',
  attributes: [],
  relations: [{ type: 'in_band', target: 'low-sky', note: '' }],
  about: null,
  position: { x: 0.2, y: 0.8 },
  wildcard: false,
  rationale: 'fits',
};
const spreadText = JSON.stringify({
  axes: { x: { label: 'a', low: 'l', high: 'h' }, y: { label: 'b', low: 'l', high: 'h' } },
  candidates: [candidate],
});

describe('errors that arrive inside a stream (an SSE error event, no HTTP status)', () => {
  it('overloaded before any candidate is shown: retried as a server error, then succeeds', async () => {
    const { f, g } = setup([
      failingStream('', 'overloaded_error', 'Overloaded'),
      replyStream({ text: spreadText }),
    ]);
    const seen: string[] = [];
    const out = await g.run('spread', spreadReq, { onPartial: (c) => seen.push(c.name) });
    expect(out.ok).toBe(true);
    expect(seen).toEqual(['Kite Lung']);
    expect(f.messages).toHaveLength(2);
    expect((await g.log()).at(-1)).toMatchObject({ attempts: 2, outcome: 'ok' });
  });

  it('overloaded on every attempt: a server error, not "unknown"', async () => {
    const { g } = setup(
      Array.from({ length: 4 }, () => failingStream('', 'overloaded_error', 'Overloaded')),
    );
    const out = await g.run('spread', spreadReq);
    expect(out).toMatchObject({ ok: false, error: { code: 'server', retryable: true } });
  });

  it('rate limited inside a stream: rate_limited', async () => {
    const { g } = setup(
      Array.from({ length: 4 }, () => failingStream('', 'rate_limit_error', 'Slow down')),
    );
    const out = await g.run('spread', spreadReq);
    expect(out).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });

  it('an invalid request inside a stream is not retried', async () => {
    const { f, g } = setup([failingStream('', 'invalid_request_error', 'Bad')]);
    const out = await g.run('spread', spreadReq);
    expect(out).toMatchObject({ ok: false, error: { code: 'bad_request', retryable: false } });
    expect(f.messages).toHaveLength(1);
  });
});

describe('the budget pause is exact', () => {
  it('pauses on the call that reaches the budget, even when float sums fall just short', async () => {
    // Five calls of 6,000 input tokens at $0.10/M are exactly $0.003, but
    // 0.0006 added five times in floating point is 0.0029999999999999996.
    const w = sampleWorld();
    w.settings.ai = { budget: { sessionUsd: 0.003, monthUsd: 20 } };
    const replies = Array.from({ length: 6 }, () =>
      ok({ notes: [] }, { input_tokens: 6_000, output_tokens: 0 }),
    );
    const { f, g } = setup(replies, w);
    const ids = ['glide', 'cinder-wasp', 'spore-lantern', 'cinder-sting', 'moss-grazer'];
    for (const id of ids) expect((await g.run('critique', critique(id))).ok).toBe(true);
    expect(g.status()).toMatchObject({ paused: true, spend: { sessionUsd: 0.003 } });
    expect(await g.run('critique', critique('hollows'))).toMatchObject({
      ok: false,
      error: { code: 'budget' },
    });
    expect(f.messages).toHaveLength(5);
  });

  it('costs add up exactly over many calls', async () => {
    const w = sampleWorld();
    w.settings.ai = { budget: { sessionUsd: 100, monthUsd: 100 } };
    const n = 30;
    const replies = Array.from({ length: n }, () =>
      ok({ notes: [] }, { input_tokens: 1_234, output_tokens: 567 }),
    );
    const { g, setWorld } = setup(replies, w);
    for (let i = 0; i < n; i++) {
      // A changed world each time, so the content-hash cache doesn't answer.
      const next = structuredClone(w);
      next.taste.rules = [{ id: `r${i}`, text: `rule ${i}`, enabled: true }];
      setWorld(next);
      expect((await g.run('critique', critique())).ok).toBe(true);
    }
    // (1,234 × 0.10 + 567 × 0.50) / 1e6 = $0.0004069 per call, exactly.
    expect(g.status().spend.sessionUsd).toBe(0.012207);
  });
});

describe('a request never contains the API key', () => {
  const KEY = 'sk-ant-api03-test-not-a-real-key-0000000000';
  afterEach(() => vi.unstubAllEnvs());

  it('refuses to send a world that holds the key, and logs no request text', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', KEY);
    const w = sampleWorld();
    const glide = w.entities['glide'];
    if (!glide) throw new Error('sample world changed');
    glide.description = `my key is ${KEY}, keep it safe`;
    const { f, g } = setup([ok({ notes: [] })], w);
    const out = await g.run('critique', critique('glide'));
    expect(out).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(out.ok ? '' : out.error.message).not.toContain(KEY);
    expect(f.requests).toHaveLength(0);
    const entry = (await g.log()).at(-1);
    expect(JSON.stringify(entry)).not.toContain(KEY);
    expect(entry && g.request(entry.id)).toBeUndefined();
  });

  it('refuses anything shaped like an Anthropic key, even when no key is set', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    const w = sampleWorld();
    w.taste.rules = [{ id: 'r', text: `use sk-ant-admin01-${'x'.repeat(40)}`, enabled: true }];
    const { f, g } = setup([ok({ notes: [] })], w);
    const out = await g.run('critique', critique('glide'));
    expect(out).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(f.requests).toHaveLength(0);
  });
});

describe('cancellation does not leak', () => {
  it('every listener added to a caller’s signal is removed, whatever the outcome', async () => {
    const ac = new AbortController();
    const added = vi.spyOn(ac.signal, 'addEventListener');
    const removed = vi.spyOn(ac.signal, 'removeEventListener');
    const { g } = setup([
      ok({ notes: [] }),
      new Error('socket hang up'),
      new Error('socket hang up'),
      new Error('socket hang up'),
      new Error('socket hang up'),
      ok({ suggestion: { value: 'Goes dark underwater.', note: 'x' } }),
    ]);
    const moments: [Moment, MomentRequest<Moment>][] = [
      ['critique', critique('glide')],
      ['critique', critique('cinder-wasp')],
      ['suggest_one', { entityId: 'spore-lantern', field: 'tradeoff' }],
      ['critique', { entityId: 'nope', trigger: 'on_demand' }],
    ];
    for (const [m, r] of moments) await g.run(m, r, { signal: ac.signal });
    const mine = (calls: unknown[][]): unknown[] => calls.map((c) => c[1]);
    // The gateway's own abort listeners: added and removed in pairs.
    const a = mine(added.mock.calls).filter((x) => typeof x === 'function');
    const rm = mine(removed.mock.calls).filter((x) => typeof x === 'function');
    for (const fn of a) expect(rm).toContain(fn);
    expect(g.status().pending).toBe(0);
  });

  it('a request superseded while it waits to retry stops at once, and frees its slot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = new FixtureFetch([new Error('reset'), ok({ notes: [] })]);
    const g = new ClaudeAiGateway({
      getWorld: () => sampleWorld(),
      client: fixtureClient(f),
      // Backoff that waits until released or aborted.
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          void gate.then(resolve);
          signal?.addEventListener('abort', () => resolve(), { once: true });
        }),
      random: () => 0.5,
    });
    const stale = g.run('critique', critique('glide'));
    await new Promise((r) => setTimeout(r, 5));
    const fresh = await g.run('critique', critique('glide'));
    expect(await stale).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(fresh.ok).toBe(true);
    release();
    expect(g.status().pending).toBe(0);
    // The stale request made one call and never retried after it was superseded.
    expect(f.messages).toHaveLength(2);
  });
});
