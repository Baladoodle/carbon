import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import type { World } from '../model/world';
import { sampleWorld } from '../testing/sample';
import { runChecks } from './runner';

/**
 * A dismissal holds while a note's id and inputs hash stay the same. Entity
 * ids are slugs of names, so a deleted entity's id comes back with the next
 * entity of that name: its notes must not inherit the old one's dismissals.
 */
const at = (now: string) => ({ now });
const step = (w: World, c: Command, now = '2026-11-05T10:00:00.000Z'): World => {
  const r = applyCommand(w, c, at(now));
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.world;
};

describe('check notes and reused ids', () => {
  it('a new entity with a deleted one’s id gets a new inputs hash for the same note', () => {
    let w = sampleWorld();
    w = step(
      w,
      cmd('entity.create', { kind: 'item', name: 'Spore Lantern', fields: { subkind: 'tool' } }),
    );
    const before = runChecks(w).filter((n) => n.entities.includes('spore-lantern-2'));
    expect(before.length).toBeGreaterThan(0);
    w = step(w, cmd('entity.delete', { id: 'spore-lantern-2' }));
    w = step(
      w,
      cmd('entity.create', { kind: 'item', name: 'Spore Lantern', fields: { subkind: 'tool' } }),
      '2026-11-06T09:00:00.000Z',
    );
    const after = runChecks(w).filter((n) => n.entities.includes('spore-lantern-2'));
    for (const n of after) {
      const old = before.find((b) => b.id === n.id);
      if (old) expect(n.inputsHash, n.id).not.toBe(old.inputsHash);
    }
    expect(after.some((n) => before.some((b) => b.id === n.id))).toBe(true);
  });

  it('the same entity back (an undo of its delete) keeps the hash, so its dismissal holds', () => {
    let w = sampleWorld();
    w = step(
      w,
      cmd('entity.create', { kind: 'item', name: 'Spore Lantern', fields: { subkind: 'tool' } }),
    );
    const before = runChecks(w).filter((n) => n.entities.includes('spore-lantern-2'));
    const r = applyCommand(
      w,
      cmd('entity.delete', { id: 'spore-lantern-2' }),
      at('2026-11-05T11:00:00.000Z'),
    );
    if (!r.ok) throw new Error('delete');
    const { applyPatch } = await_import_patch();
    const back = applyPatch(r.value.world, r.value.inverse);
    const after = runChecks(back).filter((n) => n.entities.includes('spore-lantern-2'));
    expect(after.map((n) => [n.id, n.inputsHash])).toEqual(before.map((n) => [n.id, n.inputsHash]));
  });

  it('an edit that changes nothing a note says keeps its hash', () => {
    let w = sampleWorld();
    w = step(
      w,
      cmd('entity.create', { kind: 'item', name: 'Spore Lantern', fields: { subkind: 'tool' } }),
    );
    const before = runChecks(w).filter((n) => n.entities.includes('spore-lantern-2'));
    w = step(
      w,
      cmd('entity.update', { id: 'spore-lantern-2', set: { description: 'unrelated' } }),
      '2026-11-07T00:00:00.000Z',
    );
    const after = runChecks(w).filter((n) => n.entities.includes('spore-lantern-2'));
    expect(after.map((n) => n.inputsHash)).toEqual(before.map((n) => n.inputsHash));
  });
});

import * as patchModule from '../commands/patch';
function await_import_patch(): typeof patchModule {
  return patchModule;
}
