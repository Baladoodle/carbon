import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { World } from '../model/world';
import { commandArb } from '../testing/arbitraries';
import { sampleWorld } from '../testing/sample';
import { applyCommand } from './apply';
import { emptyHistory, record, redo, undo, type History } from './history';
import { cmd } from './registry';

const ctx = { now: '2026-11-04T10:00:00.000Z' };

function run(
  w: World,
  h: History,
  c: Parameters<typeof applyCommand>[1],
): { w: World; h: History } {
  const r = applyCommand(w, c, ctx);
  if (!r.ok) return { w, h };
  return {
    w: r.value.world,
    h: record(h, { label: c.type, patch: r.value.patch, inverse: r.value.inverse }),
  };
}

describe('history', () => {
  it('undoes and redoes, and a new step clears redo', () => {
    const w0 = sampleWorld();
    const first = run(w0, emptyHistory(), cmd('entity.create', { kind: 'feat', name: 'Leap' }));
    const w1 = first.w;
    const u = undo(first.w, first.h);
    expect(u?.ok).toBe(true);
    if (!u?.ok) return;
    expect(u.value.world).toEqual(w0);
    expect(u.value.label).toBe('entity.create');
    const r = redo(u.value.world, u.value.history);
    if (!r?.ok) throw new Error('redo failed');
    expect(r.value.world).toEqual(w1);
    expect(redo(r.value.world, r.value.history)).toBeNull();
    const { h } = run(
      u.value.world,
      u.value.history,
      cmd('numbers.setVariable', { name: 'k', value: 1 }),
    );
    expect(h.future).toEqual([]);
    expect(undo(w0, emptyHistory())).toBeNull();
  });

  it('keeps at most `limit` steps', () => {
    let s = { w: sampleWorld(), h: emptyHistory(3) };
    for (let i = 0; i < 5; i++)
      s = run(s.w, s.h, cmd('numbers.setVariable', { name: 'k', value: i }));
    expect(s.h.past).toHaveLength(3);
  });

  it('property: undoing everything restores the start; redoing everything restores the end', () => {
    const ids = Object.keys(sampleWorld().entities);
    fc.assert(
      fc.property(fc.array(commandArb(ids), { maxLength: 10 }), (cmds) => {
        const w0 = sampleWorld();
        let s = { w: w0, h: emptyHistory() };
        for (const c of cmds) s = run(s.w, s.h, c);
        const end = s.w;
        let w = s.w;
        let h = s.h;
        for (let step = undo(w, h); step; step = undo(w, h)) {
          if (!step.ok) throw new Error(step.error.message);
          ({ world: w, history: h } = step.value);
        }
        expect(w).toEqual(w0);
        for (let step = redo(w, h); step; step = redo(w, h)) {
          if (!step.ok) throw new Error(step.error.message);
          ({ world: w, history: h } = step.value);
        }
        expect(w).toEqual(end);
      }),
      { numRuns: 200 },
    );
  });
});
