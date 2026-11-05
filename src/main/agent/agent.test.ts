import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FakeAiGateway } from '@core/ai/fake';
import type { AiGateway } from '@core/ai/gateway';
import { applyCommands } from '@core/commands/apply';
import { cmd } from '@core/commands/registry';
import { sampleWorld } from '@core/testing/sample';
import type { World } from '@core/model/world';
import { readSpread } from '@core/spreads/record';
import type { AgentSettings } from '@shared/agent';
import { AgentSettingsSchema } from '@shared/agent';
import type { DispatchResult } from '@shared/ipc';
import { AgentHost, RateLimiter, type AgentHostDeps, type ToolCallResult } from './host';
import { redactSecrets } from './redact';
import { connectToCarbon, createRelayServer, RelayError, runRelay } from './relay';
import { AgentSocketServer, prepareSocketPath, SocketInUse } from './server';
import { AgentSettingsStore } from './settings';
import { socketPath } from './socket-path';
import { TOOLS, type AgentImages } from './tools';
import { asAgent } from './via';
import { writeWorldDir } from '../store/world-dir';
import { WorldSession } from '../world-session';

const NOW = '2026-11-05T12:00:00.000Z';

interface Sent {
  commands: { type: string; payload: unknown }[];
  label: string | undefined;
  meta: { by: 'agent' } | undefined;
}

/** A session over a plain world: applies commands like WorldSession, and records what it was sent. */
function memSession(start: World = sampleWorld()) {
  let world = start;
  let rev = 0;
  const sent: Sent[] = [];
  return {
    sent,
    get world() {
      return world;
    },
    dispatch(
      commands: readonly { type: string; payload: unknown }[],
      label?: string,
      _effect?: undefined,
      meta?: { by: 'agent' },
    ): DispatchResult {
      sent.push({ commands: [...commands], label, meta });
      const r = applyCommands(world, commands, { now: NOW });
      if (!r.ok) return { ok: false, error: r.error };
      world = r.value.world;
      return { ok: true, rev: ++rev };
    },
  };
}

class Meter {
  spent = 0;
  remaining(b: AgentSettings['budget']): number {
    return b.sessionUsd - this.spent;
  }
  add(usd: number): void {
    this.spent += usd;
  }
}

function fakeImages(over: Partial<AgentImages> = {}): AgentImages {
  const ok = (entityId: string, kind: string) => ({
    ok: true as const,
    image: { id: '01JT0000000000000000000000', entity: entityId, kind },
    receipt: { costUsd: 0.01 },
  });
  return {
    prompt: () => Promise.resolve({ ok: true, prompt: 'a lantern', claudeCostUsd: 0.001 }),
    estimate: (r) => ({
      model: 'gpt-image-2.5-flare',
      quality: 'low',
      size: '1024x1024',
      calls: r.calls ?? 1,
      perCallUsd: 0.01,
      totalUsd: 0.01 * (r.calls ?? 1),
      remainingUsd: 1,
    }),
    generate: (r) => Promise.resolve(ok(r.entityId, r.kind)),
    iconFromConcept: (r) => Promise.resolve(ok(r.entityId, 'icon')),
    batchPlan: () => Promise.reject(new Error('not in this test')),
    batchRun: () => Promise.reject(new Error('not in this test')),
    sheetRun: () => Promise.reject(new Error('not in this test')),
    sheetCrop: () => Promise.resolve(null),
    sheetAccept: () =>
      Promise.resolve({ ok: false, error: { code: 'not_found', message: 'no sheet' } }),
    status: () => ({ mode: 'fake', enabled: true }),
    ...over,
  };
}

