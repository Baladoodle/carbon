import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Candidate, Moment, MomentRequest } from '@core/ai/moments';
import { sampleWorld } from '@core/testing/sample';
import type { World } from '@core/model/world';
import {
  FixtureFetch,
  fixtureClient,
  replyCount,
  replyError,
  replyJson,
  replyStream,
  type FixtureReply,
  type Responder,
} from './fixtures';
import { ClaudeAiGateway, REQUEST_LIMIT } from './gateway';
import { DEFAULT_PRICING, MODEL } from './settings';

const instant = (): Promise<void> => Promise.resolve();

function setup(
  responders: Responder[] = [],
  world: World = sampleWorld(),
  extra: Partial<ConstructorParameters<typeof ClaudeAiGateway>[0]> = {},
) {
  const f = new FixtureFetch(responders);
  const sleeps: number[] = [];
  let w = world;
  const g = new ClaudeAiGateway({
    getWorld: () => w,
    client: fixtureClient(f),
    sleep: (ms) => {
      sleeps.push(ms);
      return instant();
    },
    random: () => 0.5,
    now: () => new Date('2026-11-04T10:00:00.000Z'),
    ...extra,
  });
  return { f, g, sleeps, setWorld: (x: World) => (w = x), world: () => w };
}

const ok = (result: unknown, more: Partial<FixtureReply> = {}): Response =>
  replyJson({ text: JSON.stringify(result), ...more });

const body = (f: FixtureFetch, i = 0): Record<string, unknown> =>
  f.messages[i]!.body as Record<string, unknown>;

