import fc from 'fast-check';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeAiGateway } from '@core/ai/fake';
import type { AiGateway } from '@core/ai/gateway';
import { applyCommands } from '@core/commands/apply';
import { cmd, type Command } from '@core/commands/registry';
import type { FieldDef } from '@core/model/fields';
import type { Note } from '@core/model/notes';
import { schemaOf, type World } from '@core/model/world';
import { sampleWorld } from '@core/testing/sample';
import { createBenchAi, errorText } from './ai';
import { critiqueNotes, critiqueSource } from './critique';
import { incomingTo, refTargets, relationTypesFrom, targetsFor } from './relations';
import { RequestSlots } from './slots';
import { benchStore, fieldId } from './store';
import {
  attributesFor,
  checkValue,
  COMMON_DEFS,
  defOf,
  formatValue,
  isTextual,
  parseNumber,
  parseText,
} from './value';

const ctx = { now: '2026-11-02T00:00:00.000Z' };
const def = (type: FieldDef['type'], extra: Partial<FieldDef> = {}): FieldDef => ({
  key: 'f',
  label: 'F',
  type,
  ...extra,
});

describe('values', () => {
  it('parses numbers by hand, with the typographic minus', () => {
    expect(parseNumber('12.5')).toBe(12.5);
    expect(parseNumber('−3')).toBe(-3);
    expect(parseNumber(' 1,200 ')).toBe(1200);
    expect(parseNumber('1e3')).toBe(1000);
    expect(parseNumber('abc')).toBeNull();
    expect(parseNumber('')).toBeNull();
  });

  it('parses each typed field type', () => {
    expect(parseText(def('number', { min: -1, max: 1 }), '0.5')).toEqual({ ok: true, value: 0.5 });
    expect(parseText(def('number', { min: -1, max: 1 }), '2')).toEqual({
      ok: false,
      error: 'At most 1',
    });
    expect(parseText(def('number'), 'x')).toEqual({ ok: false, error: 'A number' });
    expect(parseText(def('height'), '+∞')).toEqual({ ok: true, value: '+inf' });
    expect(parseText(def('height'), '−inf')).toEqual({ ok: true, value: '-inf' });
    expect(parseText(def('height'), '−512')).toEqual({ ok: true, value: -512 });
    expect(parseText(def('height'), 'deep')).toEqual({ ok: false, error: 'A height, or ±∞' });
    expect(parseText(def('list'), 'glows, , brittle ')).toEqual({
      ok: true,
      value: ['glows', 'brittle'],
    });
    expect(parseText(def('text'), '  ')).toEqual({ ok: true, value: null });
    expect(parseText(COMMON_DEFS.name, '  ')).toEqual({
      ok: false,
      error: 'An entity needs a name',
    });
    expect(parseText(def('enum', { options: ['a', 'b'] }), 'c')).toEqual({
      ok: false,
      error: 'One of a, b',
    });
    expect(parseText(def('longtext'), '  line one\n\nline two  ')).toEqual({
      ok: true,
      value: 'line one\n\nline two',
    });
    expect(parseText(def('steps'), 'x').ok).toBe(false);
  });

  it('round-trips format → parse for textual fields (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e6, max: 1e6 }), (n) => {
        for (const t of ['number', 'height'] as const) {
          const d = def(t);
          expect(parseText(d, formatValue(d, n))).toEqual({ ok: true, value: n });
        }
      }),
    );
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z ]{0,10}[a-z]$/), { minLength: 1, maxLength: 5 }),
        (xs) => {
          const d = def('list');
          expect(parseText(d, formatValue(d, xs))).toEqual({ ok: true, value: xs });
        },
      ),
    );
    for (const h of ['+inf', '-inf'] as const)
      expect(parseText(def('height'), formatValue(def('height'), h))).toEqual({
        ok: true,
        value: h,
      });
  });

  it('formats every type for display', () => {
    expect(formatValue(def('range'), { min: 1, max: 3 })).toBe('1 … 3');
    expect(
      formatValue(def('climate'), {
        temperature: { min: 0.1, max: 0.2 },
        moisture: { min: 0.3, max: 0.4 },
      }),
    ).toBe('temperature 0.1–0.2, moisture 0.3–0.4');
    expect(formatValue(def('steps'), [{ text: 'a' }, { text: 'b' }])).toBe('1. a  2. b');
    expect(formatValue(def('boolean'), true)).toBe('yes');
    expect(formatValue(def('number'), undefined)).toBe('');
    expect(formatValue(def('number'), -2)).toBe('−2');
  });

  it('checks values the way the commands do', () => {
    const w = sampleWorld();
    const item = schemaOf(w).kinds.item;
    expect(checkValue(defOf(item, 'subkind')!, 'armor')).toEqual({ ok: true, value: 'armor' });
    expect(checkValue(defOf(item, 'subkind')!, 'hat').ok).toBe(false);
    expect(checkValue(defOf(item, 'route')!, [{ text: 'x' }]).ok).toBe(true);
    expect(checkValue(defOf(item, 'route')!, [{ nope: 1 }]).ok).toBe(false);
    expect(checkValue(COMMON_DEFS.tags, ['a']).ok).toBe(true);
    expect(checkValue(COMMON_DEFS.tags, 'a').ok).toBe(false);
    expect(checkValue(defOf(item, 'tradeoff')!, '')).toEqual({ ok: true, value: null });
    expect(defOf(item, 'identity')).toBe(COMMON_DEFS.identity);
    expect(defOf(item, 'nope')).toBeUndefined();
    expect(isTextual(defOf(item, 'route')!)).toBe(false);
    expect(isTextual(defOf(item, 'tradeoff')!)).toBe(true);
  });

  it('applies attribute definitions by their conditions', () => {
    const w = sampleWorld();
    const item = schemaOf(w).kinds.item;
    expect(attributesFor(item, w.entities['vent-glass-visor']!).map((a) => a.key)).toEqual([
      'defense',
    ]);
    expect(attributesFor(item, w.entities['cinder-sting']!).map((a) => a.key)).toEqual(['damage']);
    expect(attributesFor(item, w.entities['spore-lantern']!)).toEqual([]);
  });
});