function setup(
  opts: {
    settings?: Partial<AgentSettings>;
    ai?: AiGateway;
    images?: AgentImages | null;
    rate?: AgentHostDeps['rate'];
    world?: World;
  } = {},
) {
  const session = memSession(opts.world);
  const settings = AgentSettingsSchema.parse(opts.settings ?? {});
  const ai = opts.ai ?? new FakeAiGateway({ getWorld: () => session.world, now: () => NOW });
  const meter = new Meter();
  const reveal = vi.fn();
  const logged: unknown[] = [];
  const host = new AgentHost({
    session,
    ai,
    images: () => (opts.images === undefined ? fakeImages() : opts.images),
    settings: () => settings,
    spend: meter,
    reveal,
    notes: () => [],
    now: () => new Date(NOW),
    ...(opts.rate ? { rate: opts.rate } : {}),
    onLogged: (e) => logged.push(e),
  });
  const call = async (name: string, args: unknown = {}): Promise<ToolCallResult> =>
    host.call(name, args, 'test-client');
  const data = async (name: string, args: unknown = {}): Promise<unknown> => {
    const r = await call(name, args);
    if (r.isError) throw new Error(r.content[0]?.text);
    return JSON.parse(r.content[0]?.text ?? 'null');
  };
  return { session, host, call, data, settings, meter, reveal, logged, ai };
}

const errCode = (r: ToolCallResult): string | null =>
  r.isError ? (r.content[0]?.text.split(':')[0] ?? null) : null;