describe('ClaudeAiGateway: request shape (contract tests, every moment)', () => {
  const cases: {
    moment: Moment;
    request: MomentRequest<Moment>;
    reply: unknown;
    effort: string;
    stream: boolean;
  }[] = [
    {
      moment: 'suggest_one',
      request: { entityId: 'spore-lantern', field: 'tradeoff' },
      reply: { suggestion: { value: 'Goes dark underwater.', note: 'ties to motion' } },
      effort: 'low',
      stream: false,
    },
    {
      moment: 'suggest_three',
      request: { entityId: 'spore-lantern', field: 'tradeoff' },
      reply: {
        suggestions: [
          { value: 'A', note: 'a' },
          { value: 'B', note: 'b' },
          { value: 'C', note: 'c' },
        ],
      },
      effort: 'low',
      stream: false,
    },
    {
      moment: 'fill_entity',
      request: { entityId: 'high-drift' },
      reply: { proposals: { character: { value: 'Silent and cold', note: null } } },
      effort: 'low',
      stream: false,
    },
    {
      moment: 'critique',
      request: { entityId: 'glide', trigger: 'on_demand' },
      reply: { notes: [] },
      effort: 'low',
      stream: false,
    },
    {
      moment: 'spec_draft',
      request: { entityIds: ['cinder-sting'], name: 'First weapon' },
      reply: { title: 'First weapon', markdown: '# First weapon' },
      effort: 'medium',
      stream: false,
    },
    {
      moment: 'spread',
      request: { spot: { type: 'cell', band: 'low-sky', lane: 'items' }, move: 'fill', count: 2 },
      reply: {
        axes: { x: { label: 'a', low: 'l', high: 'h' }, y: { label: 'b', low: 'l', high: 'h' } },
        candidates: [],
      },
      effort: 'medium',
      stream: true,
    },
    {
      moment: 'patterns',
      request: {
        judgements: [
          {
            candidate: { name: 'A', identity: 'a', kind: 'item' },
            verdict: 'kill',
            reason: 'seen it',
          },
        ],
      },
      reply: { patterns: [] },
      effort: 'medium',
      stream: false,
    },
  ];

  for (const c of cases) {
    it(`${c.moment}: model, effort, structured output, caching, no sampling, no prefill`, async () => {
      const text = JSON.stringify(c.reply);
      const { f, g } = setup([c.stream ? replyStream({ text }) : replyJson({ text })]);
      const out = await g.run(c.moment, c.request);
      expect(out.ok, JSON.stringify(out)).toBe(true);
      const b = body(f);
      expect(b.model).toBe(MODEL);
      expect(b.stream === true).toBe(c.stream);
      for (const k of ['temperature', 'top_p', 'top_k', 'thinking'])
        expect(b).not.toHaveProperty(k);
      const oc = b.output_config as {
        effort: string;
        format: { type: string; schema: Record<string, unknown> };
      };
      expect(oc.effort).toBe(c.effort);
      expect(oc.format.type).toBe('json_schema');
      expect(oc.format.schema.additionalProperties).toBe(false);
      const messages = b.messages as { role: string }[];
      expect(messages).toHaveLength(1);
      expect(messages.at(-1)!.role).toBe('user'); // no assistant prefill
      const system = b.system as { text: string; cache_control?: unknown }[];
      const marks = system.filter((s) => s.cache_control);
      expect(marks.length).toBeGreaterThanOrEqual(1);
      expect(marks.length).toBeLessThanOrEqual(4);
      expect(system.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
      // Nothing volatile in the cached prefix: user turn holds the focus.
      const userText = JSON.stringify(b.messages);
      if ('entityId' in c.request) expect(userText).toContain(c.request.entityId);
      expect(b.max_tokens).toBeGreaterThan(0);
    });
  }

  it('the cached prefix is byte-identical across moments and requests on the same world', async () => {
    const { f, g } = setup([
      ok({ suggestion: { value: 'Goes dark underwater.', note: 'x' } }),
      ok({ notes: [] }),
    ]);
    await g.run('suggest_one', { entityId: 'spore-lantern', field: 'tradeoff' });
    await g.run('critique', { entityId: 'glide', trigger: 'on_demand' });
    const s0 = body(f, 0).system as { text: string }[];
    const s1 = body(f, 1).system as { text: string }[];
    // role, digest and taste are shared; only the moment's instructions differ.
    expect(s1.slice(0, 3)).toEqual(s0.slice(0, 3));
  });
});

describe('ClaudeAiGateway: results, cache, cost and log', () => {
  it('validates the result, costs the usage and logs the call', async () => {
    const { f, g } = setup([
      ok(
        { suggestion: { value: 'Goes dark underwater.', note: 'ties to motion' } },
        {
          usage: {
            input_tokens: 2000,
            output_tokens: 100,
            cache_read_input_tokens: 3000,
            cache_creation_input_tokens: 0,
          },
          thinking: true,
        },
      ),
    ]);
    const out = await g.run('suggest_one', { entityId: 'spore-lantern', field: 'tradeoff' });
    if (!out.ok) throw new Error(out.error.message);
    expect(out.result.suggestion.value).toBe('Goes dark underwater.');
    expect(out.meta.usage).toEqual({ input: 2000, output: 100, cacheRead: 3000, cacheWrite: 0 });
    const p = DEFAULT_PRICING[MODEL]!;
    expect(out.meta.costUsd).toBeCloseTo(
      (2000 * p.inputPerMTok + 100 * p.outputPerMTok + 3000 * p.cacheReadPerMTok) / 1e6,
      12,
    );
    expect(g.status().spend.sessionUsd).toBeCloseTo(out.meta.costUsd, 12);
    const [entry] = await g.log();
    expect(entry).toMatchObject({
      moment: 'suggest_one',
      entity: 'spore-lantern',
      outcome: 'ok',
      attempts: 1,
      stopReason: 'end_turn',
      results: 1,
    });
    expect(entry!.meta!.usage.cacheRead).toBe(3000);
    expect(g.request(entry!.id)?.text).toContain('<<system: digest · cached>>');
    expect(f.requests).toHaveLength(1);
  });

  it('never sends an unchanged request twice (content-hash cache)', async () => {
    const { f, g, setWorld, world } = setup([ok({ notes: [] }), ok({ notes: [] })]);
    const a = await g.run('critique', { entityId: 'glide', trigger: 'finish_edit' });
    const b = await g.run('critique', { entityId: 'glide', trigger: 'finish_edit' });
    expect(f.messages).toHaveLength(1);
    expect(b).toMatchObject({ ok: true, meta: { cached: true, costUsd: 0 } });
    expect(a.ok && b.ok && b.result).toEqual(a.ok && a.result);
    expect((await g.log()).map((e) => e.outcome)).toEqual(['ok', 'cached']);
    // A changed entity is a new request.
    const w = structuredClone(world());
    w.entities['glide']!.identity = 'A different identity entirely.';
    setWorld(w);
    await g.run('critique', { entityId: 'glide', trigger: 'finish_edit' });
    expect(f.messages).toHaveLength(2);
  });

  it('drops and counts invalid items: unknown entities and rules, unknown kinds', async () => {
    const { g } = setup([
      ok({
        notes: [
          {
            kind: 'duplicate',
            text: 'Duplicates Ghost.',
            entities: ['ghost-entity'],
            field: null,
            ruleId: null,
          },
          {
            kind: 'rule_clash',
            text: 'Breaks a rule.',
            entities: [],
            field: null,
            ruleId: 'no-such-rule',
          },
          { kind: 'vibes', text: 'Bad vibes.', entities: [], field: null, ruleId: null },
          {
            kind: 'weak_identity',
            text: 'Glide needs a sharper identity.',
            entities: [],
            field: 'identity',
            ruleId: null,
          },
        ],
      }),
    ]);
    const out = await g.run('critique', { entityId: 'glide', trigger: 'on_demand' });
    if (!out.ok) throw new Error(out.error.message);
    expect(out.result.notes).toEqual([
      {
        kind: 'weak_identity',
        text: 'Glide needs a sharper identity.',
        entities: [],
        field: 'identity',
      },
    ]);
    expect(out.meta.dropped).toBe(3);
  });

  it('reports not_found and bad requests without calling the API', async () => {
    const { f, g } = setup();
    expect(await g.run('critique', { entityId: 'ghost', trigger: 'on_demand' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await g.run('critique', { entityId: 'NOT A SLUG', trigger: 'on_demand' })).toMatchObject(
      { ok: false, error: { code: 'bad_request' } },
    );
    expect(await g.run('suggest_one', { entityId: 'glide', field: 'created' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(f.requests).toHaveLength(0);
  });

  it('writes JSONL to the world directory and reads this month back for the budget', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'carbon-ai-'));
    try {
      const { g } = setup([
        ok({ notes: [] }, { usage: { input_tokens: 1_000_000, output_tokens: 0 } }),
      ]);
      await g.attach(dir);
      await g.run('critique', { entityId: 'glide', trigger: 'state_change' });
      await g.log$.flush();
      const text = await readFile(path.join(dir, 'ai-log', '2026-11-04.jsonl'), 'utf8');
      const line = JSON.parse(text.trim()) as Record<string, unknown>;
      expect(line).toMatchObject({ moment: 'critique', trigger: 'state_change', outcome: 'ok' });
      expect(text).not.toContain('test-key-not-real');
      const { g: g2 } = setup();
      await g2.attach(dir);
      // 1M input tokens is over 100k, so it's billed at the 5× long-context rate.
      expect(g2.status().spend.monthUsd).toBeCloseTo(0.5, 6);
      expect(g2.status().spend.sessionUsd).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('ClaudeAiGateway: errors and retries (typed, most specific first)', () => {
  const run = (g: ClaudeAiGateway) =>
    g.run('critique', { entityId: 'glide', trigger: 'on_demand' });

  it('retries 429 with the server’s retry-after, then succeeds', async () => {
    const { f, g, sleeps } = setup([
      replyError(429, 'rate_limit_error', 'slow down', { 'retry-after': '2' }),
      ok({ notes: [] }),
    ]);
    const out = await run(g);
    expect(out.ok).toBe(true);
    expect(f.messages).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
    expect((await g.log())[0]).toMatchObject({ attempts: 2 });
  });

  it('retries 5xx and 529 with exponential backoff, and gives up after 4 attempts', async () => {
    const { f, g, sleeps } = setup([
      replyError(500, 'api_error', 'boom'),
      replyError(529, 'overloaded_error', 'busy'),
      replyError(503, 'api_error', 'boom'),
      replyError(500, 'api_error', 'boom'),
    ]);
    const out = await run(g);
    expect(out).toMatchObject({ ok: false, error: { code: 'server', retryable: true } });
    expect(f.messages).toHaveLength(4);
    expect(sleeps).toEqual([375, 750, 1500]);
  });

  it('retries connection failures', async () => {
    const { f, g } = setup([new TypeError('fetch failed'), ok({ notes: [] })]);
    expect((await run(g)).ok).toBe(true);
    expect(f.messages).toHaveLength(2);
  });

  it('never retries a 400, and maps 401 to no_key', async () => {
    const a = setup([replyError(400, 'invalid_request_error', 'temperature is not supported')]);
    expect(await run(a.g)).toMatchObject({
      ok: false,
      error: { code: 'bad_request', retryable: false },
    });
    expect(a.f.messages).toHaveLength(1);
    const b = setup([replyError(401, 'authentication_error', 'invalid x-api-key')]);
    expect(await run(b.g)).toMatchObject({ ok: false, error: { code: 'no_key' } });
    const c = setup([replyError(413, 'request_too_large', 'too big')]);
    expect(await run(c.g)).toMatchObject({ ok: false, error: { code: 'too_large' } });
  });

  it('checks stop_reason before trusting the content: refusal and max_tokens', async () => {
    const r = setup([ok({ notes: [] }, { stop_reason: 'refusal' })]);
    const refused = await run(r.g);
    expect(refused).toMatchObject({ ok: false, error: { code: 'refused' } });
    // A refused call is still costed and logged.
    expect(!refused.ok && refused.meta?.costUsd).toBeGreaterThan(0);
    const t = setup([
      replyJson({ text: '{"notes": [{"kind": "weak_id', stop_reason: 'max_tokens' }),
    ]);
    expect(await run(t.g)).toMatchObject({ ok: false, error: { code: 'truncated' } });
    expect((await t.g.log())[0]).toMatchObject({ stopReason: 'max_tokens' });
  });

  it('reports invalid JSON and schema-invalid output as invalid_output', async () => {
    const a = setup([replyJson({ text: 'Sure! Here are the notes:' })]);
    expect(await run(a.g)).toMatchObject({ ok: false, error: { code: 'invalid_output' } });
    const b = setup([ok({ suggestion: { value: 42, note: 'x' } })]);
    expect(
      await b.g.run('suggest_one', { entityId: 'spore-lantern', field: 'tradeoff' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_output' } });
  });
});

describe('ClaudeAiGateway: streaming spreads', () => {
  const candidate = (name: string, extra: Record<string, unknown> = {}) => ({
    kind: 'item',
    name,
    identity: `${name} changes how you climb.`,
    description: '',
    attributes: [],
    relations: [{ type: 'in_band', target: 'low-sky', note: '' }],
    about: null,
    position: { x: 0.2, y: 0.8 },
    wildcard: false,
    rationale: 'fits',
    ...extra,
  });

  it('feeds validated candidates to onPartial as they arrive, then returns them all', async () => {
    const result = {
      axes: {
        x: { label: 'risk', low: 'safe', high: 'wild' },
        y: { label: 'cost', low: 'cheap', high: 'dear' },
      },
      candidates: [
        candidate('Kite Lung'),
        candidate('Spore Lantern'), // duplicates an existing name: dropped
        candidate('Updraft Spur', {
          relations: [{ type: 'in_band', target: 'nowhere', note: '' }],
        }),
        candidate('Sky Anchor', { wildcard: true }),
      ],
    };
    const { g } = setup([
      replyStream({ text: JSON.stringify(result), chunks: 40, thinking: true }),
    ]);
    const seen: Candidate[] = [];
    const out = await g.run(
      'spread',
      { spot: { type: 'cell', band: 'low-sky', lane: 'items' }, move: 'fill', count: 4 },
      { onPartial: (c) => seen.push(c) },
    );
    if (!out.ok) throw new Error(out.error.message);
    expect(seen.map((c) => c.name)).toEqual(['Kite Lung', 'Updraft Spur', 'Sky Anchor']);
    expect(seen[1]!.relations).toEqual([]); // the dangling relation was removed
    expect(out.result.candidates.map((c) => c.key)).toEqual(seen.map((c) => c.key));
    expect(out.result.candidates.filter((c) => c.wildcard).map((c) => c.name)).toEqual([
      'Sky Anchor',
    ]);
    expect(out.meta.dropped).toBe(1);
  });

  it('replays a cached spread through onPartial', async () => {
    const result = {
      axes: { x: { label: 'a', low: 'l', high: 'h' }, y: { label: 'b', low: 'l', high: 'h' } },
      candidates: [candidate('Kite Lung')],
    };
    const { f, g } = setup([replyStream({ text: JSON.stringify(result) })]);
    const req = {
      spot: { type: 'cell' as const, band: 'low-sky', lane: 'items' as const },
      move: 'fill' as const,
      count: 1,
    };
    await g.run('spread', req);
    const seen: string[] = [];
    await g.run('spread', req, { onPartial: (c) => seen.push(c.name) });
    expect(seen).toEqual(['Kite Lung']);
    expect(f.messages).toHaveLength(1);
  });

  it('does not retry a stream that already showed candidates', async () => {
    const text = JSON.stringify({
      axes: { x: { label: 'a', low: 'l', high: 'h' }, y: { label: 'b', low: 'l', high: 'h' } },
      candidates: [candidate('Kite Lung'), candidate('Sky Anchor')],
    });
    const half = text.slice(0, text.indexOf('Sky Anchor'));
    const broken = (): Response => {
      const enc = new TextEncoder();
      const startEv = {
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
      };
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(`event: message_start\ndata: ${JSON.stringify(startEv)}\n\n`));
          c.enqueue(
            enc.encode(
              `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
            ),
          );
          c.enqueue(
            enc.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: half } })}\n\n`,
            ),
          );
          c.enqueue(
            enc.encode(
              `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
            ),
          );
          c.close();
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    };
    const { f, g } = setup([broken(), broken()]);
    const seen: string[] = [];
    const out = await g.run(
      'spread',
      { spot: { type: 'cell', band: 'low-sky', lane: 'items' }, move: 'fill', count: 2 },
      { onPartial: (c) => seen.push(c.name) },
    );
    expect(out.ok).toBe(false);
    expect(seen).toEqual(['Kite Lung']);
    expect(f.messages).toHaveLength(1);
  });
});

describe('ClaudeAiGateway: cancellation, off switch, budget, token limit', () => {
  it('a new request for the same entity cancels the stale one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { g } = setup([
      async () => {
        await gate;
        return ok({ notes: [] });
      },
      ok({ suggestion: { value: 'Goes dark underwater.', note: 'x' } }),
    ]);
    const stale = g.run('critique', { entityId: 'spore-lantern', trigger: 'finish_edit' });
    await new Promise((r) => setTimeout(r, 5));
    expect(g.status().pending).toBe(1);
    const fresh = await g.run('suggest_one', { entityId: 'spore-lantern', field: 'tradeoff' });
    release();
    expect(await stale).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(fresh.ok).toBe(true);
    expect(g.status().pending).toBe(0);
  });

  it('honours the caller’s AbortSignal', async () => {
    const ac = new AbortController();
    const { g } = setup([
      () =>
        new Promise<Response>((_, reject) => {
          setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 20);
        }),
    ]);
    const p = g.run('critique', { entityId: 'glide', trigger: 'on_demand' }, { signal: ac.signal });
    ac.abort();
    expect(await p).toMatchObject({ ok: false, error: { code: 'cancelled' } });
  });

  it('the off switch disables every moment and says so', async () => {
    const { f, g } = setup();
    const statuses: boolean[] = [];
    g.onStatus((s) => statuses.push(s.enabled));
    g.setEnabled(false);
    expect(g.status()).toMatchObject({
      enabled: false,
      reason: 'AI is off for this session',
      mode: 'real',
    });
    expect(await g.run('critique', { entityId: 'glide', trigger: 'on_demand' })).toMatchObject({
      ok: false,
      error: { code: 'disabled' },
    });
    g.setEnabled(true);
    expect(statuses).toEqual([false, true]);
    expect(f.requests).toHaveLength(0);
  });

  it('pauses at the budget until it is raised', async () => {
    const w = sampleWorld();
    w.settings.ai = { budget: { sessionUsd: 0.05, monthUsd: 20 } };
    const { f, g, setWorld } = setup(
      [
        ok({ notes: [] }, { usage: { input_tokens: 1_000_000, output_tokens: 0 } }),
        ok({ notes: [] }),
      ],
      w,
    );
    expect((await g.run('critique', { entityId: 'glide', trigger: 'on_demand' })).ok).toBe(true);
    expect(g.status()).toMatchObject({ paused: true });
    expect(g.status().reason).toContain('$0.05');
    expect(
      await g.run('critique', { entityId: 'cinder-wasp', trigger: 'on_demand' }),
    ).toMatchObject({ ok: false, error: { code: 'budget' } });
    expect(f.messages).toHaveLength(1);
    const raised = structuredClone(w);
    raised.settings.ai = { budget: { sessionUsd: 5, monthUsd: 20 } };
    setWorld(raised);
    g.refresh();
    expect(g.status().paused).toBe(false);
    expect((await g.run('critique', { entityId: 'cinder-wasp', trigger: 'on_demand' })).ok).toBe(
      true,
    );
  });

  it('counts tokens near the limit and refuses requests over 100k', async () => {
    const { f, g } = setup(
      [replyCount(REQUEST_LIMIT + 10), replyCount(REQUEST_LIMIT + 5)],
      sampleWorld(),
      { countThreshold: 10 },
    );
    const out = await g.run('critique', { entityId: 'glide', trigger: 'on_demand' });
    expect(out).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(f.requests.map((r) => r.url)).toEqual([
      'https://api.anthropic.com/v1/messages/count_tokens',
      'https://api.anthropic.com/v1/messages/count_tokens',
    ]);
    expect(f.messages).toHaveLength(0);
  });

  it('re-packs smaller when the exact count is over the packer’s hard limit', async () => {
    const { f, g } = setup(
      [replyCount(97_000), replyCount(60_000), ok({ notes: [] })],
      sampleWorld(),
      { countThreshold: 10 },
    );
    const out = await g.run('critique', { entityId: 'glide', trigger: 'on_demand' });
    expect(out.ok).toBe(true);
    expect(f.messages).toHaveLength(1);
    expect((await g.log())[0]).toMatchObject({ counted: 60_000 });
  });

  it('falls back to the local estimate when count_tokens fails', async () => {
    const { g } = setup([replyError(500, 'api_error', 'x'), ok({ notes: [] })], sampleWorld(), {
      countThreshold: 10,
    });
    expect((await g.run('critique', { entityId: 'glide', trigger: 'on_demand' })).ok).toBe(true);
  });
});

afterEach(() => undefined);
