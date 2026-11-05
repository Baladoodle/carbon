import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import type { Patch } from '../commands/patch';
import { cmd } from '../commands/registry';
import { sampleWorld } from '../testing/sample';
import { awkwardNumber, awkwardText } from '../testing/arbitraries';
import {
  canonicalDescription,
  canonicalFormulas,
  canonicalPatch,
  canonicalValue,
} from './canonical';
import { entityFromMarkdown, entityToMarkdown } from './entity-file';

const ctx = { now: '2026-11-05T10:00:00.000Z' };

describe('canonicalValue', () => {
  it('turns CR LF and lone CRs into LF, and -0 into 0, at any depth', () => {
    const v = canonicalValue({ a: 'x\r\ny\rz', b: [-0, { c: -0, d: 'ok' }], e: null, f: true });
    expect(v).toEqual({ a: 'x\ny\nz', b: [0, { c: 0, d: 'ok' }], e: null, f: true });
    expect(Object.is((v as { b: [number] }).b[0], 0)).toBe(true);
  });

  it('returns the same object when nothing changes (no copies on the hot path)', () => {
    const v = { a: 'x\ny', b: [1, { c: 2 }] };
    expect(canonicalValue(v)).toBe(v);
    const changed = { keep: { deep: [1, 2] }, fix: -0 };
    const out = canonicalValue(changed) as typeof changed;
    expect(out).not.toBe(changed);
    expect(out.keep).toBe(changed.keep);
  });

  it('property: idempotent', () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.array(fc.oneof(awkwardText, awkwardNumber)), (j, xs) => {
        const once = canonicalValue([j, xs]);
        expect(canonicalValue(once)).toBe(once);
      }),
    );
  });
});

describe('canonicalPatch', () => {
  it('trims a description wherever a patch sets it', () => {
    const e = { id: 'x', description: 'body\r\n\n  ' };
    const out = canonicalPatch([
      { op: 'set', path: ['entities'], value: { x: e } },
      { op: 'set', path: ['entities', 'x'], value: e },
      { op: 'set', path: ['entities', 'x', 'description'], value: 'body  \n' },
      { op: 'set', path: ['entities', 'x', 'identity'], value: 'kept  ' },
    ]);
    expect(out).toEqual([
      { op: 'set', path: ['entities'], value: { x: { id: 'x', description: 'body' } } },
      { op: 'set', path: ['entities', 'x'], value: { id: 'x', description: 'body' } },
      { op: 'set', path: ['entities', 'x', 'description'], value: 'body' },
      { op: 'set', path: ['entities', 'x', 'identity'], value: 'kept  ' },
    ]);
  });

  it('drops a leading byte-order mark from the formula source', () => {
    const out = canonicalPatch([
      { op: 'set', path: ['numbers', 'formulas'], value: '﻿k = 1\r\n' },
      { op: 'set', path: ['numbers'], value: { formulas: '﻿k = 2', variables: {} } },
    ]);
    expect(out).toEqual([
      { op: 'set', path: ['numbers', 'formulas'], value: 'k = 1\n' },
      { op: 'set', path: ['numbers'], value: { formulas: 'k = 2', variables: {} } },
    ]);
  });

  it('returns the same patch when nothing changes, and leaves removes alone', () => {
    const p: Patch = [
      { op: 'set', path: ['settings', 'name'], value: 'World' },
      { op: 'remove', path: ['entities', 'x'] },
    ];
    expect(canonicalPatch(p)).toBe(p);
  });

  it('the description rule is the entity file’s: what it writes, it reads back', () => {
    fc.assert(
      fc.property(awkwardText, (d) => {
        const e = { ...sampleWorld().entities.glide!, description: canonicalDescription(d) };
        const r = entityFromMarkdown(entityToMarkdown(e));
        if (!r.ok) throw new Error(r.error.message);
        expect(r.value.description).toBe(e.description);
      }),
      { numRuns: 1000 },
    );
    expect(canonicalFormulas('﻿﻿k')).toBe('﻿k'); // only the file's own mark
  });
});

describe('commands store the canonical form', () => {
  it('in the world and in the patch sent to the renderer', () => {
    const r = applyCommand(
      sampleWorld(),
      cmd('entity.update', { id: 'glide', set: { description: 'a\r\nb\n\n', why: 'c\rd' } }),
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.world.entities.glide?.description).toBe('a\nb');
    expect(r.value.world.entities.glide?.why).toBe('c\nd');
    expect(JSON.stringify(r.value.patch)).not.toContain('\\r');
    const v = applyCommand(
      sampleWorld(),
      cmd('numbers.setVariable', { name: 'k', value: -0 }),
      ctx,
    );
    if (!v.ok) throw new Error(v.error.message);
    expect(Object.is(v.value.world.numbers.variables.k, 0)).toBe(true);
  });
});