describe('the tool list', () => {
  it('names every tool once, each with an object JSON Schema and a description', async () => {
    const { host } = setup();
    const r = (await host.handle('tools/list', undefined)) as {
      tools: { name: string; inputSchema: { type: string }; description: string }[];
    };
    expect(r.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(new Set(r.tools.map((t) => t.name)).size).toBe(r.tools.length);
    for (const t of r.tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it('covers reads, writes, the UI, paid and free generation', () => {
    const kinds = new Set(TOOLS.map((t) => t.kind));
    expect([...kinds].sort()).toEqual(['free', 'paid', 'read', 'ui', 'write']);
  });
});

describe('reads', () => {
  it('summarises the world from the session', async () => {
    const { data } = setup();
    const s = (await data('world_summary')) as {
      entities: number;
      counts: Record<string, { total: number }>;
      bands: { id: string }[];
    };
    expect(s.entities).toBe(Object.keys(sampleWorld().entities).length);
    expect(s.counts.item?.total).toBe(4);
    expect(s.bands.map((b) => b.id)).toEqual([
      'undercroft',
      'hollows',
      'groundline',
      'low-sky',
      'high-drift',
    ]);
  });

  it('finds with the Codex filter language, and reports query errors', async () => {
    const { data } = setup();
    const r = (await data('find_entities', { query: 'kind:item state:idea' })) as {
      total: number;
      entities: { id: string }[];
    };
    expect(r.entities.map((e) => e.id).sort()).toEqual(['cloud-anklet', 'vent-glass-visor']);
    const bad = (await data('find_entities', { query: 'colour:red' })) as {
      queryErrors: unknown[];
    };
    expect(bad.queryErrors.length).toBeGreaterThan(0);
  });

  it('gets an entity with inbound relations, placement and next states', async () => {
    const { data } = setup();
    const r = (await data('get_entity', { id: 'spore-lantern' })) as {
      entity: { name: string };
      inbound: { from: string; type: string }[];
      placement: { bands: string[] };
      next: { state: string; missing: string[] }[];
    };
    expect(r.entity.name).toBe('Spore Lantern');
    expect(r.inbound).toContainEqual({ from: 'vent-glass-visor', type: 'requires' });
    expect(r.placement.bands).toContain('hollows');
    expect(r.next.find((n) => n.state === 'decided')?.missing).toContain('why');
  });

  it('evaluates expressions against the formulas', async () => {
    const { data } = setup();
    expect(await data('evaluate', { expression: 'taken(100, 100)' })).toMatchObject({
      ok: true,
      value: 50,
    });
    expect(await data('evaluate', { expression: 'nope(1)' })).toMatchObject({ ok: false });
  });

  it('previews an export spec for decided and exported entities only', async () => {
    const { data, call } = setup();
    const r = (await data('preview_export', {
      name: 'Weapons',
      entityIds: ['cinder-sting', 'cloud-anklet'],
    })) as { entities: string[]; skipped: string[]; markdown: string };
    expect(r.entities).toEqual(['cinder-sting']);
    expect(r.skipped).toEqual(['cloud-anklet']);
    expect(r.markdown).toContain('# Weapons');
    expect(errCode(await call('preview_export', { name: 'x', entityIds: ['cloud-anklet'] }))).toBe(
      'export.empty',
    );
  });

  it('serves resources, including an entity by template', async () => {
    const { host } = setup();
    const list = (await host.handle('resources/list', undefined)) as { resources: unknown[] };
    expect(list.resources.length).toBeGreaterThanOrEqual(3);
    const r = (await host.handle('resources/read', { uri: 'carbon://entity/glide' })) as {
      contents: { text: string }[];
    };
    expect((JSON.parse(r.contents[0]?.text ?? '{}') as { entity: { id: string } }).entity.id).toBe(
      'glide',
    );
    await expect(host.handle('resources/read', { uri: 'carbon://nope' })).rejects.toMatchObject({
      code: 'agent.not_found',
    });
  });
});

describe('writes map to commands, one transaction each', () => {
  const cases: [string, Record<string, unknown>, string[]][] = [
    [
      'create_entity',
      { kind: 'item', name: 'Glass Lung', fields: { subkind: 'accessory' } },
      ['entity.create'],
    ],
    ['update_entity', { id: 'glide', set: { identity: 'Fall, but slowly.' } }, ['entity.update']],
    [
      'set_attribute',
      { id: 'vent-glass-visor', key: 'defense', value: 5 },
      ['entity.setAttribute'],
    ],
    ['delete_entity', { id: 'cloud-anklet' }, ['entity.delete']],
    ['add_relation', { from: 'cloud-anklet', type: 'in_band', to: 'low-sky' }, ['relation.add']],
    [
      'remove_relation',
      { from: 'spore-lantern', type: 'in_band', to: 'hollows' },
      ['relation.remove'],
    ],
    [
      'set_state',
      { id: 'spore-lantern', state: 'decided', why: 'Light is the Hollows.' },
      ['entity.update', 'entity.setState'],
    ],
    [
      'set_state',
      { id: 'cloud-anklet', state: 'graveyard', killed: { reason: 'dull' } },
      ['entity.setState'],
    ],
    ['add_taste_rule', { text: 'Every item changes a verb.' }, ['taste.addRule']],
    ['update_taste_rule', { id: 'no-pure-numbers', enabled: false }, ['taste.updateRule']],
    ['remove_taste_rule', { id: 'no-pure-numbers' }, ['taste.removeRule']],
    ['set_art_direction', { direction: 'Ink and ember.' }, ['art.set']],
    ['set_variable', { name: 'k', value: 120 }, ['numbers.setVariable']],
    ['set_formulas', { source: 'x = 1\n' }, ['numbers.setFormulas']],
    [
      'select_image',
      { entityId: 'glide', imageId: '01JT0000000000000000000000' },
      ['image.select'],
    ],
    ['unselect_image', { entityId: 'glide', kind: 'icon' }, ['image.unselect']],
    [
      'remove_image',
      { entityId: 'glide', imageId: '01JT0000000000000000000000' },
      ['image.remove'],
    ],
  ];
  it.each(cases)('%s → %j', async (name, args, types) => {
    const { call, session } = setup();
    await call(name, args);
    expect(session.sent).toHaveLength(1);
    const sent = session.sent[0] as Sent;
    expect(sent.commands.map((c) => c.type)).toEqual(types);
    expect(sent.meta).toEqual({ by: 'agent' });
    expect(sent.label).toMatch(/^Agent: /);
  });

  it('marks what the agent wrote, apart from the AI', async () => {
    const { call, session } = setup();
    await call('create_entity', {
      kind: 'item',
      name: 'Glass Lung',
      identity: 'Breathe under ash.',
      fields: { subkind: 'accessory' },
      attributes: { defense: 1 },
    });
    const e = session.world.entities['glass-lung'];
    expect(e?.origin).toEqual({ by: 'agent' });
    expect(e?.agent_fields?.sort()).toEqual(['attributes.defense', 'identity', 'name', 'subkind']);
    expect(e?.ai_fields).toEqual([]);
    await call('update_entity', { id: 'glide', set: { identity: 'Fall slowly.' } });
    expect(session.world.entities.glide?.agent_fields).toEqual(['identity']);
    // The user's own edit takes the marker off; nothing is left behind.
    const r = session.dispatch([
      { type: 'entity.update', payload: { id: 'glide', set: { identity: 'Mine.' } } },
    ]);
    expect(r.ok).toBe(true);
    expect(session.world.entities.glide?.agent_fields).toBeUndefined();
  });

  it('refuses with the command’s own code and message (the Why gate)', async () => {
    const { call, session } = setup();
    const r = await call('set_state', { id: 'spore-lantern', state: 'decided' });
    expect(errCode(r)).toBe('state.missing_fields');
    expect(r.content[0]?.text).toContain('why');
    expect(session.world.entities['spore-lantern']?.state).toBe('shaped');
    expect(
      errCode(await call('set_state', { id: 'cloud-anklet', state: 'decided', why: 'x' })),
    ).toBe('state.transition');
  });

  it('validates input with zod before anything runs', async () => {
    const { call, session } = setup();
    const r = await call('create_entity', { kind: 'dragon', name: '' });
    expect(errCode(r)).toBe('agent.invalid_input');
    expect(r.content[0]?.text).toMatch(/kind|name/);
    expect(errCode(await call('nope'))).toBe('agent.unknown_tool');
    expect(session.sent).toHaveLength(0);
  });

  it('shows the user what it means without changing the world', async () => {
    const { call, reveal, session } = setup();
    await call('focus', { id: 'glide' });
    await call('view', { view: 'numbers' });
    expect(reveal.mock.calls).toEqual([[{ entity: 'glide' }], [{ view: 'numbers' }]]);
    expect(session.sent).toHaveLength(0);
    expect(errCode(await call('focus', { id: 'nobody' }))).toBe('entity.not_found');
  });
});

describe('access, spending and the rate limit', () => {
  it('refuses everything while access is off', async () => {
    const { call, host } = setup({ settings: { access: false } });
    expect(errCode(await call('world_summary'))).toBe('agent.access_off');
    expect(errCode(await call('create_entity', { kind: 'item', name: 'X' }))).toBe(
      'agent.access_off',
    );
    await expect(
      host.handle('resources/read', { uri: 'carbon://world/summary' }),
    ).rejects.toMatchObject({ code: 'agent.access_off' });
  });

  it('refuses paid calls until spending is allowed, without calling the AI', async () => {
    const ai = new FakeAiGateway({ getWorld: () => sampleWorld() });
    const run = vi.spyOn(ai, 'run');
    const { call } = setup({ ai });
    for (const [name, args] of [
      ['suggest', { entityId: 'glide', field: 'identity' }],
      ['fill', { entityId: 'glide' }],
      ['critique', { entityId: 'glide' }],
      ['spread', { spot: { type: 'entity', entity: 'glide' }, move: 'vary' }],
      ['image_prompt', { entityId: 'glide', kind: 'concept' }],
      ['generate_image', { entityId: 'glide', kind: 'concept', prompt: 'p' }],
      ['plan_image_batch', { kind: 'concept', entityIds: ['glide'] }],
      ['run_image_batch', { kind: 'icon', items: [{ entityId: 'glide', line: 'x' }] }],
    ] as const)
      expect(errCode(await call(name, args)), name).toBe('agent.spend_off');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the free image actions free', async () => {
    const { call } = setup();
    expect((await call('icon_from_concept', { entityId: 'glide' })).isError).toBeUndefined();
    expect(
      errCode(
        await call('review_sheet', { entityId: 'glide', imageId: '01JT0000000000000000000000' }),
      ),
    ).toBe('images.not_found');
  });

  it('logs paid calls via agent, and counts their cost against the agent budget', async () => {
    const { call, ai, meter } = setup({ settings: { spend: true } });
    const r = await call('suggest', { entityId: 'glide', field: 'identity', count: 3 });
    expect(r.isError).toBeUndefined();
    const log = await ai.log();
    expect(log.at(-1)).toMatchObject({ moment: 'suggest_three', via: 'agent' });
    await call('generate_image', { entityId: 'glide', kind: 'icon' });
    expect(meter.spent).toBeCloseTo(0.011, 6);
  });

  it('stops at the budget, and refuses an estimate that doesn’t fit', async () => {
    const tight = setup({ settings: { spend: true, budget: { sessionUsd: 0.005, monthUsd: 10 } } });
    const r = await tight.call('generate_image', {
      entityId: 'glide',
      kind: 'concept',
      prompt: 'p',
    });
    expect(errCode(r)).toBe('agent.budget');
    expect(r.content[0]?.text).toContain('$0.010');
    const spent = setup({ settings: { spend: true, budget: { sessionUsd: 0, monthUsd: 10 } } });
    expect(errCode(await spent.call('critique', { entityId: 'glide' }))).toBe('agent.budget');
  });

  it('limits writes per second with a clear error; reads are not limited', async () => {
    let t = 0;
    const { host } = setup({ rate: { limit: 3, windowMs: 1000 } });
    // A fixed clock: every call lands in the same window.
    (host as unknown as { deps: { now: () => Date } }).deps.now = () => new Date(t);
    for (let i = 0; i < 3; i++)
      expect((await host.call('set_variable', { name: 'k', value: i })).isError).toBeUndefined();
    const r = await host.call('set_variable', { name: 'k', value: 9 });
    expect(errCode(r)).toBe('agent.rate_limited');
    expect(r.content[0]?.text).toContain('50 per second');
    expect((await host.call('world_summary', {})).isError).toBeUndefined();
    t = 1001;
    expect((await host.call('set_variable', { name: 'k', value: 9 })).isError).toBeUndefined();
  });

  it('a sliding window', () => {
    const l = new RateLimiter(2, 100);
    expect([l.take(0), l.take(10), l.take(20), l.take(100), l.take(111)]).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
  });
});

describe('spreads through the agent', () => {
  it('runs a spread, saves it, and keeps and kills candidates with reasons', async () => {
    const { data, call, session } = setup({ settings: { spend: true } });
    const s = (await data('spread', {
      spot: { type: 'cell', band: 'low-sky', lane: 'items' },
      move: 'fill',
      count: 4,
    })) as { id: string; candidates: { key: string; role: string; name: string }[] };
    expect(s.candidates.length).toBeGreaterThan(1);
    expect(readSpread(session.world.spreads[s.id])).not.toBeNull();
    const [a, b] = s.candidates.filter((c) => c.role === 'new');
    const kept = (await data('judge_candidate', {
      spread: s.id,
      key: a?.key,
      verdict: 'keep',
      note: 'Fits the drift.',
    })) as { entity: string };
    expect(session.world.entities[kept.entity]?.origin.by).toBe('ai');
    expect(
      errCode(await call('judge_candidate', { spread: s.id, key: b?.key, verdict: 'kill' })),
    ).toBe('spread.kill_reason');
    const before = session.world.taste.reasons.find((r) => r.key === '1')?.count ?? 0;
    await data('judge_candidate', { spread: s.id, key: b?.key, verdict: 'kill', reason: '1' });
    const after = readSpread(session.world.spreads[s.id]);
    expect(after?.judgements[a?.key ?? '']).toMatchObject({
      verdict: 'keep',
      note: 'Fits the drift.',
    });
    expect(after?.judgements[b?.key ?? '']).toMatchObject({ verdict: 'kill', reason: '1' });
    expect(session.world.taste.reasons.find((r) => r.key === '1')?.count).toBe(before + 1);
    expect(
      errCode(await call('judge_candidate', { spread: s.id, key: a?.key, verdict: 'keep' })),
    ).toBe('spread.judged');
  });
});

describe('secrets', () => {
  it('redacts anything shaped like a key, and the process’s own keys', () => {
    const env = { OPENAI_API_KEY: 'plain-secret-value-1234567890' };
    expect(
      redactSecrets(
        'a sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX and plain-secret-value-1234567890',
        env,
      ),
    ).toBe('a [redacted] and [redacted]');
  });

  it('never returns a key pasted into the world', async () => {
    const world = sampleWorld();
    const glide = world.entities.glide;
    if (glide) glide.description = 'key: sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    const { call } = setup({ world });
    const r = await call('get_entity', { id: 'glide' });
    expect(r.content[0]?.text).not.toContain('ABCDEFGHIJKLMNOP');
    expect(r.content[0]?.text).toContain('[redacted]');
  });
});

describe('settings', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'carbon-agent-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to access on and spending off, and keeps changes and this month’s spend', async () => {
    let now = new Date('2026-11-05T00:00:00Z');
    const a = AgentSettingsStore.at(dir, () => now);
    await a.load();
    expect(a.get()).toMatchObject({ access: true, spend: false });
    await a.set({ spend: true, budget: { sessionUsd: 2, monthUsd: 3 } });
    a.add(1.5);
    await a.flush();
    const b = AgentSettingsStore.at(dir, () => now);
    await b.load();
    expect(b.get()).toMatchObject({ spend: true, budget: { sessionUsd: 2, monthUsd: 3 } });
    expect(b.spend()).toEqual({ sessionUsd: 0, monthUsd: 1.5 });
    expect(b.remaining(b.get().budget)).toBeCloseTo(1.5);
    now = new Date('2026-12-01T00:00:00Z');
    expect(b.spend().monthUsd).toBe(0);
  });

  it('falls back to the defaults on a bad file', async () => {
    writeFileSync(path.join(dir, 'agent.json'), '{ nope');
    const a = AgentSettingsStore.at(dir);
    await a.load();
    expect(a.get()).toMatchObject({ access: true, spend: false });
  });
});

describe('the socket', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'carbon-sock-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const handlers = (host: AgentHost) => ({
    version: '0.0.0-test',
    onOpen: () => undefined,
    onHello: () => undefined,
    onClose: () => undefined,
    onCall: (
      c: { client?: { name: string } },
      method: Parameters<AgentHost['handle']>[0],
      params: unknown,
    ) => host.handle(method, params, c.client?.name),
  });

  it('finds the path the same way in the app and in carbon mcp', () => {
    expect(socketPath({ CARBON_SOCKET: '/x/y.sock' })).toBe('/x/y.sock');
    expect(socketPath({ XDG_RUNTIME_DIR: '/run/user/1000' })).toBe(
      '/run/user/1000/carbon/carbon.sock',
    );
    expect(socketPath({ XDG_CONFIG_HOME: '/c' })).toBe('/c/carbon/carbon.sock');
  });

  it('listens with mode 0600, and an MCP client works through the relay', async () => {
    const file = path.join(dir, 'carbon.sock');
    const { host, session } = setup();
    const server = await AgentSocketServer.listen(file, handlers(host));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const link = await connectToCarbon(file);
    expect(link.version).toBe('0.0.0-test');
    const [a, b] = InMemoryTransport.createLinkedPair();
    const relay = createRelayServer(link);
    await relay.connect(a);
    const client = new Client({ name: 'unit-client', version: '1.2.3' });
    await client.connect(b);
    await vi.waitFor(() => expect(server.connections()[0]?.client?.name).toBe('unit-client'));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('create_entity');
    const r = await client.callTool({
      name: 'create_entity',
      arguments: { kind: 'band', name: 'Deep Dark' },
    });
    expect(r.isError).toBeFalsy();
    expect(session.world.entities['deep-dark']?.origin.by).toBe('agent');
    const bad = await client.callTool({
      name: 'set_state',
      arguments: { id: 'deep-dark', state: 'decided' },
    });
    expect(bad.isError).toBe(true);
    await client.close();
    link.close();
    await server.close();
    expect(() => statSync(file)).toThrow();
  });

  it('replaces a socket left by a crashed carbon', async () => {
    const file = path.join(dir, 'carbon.sock');
    // A carbon that crashed: a process listening on the socket, killed so it can't clean up.
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(file)}, () => process.stdout.write('up'))`,
    ]);
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(statSync(file).isSocket()).toBe(true);
    const { host } = setup();
    const server = await AgentSocketServer.listen(file, handlers(host));
    const link = await connectToCarbon(file);
    expect(link.version).toBe('0.0.0-test');
    link.close();
    await server.close();
  });

  it('leaves a live socket alone, and never removes a file that isn’t a socket', async () => {
    const file = path.join(dir, 'carbon.sock');
    const { host } = setup();
    const first = await AgentSocketServer.listen(file, handlers(host));
    await expect(AgentSocketServer.listen(file, handlers(host))).rejects.toBeInstanceOf(
      SocketInUse,
    );
    await first.close();
    const plain = path.join(dir, 'plain.sock');
    writeFileSync(plain, 'mine');
    await expect(prepareSocketPath(plain)).rejects.toThrow(/not a socket/);
    expect(statSync(plain).isFile()).toBe(true);
  });

  it('closes a connection that sends a line over the limit', async () => {
    const file = path.join(dir, 'carbon.sock');
    const { host } = setup();
    const server = await AgentSocketServer.listen(file, handlers(host));
    const s = net.connect(file);
    const closed = new Promise<string>((resolve) => {
      let got = '';
      s.setEncoding('utf8');
      s.on('data', (d: string) => (got += d));
      s.on('close', () => resolve(got));
    });
    s.write('x'.repeat(1024 * 1024 + 10));
    expect(await closed).toContain('larger than carbon accepts');
    await server.close();
  });

  it('carbon mcp says why and exits 1 when carbon quits under it', async () => {
    const file = path.join(dir, 'carbon.sock');
    const { host } = setup();
    const server = await AgentSocketServer.listen(file, handlers(host));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const lines: string[] = [];
    const done = runRelay({
      env: { CARBON_SOCKET: file },
      transport: a,
      stderr: (l) => lines.push(l),
    });
    const client = new Client({ name: 'c', version: '1' });
    await client.connect(b);
    expect((await client.listTools()).tools.length).toBe(TOOLS.length);
    await server.close();
    expect(await done).toBe(1);
    expect(lines).toEqual(['carbon mcp: carbon is closing']);
  });

  it('carbon mcp exits 0 when the agent hangs up', async () => {
    const file = path.join(dir, 'carbon.sock');
    const { host } = setup();
    const server = await AgentSocketServer.listen(file, handlers(host));
    const [a, b] = InMemoryTransport.createLinkedPair();
    const done = runRelay({ env: { CARBON_SOCKET: file }, transport: a, stderr: () => undefined });
    const client = new Client({ name: 'c', version: '1' });
    await client.connect(b);
    await client.close();
    expect(await done).toBe(0);
    await vi.waitFor(() => expect(server.connections()).toHaveLength(0));
    await server.close();
  });

  it('carbon mcp with no carbon running exits 1 with one clear line', async () => {
    const lines: string[] = [];
    const code = await runRelay({
      env: { CARBON_SOCKET: path.join(dir, 'none.sock') },
      stderr: (l) => lines.push(l),
    });
    expect(code).toBe(1);
    expect(lines).toEqual([
      "carbon mcp: carbon isn't running. Start it (`carbon`), then connect the agent again.",
    ]);
    await expect(connectToCarbon(path.join(dir, 'none.sock'))).rejects.toBeInstanceOf(RelayError);
  });
});

describe('the session', () => {
  it('marks a step taken inside an agent’s call as the agent’s, and only that one', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'carbon-agent-session-'));
    try {
      await writeWorldDir(dir, sampleWorld());
      const session = await WorldSession.open(dir, () => NOW);
      const by: (string | undefined)[] = [];
      session.onPatch((e) => by.push(e.by));
      await asAgent(() =>
        Promise.resolve(session.dispatch([cmd('numbers.setVariable', { name: 'k', value: 1 })])),
      );
      session.dispatch([cmd('numbers.setVariable', { name: 'k', value: 2 })]);
      session.dispatch([cmd('numbers.setVariable', { name: 'k', value: 3 })], 'x', undefined, {
        by: 'agent',
      });
      expect(by).toEqual(['agent', undefined, 'agent']);
      await session.flush();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