describe('relations', () => {
  const w = sampleWorld();
  it('offers only the types an entity kind may have', () => {
    const types = relationTypesFrom(w, 'material').map((r) => r.type);
    expect(types).toContain('found_in');
    expect(types).not.toContain('made_from');
    expect(relationTypesFrom(w, 'band').map((r) => r.type)).not.toContain('in_band');
  });

  it('offers only targets the commands accept (property over every type and entity)', () => {
    for (const e of Object.values(w.entities))
      for (const r of relationTypesFrom(w, e.kind))
        for (const t of targetsFor(w, e, r.type)) {
          const out = applyCommands(
            w,
            [cmd('relation.add', { from: e.id, type: r.type, to: t.id })],
            ctx,
          );
          expect(out.ok, `${e.id} ${r.type} ${t.id}`).toBe(true);
        }
  });

  it('leaves out existing relations, itself and cycles', () => {
    const lantern = w.entities['spore-lantern']!;
    const made = targetsFor(w, lantern, 'made_from').map((t) => t.id);
    expect(made).not.toContain('lumen-spore');
    expect(made).toContain('vent-glass');
    // cloud-anklet supersedes spore-lantern, so spore-lantern can't supersede cloud-anklet.
    expect(targetsFor(w, lantern, 'supersedes').map((t) => t.id)).not.toContain('cloud-anklet');
    expect(targetsFor(w, lantern, 'supersedes').map((t) => t.id)).not.toContain('spore-lantern');
    expect(targetsFor(w, lantern, 'nope')).toEqual([]);
  });

  it('reads incoming relations from the other side', () => {
    const inc = incomingTo(w, 'lumen-spore');
    expect(inc.map((i) => [i.from.id, i.label])).toEqual([
      ['moss-grazer', 'dropped by'],
      ['spore-lantern', 'made into'],
    ]);
    // Symmetric relations are on both ends, so they don't show twice.
    expect(incomingTo(w, 'glide').map((i) => i.type)).not.toContain('pairs_with');
  });

  it('lists ref targets by kind', () => {
    expect(refTargets(w, ['band'], 'x').map((e) => e.kind)).toEqual([
      'band',
      'band',
      'band',
      'band',
      'band',
    ]);
  });
});

