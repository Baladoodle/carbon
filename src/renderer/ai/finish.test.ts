import { describe, expect, it } from 'vitest';
import { applyCommands } from '@core/commands/apply';
import { cmd, type Command } from '@core/commands/registry';
import type { World } from '@core/model/world';
import { sampleWorld } from '@core/testing/sample';
import { createFinishTriggers, fieldSnapshot, userChangedFields } from './finish';

function setup(opts: { allowed?: boolean } = {}) {
  let world: World = sampleWorld();
  const calls: [string, string][] = [];
  let pending: Promise<unknown> = Promise.resolve();
  const t = createFinishTriggers({
    getWorld: () => world,
    critique: (id, trigger) => {
      calls.push([id, trigger]);
      return Promise.resolve();
    },
    settled: () => pending,
    allowed: () => opts.allowed ?? true,
  });
  let n = 0;
  const apply = (c: Command): void => {
    const r = applyCommands(world, [c], { now: `2026-01-02T00:00:0${++n}.000Z` });
    if (!r.ok) throw new Error(r.error.message);
    world = r.value.world;
  };
  return {
    t,
    calls,
    apply,
    world: () => world,
    delay: (p: Promise<unknown>) => (pending = p),
  };
}

describe('the automatic critique triggers', () => {
  it('critiques an entity you changed when focus leaves it, and never one you did not', async () => {
    const s = setup();
    await s.t.focusChanged('glide');
    await s.t.focusChanged('sunken-stair');
    expect(s.calls).toEqual([]);
    await s.t.focusChanged('glide');
    s.apply(cmd('entity.update', { id: 'glide', set: { identity: 'Ride the updraft' } }));
    await s.t.focusChanged('sunken-stair');
    expect(s.calls).toEqual([['glide', 'finish_edit']]);
  });

  it('waits for the edit a blur commits before comparing', async () => {
    const s = setup();
    await s.t.focusChanged('glide');
    let land!: () => void;
    void s.delay(
      new Promise<void>((r) => {
        land = () => {
          s.apply(cmd('entity.update', { id: 'glide', set: { identity: 'Late edit' } }));
          r();
        };
      }),
    );
    const leaving = s.t.focusChanged(null);
    land();
    await leaving;
    expect(s.calls).toEqual([['glide', 'finish_edit']]);
  });

  it('finishing in place (ctrl+s, Bench blur) critiques once per change', async () => {
    const s = setup();
    await s.t.focusChanged('glide');
    s.apply(cmd('entity.update', { id: 'glide', set: { identity: 'One' } }));
    await s.t.finish('glide');
    await s.t.finish('glide');
    await s.t.focusChanged(null);
    expect(s.calls).toEqual([['glide', 'finish_edit']]);
  });

  it('a state change critiques, and leaving afterwards does not send it again', async () => {
    const s = setup();
    await s.t.focusChanged('glide');
    s.apply(cmd('entity.update', { id: 'glide', set: { identity: 'Two' } }));
    await s.t.statesChanged(['glide']);
    await s.t.focusChanged(null);
    expect(s.calls).toEqual([['glide', 'state_change']]);
  });

  it('stays quiet while the AI is off, and skips the graveyard', async () => {
    const off = setup({ allowed: false });
    await off.t.focusChanged('glide');
    off.apply(cmd('entity.update', { id: 'glide', set: { identity: 'Three' } }));
    await off.t.focusChanged(null);
    await off.t.statesChanged(['glide']);
    expect(off.calls).toEqual([]);

    const s = setup();
    const dead = Object.values(s.world().entities).find((e) => e.state === 'graveyard');
    if (!dead) throw new Error('sample has a graveyard entity');
    await s.t.statesChanged([dead.id]);
    expect(s.calls).toEqual([]);
  });

  describe('provenance: only your edits finish an edit', () => {
    const ai = (id: string, field: string, value: unknown): Command =>
      cmd('entity.setField', { id, field, value, source: 'ai' });

    it('accepting AI values alone, then leaving, sends no critique', async () => {
      const s = setup();
      await s.t.focusChanged('glide');
      s.apply(ai('glide', 'identity', 'Ride the updraft, steer the fall.'));
      s.apply(ai('glide', 'description', 'Open the coat and the wind decides.'));
      s.apply(cmd('entity.setAttribute', { id: 'glide', key: 'lift', value: 3, source: 'ai' }));
      await s.t.focusChanged('sunken-stair');
      expect(s.calls).toEqual([]);
      // ctrl+s too.
      await s.t.focusChanged('glide');
      s.apply(ai('glide', 'identity', 'Another AI line.'));
      await s.t.finish('glide');
      expect(s.calls).toEqual([]);
    });

    it('a field you edit after the AI wrote it counts', async () => {
      const s = setup();
      await s.t.focusChanged('glide');
      s.apply(ai('glide', 'identity', 'Ride the updraft.'));
      s.apply(cmd('entity.setField', { id: 'glide', field: 'identity', value: 'Mine now.' }));
      await s.t.focusChanged(null);
      expect(s.calls).toEqual([['glide', 'finish_edit']]);
    });

    it('your edit beside AI-accepted ones counts', async () => {
      const s = setup();
      await s.t.focusChanged('glide');
      s.apply(ai('glide', 'identity', 'Ride the updraft.'));
      s.apply(cmd('entity.update', { id: 'glide', set: { description: 'Typed by you.' } }));
      await s.t.focusChanged(null);
      expect(s.calls).toEqual([['glide', 'finish_edit']]);
    });

    it('an attribute the AI set does not count; one you set does', async () => {
      const s = setup();
      await s.t.focusChanged('glide');
      s.apply(cmd('entity.setAttribute', { id: 'glide', key: 'lift', value: 2, source: 'ai' }));
      await s.t.finish('glide');
      expect(s.calls).toEqual([]);
      s.apply(cmd('entity.setAttribute', { id: 'glide', key: 'lift', value: 4 }));
      await s.t.finish('glide');
      expect(s.calls).toEqual([['glide', 'finish_edit']]);
    });

    it('a state change still critiques after AI-only changes', async () => {
      const s = setup();
      await s.t.focusChanged('glide');
      s.apply(ai('glide', 'identity', 'Ride the updraft.'));
      await s.t.statesChanged(['glide']);
      expect(s.calls).toEqual([['glide', 'state_change']]);
    });

    it('userChangedFields: differs from the baseline and is not AI-marked', () => {
      const s = setup();
      const before = s.world().entities.glide!;
      const base = fieldSnapshot(before);
      expect(userChangedFields(base, before)).toEqual([]);
      s.apply(ai('glide', 'identity', 'AI line.'));
      expect(userChangedFields(base, s.world().entities.glide!)).toEqual([]);
      s.apply(cmd('entity.update', { id: 'glide', set: { identity: 'Your line.', tags: ['x'] } }));
      expect(userChangedFields(base, s.world().entities.glide!)).toEqual(['identity', 'tags']);
      // A field cleared by you counts (it leaves the snapshot).
      const g = s.world().entities.glide!;
      const key = Object.keys(g.fields)[0]!;
      s.apply(cmd('entity.setField', { id: 'glide', field: key, value: null }));
      expect(userChangedFields(base, s.world().entities.glide!)).toContain(key);
    });
  });
});
