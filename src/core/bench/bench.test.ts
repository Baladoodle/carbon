import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommands } from '@core/commands/apply';
import { cmd } from '@core/commands/registry';
import type { FieldDef } from '@core/model/fields';
import { schemaOf } from '@core/model/world';
import { sampleWorld } from '@core/testing/sample';
import { critiqueNotes, critiqueSource, staleCritiqueSources } from './critique';
import { incomingTo, refTargets, relationTypesFrom, targetsFor } from './relations';
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

describe('stale critiques', () => {
  it('names the critique sources of entities that no longer exist', () => {
    const w = sampleWorld();
    expect(
      staleCritiqueSources(['checks', critiqueSource('glide'), critiqueSource('gone'), 'ai:'], w),
    ).toEqual([critiqueSource('gone')]);
  });
});