describe('critique notes', () => {
  it('maps critique to stable notes about existing entities', () => {
    const w = sampleWorld();
    const notes = critiqueNotes(w, 'glide', [
      { kind: 'duplicate', text: 'Glide duplicates X.', entities: ['cinder-sting', 'ghost'] },
      { kind: 'weak_identity', text: 'Sharper.', entities: [], field: 'identity' },
      { kind: 'weak_identity', text: 'Sharper.', entities: [], field: 'identity' },
    ]);
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatchObject({
      source: 'ai',
      severity: 'warn',
      entities: ['glide', 'cinder-sting'],
      kind: 'duplicate',
    });
    expect(
      critiqueNotes(w, 'glide', [
        { kind: 'duplicate', text: 'Glide duplicates X.', entities: [] },
      ])[0]!.id,
    ).toBe(notes[0]!.id);
    expect(critiqueSource('glide')).toBe('ai:glide');
  });
});

describe('request slots', () => {
  it('cancels the stale request per entity and channel only', () => {
    const s = new RequestSlots();
    const a = s.start('e', 'field');
    const c = s.start('e', 'critique');
    const other = s.start('f', 'field');
    const b = s.start('e', 'field');
    expect(a.aborted).toBe(true);
    expect(b.aborted).toBe(false);
    expect(c.aborted).toBe(false);
    expect(other.aborted).toBe(false);
    expect(s.isCurrent('e', 'field', a)).toBe(false);
    expect(s.isCurrent('e', 'field', b)).toBe(true);
    s.finish('e', 'field', a); // stale finish does nothing
    expect(s.isCurrent('e', 'field', b)).toBe(true);
    s.finish('e', 'field', b);
    expect(s.size).toBe(2);
    s.cancel('e');
    expect(c.aborted).toBe(true);
    expect(s.size).toBe(1);
  });
});

