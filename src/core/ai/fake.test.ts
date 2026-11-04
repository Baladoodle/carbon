import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { cmd } from '../commands/registry';
import { getEntity } from '../model/world';
import { sampleWorld } from '../testing/sample';
import { FakeAiGateway } from './fake';
import { AiStatusSchema } from './gateway';
import type { Candidate } from './moments';

const world = sampleWorld();
const fake = (extra: Partial<ConstructorParameters<typeof FakeAiGateway>[0]> = {}): FakeAiGateway =>
  new FakeAiGateway({ getWorld: () => world, ...extra });
const ctx = { now: '2026-11-04T10:00:00.000Z' };

describe('FakeAiGateway', () => {
  it('is deterministic', async () => {
    const a = await fake().run('spread', {
      spot: { type: 'cell', band: 'low-sky', lane: 'items' },
      move: 'fill',
    });
    const b = await fake().run('spread', {
      spot: { type: 'cell', band: 'low-sky', lane: 'items' },
      move: 'fill',
    });
    expect(a).toEqual(b);
  });

  it('suggests field values that commands accept, and avoids repeats', async () => {
    const g = fake();
    for (const e of Object.values(world.entities)) {
      for (const field of ['name', 'identity', ...Object.keys(e.fields)]) {
        const one = await g.run('suggest_one', { entityId: e.id, field });
        if (!one.ok) throw new Error(one.error.message);
        const r = applyCommand(
          world,
          cmd('entity.setField', {
            id: e.id,
            field,
            value: one.result.suggestion.value,
            source: 'ai',
          }),
          ctx,
        );
        expect(r.ok, `${e.id}.${field}`).toBe(true);
      }
    }
    const three = await g.run('suggest_three', { entityId: 'spore-lantern', field: 'tradeoff' });
    if (!three.ok) throw new Error('failed');
    const values = three.result.suggestions.map((s) => s.value);
    expect(new Set(values.map((v) => JSON.stringify(v))).size).toBe(3);
    const again = await g.run('suggest_one', {
      entityId: 'spore-lantern',
      field: 'tradeoff',
      avoid: values,
    });
    expect(again.ok && values).not.toContainEqual(again.ok ? again.result.suggestion.value : null);
  });

  it('fills every empty field with values the world accepts', async () => {
    for (const e of Object.values(world.entities)) {
      const out = await fake().run('fill_entity', { entityId: e.id });
      if (!out.ok) throw new Error(out.error.message);
      const set = Object.fromEntries(out.result.proposals.map((p) => [p.field, p.value]));
      const r = applyCommand(world, cmd('entity.update', { id: e.id, set, source: 'ai' }), ctx);
      expect(r.ok, e.id).toBe(true);
    }
  });

  it('critiques with notes that reference real entities', async () => {
    const w2 = applyCommand(
      world,
      cmd('entity.create', { kind: 'material', name: 'Lumen-Spore', id: 'lumen-spore-2' }),
      ctx,
    );
    if (!w2.ok) throw new Error('setup');
    const out = await new FakeAiGateway({ getWorld: () => w2.value.world }).run('critique', {
      entityId: 'lumen-spore-2',
      trigger: 'on_demand',
    });
    if (!out.ok) throw new Error(out.error.message);
    expect(out.result.notes.map((n) => n.kind)).toEqual(['weak_identity', 'duplicate']);
    expect(out.result.notes[1]?.entities).toEqual(['lumen-spore']);
    for (const e of Object.values(world.entities)) {
      const r = await fake().run('critique', { entityId: e.id, trigger: 'finish_edit' });
      expect(r.ok).toBe(true);
    }
  });

  it('streams spread candidates that can become entities, with one wildcard', async () => {
    const seen: Candidate[] = [];
    const out = await fake().run(
      'spread',
      { spot: { type: 'cell', band: 'hollows', lane: 'creatures' }, move: 'fill', count: 9 },
      { onPartial: (c) => seen.push(c) },
    );
    if (!out.ok) throw new Error(out.error.message);
    expect(seen).toEqual(out.result.candidates);
    expect(seen).toHaveLength(9);
    expect(seen.filter((c) => c.wildcard)).toHaveLength(1);
    for (const c of seen) {
      expect(c.kind).toBe('creature');
      const r = applyCommand(
        world,
        cmd('entity.create', {
          kind: 'creature',
          name: c.name,
          identity: c.identity,
          relations: c.relations,
          origin: { by: 'ai', moment: 'spread' },
        }),
        ctx,
      );
      expect(r.ok).toBe(true);
    }
    const kinds = await Promise.all(
      [
        {
          type: 'region' as const,
          band: 'hollows',
          climate: { temperature: { min: 0, max: 1 }, moisture: { min: 0, max: 1 } },
        },
        { type: 'selection' as const, entities: ['glide'] },
        { type: 'entity' as const, entity: 'cinder-wasp' },
        { type: 'note' as const, note: 'n1', entities: [] },
      ].map(async (spot) => {
        const r = await fake().run('spread', { spot, move: 'break', count: 2 });
        return r.ok ? r.result.candidates.map((c) => c.kind) : r.error.code;
      }),
    );
    expect(kinds).toEqual([
      [null, null],
      [null, null],
      [null, null],
      [null, null],
    ]);
    const grounded = await fake().run('spread', {
      spot: { type: 'entity', entity: 'cinder-wasp' },
      move: 'ground',
      count: 1,
      direction: 'deeper',
    });
    expect(grounded.ok && grounded.result.candidates[0]).toMatchObject({
      about: 'cinder-wasp',
      kind: 'creature',
      rationale: 'Follows "deeper".',
    });
  });

  it('learns patterns and drafts specs', async () => {
    const p = await fake().run('patterns', {
      judgements: [
        {
          candidate: { name: 'A', identity: 'a', kind: 'item' },
          verdict: 'kill',
          reason: 'seen it',
        },
        { candidate: { name: 'B', identity: 'b', kind: 'item' }, verdict: 'keep' },
      ],
    });
    expect(p.ok && p.result.patterns).toEqual([
      { text: 'You kill candidates that are "seen it".', examples: ['A'], strength: 0.7 },
    ]);
    const s = await fake().run('spec_draft', { entityIds: ['cinder-sting'], name: 'First weapon' });
    expect(s.ok && s.result.markdown).toContain('## Cinder Sting');
    expect(await fake().run('spec_draft', { entityIds: ['ghost'], name: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('reports bad requests, missing entities, the off switch, failures and cancellation', async () => {
    const g = fake({ delayMs: 5 });
    expect(await g.run('critique', { entityId: 'NOPE', trigger: 'on_demand' })).toMatchObject({
      ok: false,
      error: { code: 'bad_request' },
    });
    expect(await g.run('critique', { entityId: 'ghost', trigger: 'on_demand' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const statuses: boolean[] = [];
    const off = g.onStatus((s) => statuses.push(s.enabled));
    g.setEnabled(false);
    expect(AiStatusSchema.parse(g.status())).toMatchObject({ enabled: false, mode: 'fake' });
    expect(await g.run('fill_entity', { entityId: 'glide' })).toMatchObject({
      ok: false,
      error: { code: 'disabled' },
    });
    g.setEnabled(true);
    off();
    expect(statuses).toEqual([false, true]);
    const ac = new AbortController();
    const pending = g.run(
      'spread',
      { spot: { type: 'entity', entity: 'glide' }, move: 'vary' },
      { signal: ac.signal },
    );
    expect(g.status().pending).toBe(1);
    ac.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    const ac2 = new AbortController();
    const p2 = g.run(
      'critique',
      { entityId: 'glide', trigger: 'on_demand' },
      { signal: ac2.signal },
    );
    ac2.abort();
    expect(await p2).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(
      await fake({ failWith: 'rate_limited' }).run('critique', {
        entityId: 'glide',
        trigger: 'on_demand',
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'rate_limited', retryable: true },
    });
    const log = await g.log();
    expect(log.map((l) => l.outcome)).toEqual(['error', 'cancelled', 'cancelled']);
    expect(getEntity(world, 'glide')).toBeDefined();
  });
});