describe('bench AI', () => {
  let world: World;
  let notes: Record<string, Note[]>;
  let said: string[];
  const reset = (): void =>
    benchStore.set({
      field: null,
      pending: {},
      three: null,
      loading: {},
      critiquing: {},
      shown: {},
      focusRequest: null,
      error: {},
    });
  const make = (gateway?: AiGateway) =>
    createBenchAi({
      gateway: gateway ?? new FakeAiGateway({ getWorld: () => world }),
      getWorld: () => world,
      dispatch: (_label: string, commands: Command[]) => {
        const r = applyCommands(world, commands, ctx);
        if (!r.ok)
          return Promise.resolve({ ok: false as const, error: { message: r.error.message } });
        world = r.value.world;
        return Promise.resolve({ ok: true as const });
      },
      publishNotes: (s, n) => {
        notes[s] = n;
      },
      say: (t) => said.push(t),
    });
  beforeEach(() => {
    world = sampleWorld();
    notes = {};
    said = [];
    reset();
  });

  it('tab shows one suggestion, tab accepts it with the ai marker, tab again gives another', async () => {
    const b = make();
    await b.suggestOne('glide', 'gates');
    const first = benchStore.get().pending[fieldId('glide', 'gates')];
    expect(first?.from).toBe('suggest');
    await b.suggestOne('glide', 'gates');
    expect(world.entities['glide']!.fields.gates).toBe(first!.value);
    expect(world.entities['glide']!.ai_fields).toContain('gates');
    await b.suggestOne('glide', 'gates');
    const second = benchStore.get().pending[fieldId('glide', 'gates')];
    expect(second).toBeDefined();
    expect(second!.value).not.toEqual(first!.value);
    b.dismiss('glide', 'gates');
    expect(benchStore.get().pending[fieldId('glide', 'gates')]).toBeUndefined();
  });

  it('shift+tab gives three valid alternatives and picks one', async () => {
    const b = make();
    await b.suggestThree('spore-lantern', 'moment');
    const t = benchStore.get().three;
    expect(t?.options).toHaveLength(3);
    await b.pickThree(1);
    expect(world.entities['spore-lantern']!.fields.moment).toBe(t!.options[1]!.value);
    expect(benchStore.get().three).toBeNull();
  });

  it('fill proposes only for empty fields, each accepted or rejected on its own', async () => {
    const b = make();
    await b.fill('sky-coral');
    const ps = b.proposalsOf('sky-coral');
    expect(ps.length).toBeGreaterThan(1);
    for (const [k] of ps) {
      const key = k.slice('sky-coral:'.length);
      expect(key).not.toBe('name');
      expect(key).not.toBe('rarity'); // already filled
      expect(key).not.toBe('identity'); // already filled
    }
    const [firstKey] = ps[0]!;
    const key = firstKey.slice('sky-coral:'.length);
    await b.accept('sky-coral', key);
    expect(world.entities['sky-coral']!.ai_fields).toContain(key);
    const [secondKey] = b.proposalsOf('sky-coral')[0]!;
    b.dismiss('sky-coral', secondKey.slice('sky-coral:'.length));
    expect(b.proposalsOf('sky-coral').length).toBe(ps.length - 2);
    await b.acceptAll('sky-coral');
    expect(b.proposalsOf('sky-coral')).toEqual([]);
    expect(world.entities['sky-coral']!.ai_fields.length).toBe(ps.length - 1);
  });

  it('critique publishes notes under ai:<id>', async () => {
    const r = applyCommands(
      world,
      [cmd('entity.update', { id: 'glide', set: { identity: 'Fly' } })],
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    world = r.value.world;
    const b = make();
    await b.critique('glide', 'finish_edit');
    expect(notes['ai:glide']?.some((n) => n.kind === 'weak_identity')).toBe(true);
    expect(benchStore.get().critiquing['glide']).toBeUndefined();
  });

  it('a newer request cancels the stale one, whose result is never shown', async () => {
    const slow = new FakeAiGateway({ getWorld: () => world, delayMs: 30 });
    const b = make(slow);
    const first = b.suggestOne('glide', 'gates');
    const second = b.suggestThree('glide', 'gates');
    await Promise.all([first, second]);
    expect(benchStore.get().pending[fieldId('glide', 'gates')]).toBeUndefined();
    expect(benchStore.get().three?.options).toHaveLength(3);
    const log = await slow.log();
    expect(log.map((l) => l.outcome)).toEqual(['cancelled', 'ok']);
  });

  it('says why when the AI is off, and stays quiet for unasked critiques', async () => {
    const off = new FakeAiGateway({ getWorld: () => world });
    off.setEnabled(false);
    const b = make(off);
    await b.suggestOne('glide', 'gates');
    expect(said).toEqual(['AI is off for this session']);
    await b.critique('glide', 'finish_edit');
    expect(said).toHaveLength(1);
    await b.critique('glide', 'on_demand');
    expect(said).toHaveLength(2);
    expect(errorText({ code: 'cancelled', message: '', retryable: false })).toBeNull();
    expect(errorText({ code: 'budget', message: '', retryable: false })).toMatch(/budget/);
  });

  it('never suggests for a field the schema keeps from the AI', async () => {
    world = {
      ...world,
      schema: {
        ...world.schema,
        kinds: {
          capability: { fields: [{ key: 'gates', label: 'Gates', type: 'text', ai: false }] },
        },
      },
    };
    const b = make();
    await b.suggestOne('glide', 'gates');
    expect(benchStore.get().pending).toEqual({});
  });
});
