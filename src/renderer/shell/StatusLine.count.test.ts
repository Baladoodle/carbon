import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { applyCommand } from '@core/commands/apply';
import type { Patch } from '@core/commands/patch';
import { applyPatch } from '@core/commands/patch';
import type { Command } from '@core/commands/registry';
import type { World } from '@core/model/world';
import { commandArb } from '@core/testing/arbitraries';
import { sampleWorld } from '@core/testing/sample';
import { stressWorld } from '@core/testing/stress';
import { countAfter, EntityCounter } from './StatusLine.count';

/**
 * The status line's entity count is kept from patches (StatusLine.count.ts).
 * It must always equal the true count, `Object.keys(world.entities).length`,
 * whatever the patches do and however the events arrive.
 */

const ctx = { now: '2026-11-05T10:00:00.000Z' };
const trueCount = (w: World): number => Object.keys(w.entities).length;

/** A step of the main process: a command, or an undo of the last applied one. */
type Step = { kind: 'cmd'; c: Command } | { kind: 'undo' };

/** Plays steps like the session does: each applied command or undo is one patch. */
function play(start: World, steps: Step[]): { worlds: World[]; patches: Patch[] } {
  const worlds = [start];
  const patches: Patch[] = [];
  const undo: Patch[] = [];
  let w = start;
  for (const s of steps) {
    let patch: Patch | undefined;
    if (s.kind === 'undo') {
      patch = undo.pop();
    } else {
      const r = applyCommand(w, s.c, ctx);
      if (r.ok) {
        patch = r.value.patch;
        undo.push(r.value.inverse);
      }
    }
    if (!patch) continue;
    w = applyPatch(w, patch);
    worlds.push(w);
    patches.push(patch);
  }
  return { worlds, patches };
}

const steps = (ids: string[]): fc.Arbitrary<Step[]> =>
  fc.array(
    fc.oneof(
      { weight: 4, arbitrary: commandArb(ids).map((c): Step => ({ kind: 'cmd', c })) },
      { weight: 1, arbitrary: fc.constant<Step>({ kind: 'undo' }) },
    ),
    { maxLength: 25 },
  );

describe('countAfter', () => {
  it('property: equals the true count after any chain of command and undo patches', () => {
    const start = sampleWorld();
    fc.assert(
      fc.property(steps(Object.keys(start.entities)), (s) => {
        const { worlds, patches } = play(start, s);
        // From the start, through every prefix, in one go.
        for (let i = 0; i <= patches.length; i++)
          expect(countAfter(start.entities, trueCount(start), patches.slice(0, i))).toBe(
            trueCount(worlds[i] as World),
          );
        // And patch by patch.
        let n = trueCount(start);
        patches.forEach((p, i) => {
          n = countAfter((worlds[i] as World).entities, n, [p]) ?? NaN;
          expect(n).toBe(trueCount(worlds[i + 1] as World));
        });
      }),
      { numRuns: 300 },
    );
  });

  it('needs a recount when a patch replaces the whole table', () => {
    const w = sampleWorld();
    expect(
      countAfter(w.entities, trueCount(w), [[{ op: 'set', path: ['entities'], value: {} }]]),
    ).toBeNull();
    // A remove of an id that isn't there, and a set of one that is, change nothing.
    expect(
      countAfter(w.entities, trueCount(w), [
        [{ op: 'remove', path: ['entities', 'nope'] }],
        [{ op: 'set', path: ['entities', 'glide'], value: w.entities.glide }],
      ]),
    ).toBe(trueCount(w));
  });
});

/** Events as the main process sends them, with the world each leaves behind. */
type Event =
  | { kind: 'patch'; rev: number; patch: Patch; world: World }
  | { kind: 'reset'; rev: number; world: World };

const history = { canUndo: false, canRedo: false };

describe('the counter wired to the real mirror', () => {
  it('property: always equals the mirror’s true count, through drops, duplicates, late delivery and resets', async () => {
    const start = sampleWorld();
    const other = stressWorld(40, 'counter');
    const ids = Object.keys(start.entities);
    await fc.assert(
      fc.asyncProperty(
        steps(ids),
        steps(Object.keys(other.entities)),
        fc.array(fc.constantFrom('deliver', 'deliver', 'deliver', 'drop', 'twice', 'late'), {
          minLength: 60,
          maxLength: 60,
        }),
        fc.nat({ max: 30 }),
        fc.constantFrom('deliver', 'drop', 'late'),
        async (a, b, fates, resetAt, resetFate) => {
          // The main process: one world's patches, then (maybe) a reset to another world.
          const one = play(start, a);
          const two = play(other, b);
          const events: Event[] = [];
          one.patches.forEach((p, i) =>
            events.push({ kind: 'patch', rev: i + 1, patch: p, world: one.worlds[i + 1] as World }),
          );
          const cut = Math.min(resetAt, events.length);
          events.splice(cut);
          if (resetAt % 2 === 0) {
            events.push({ kind: 'reset', rev: 0, world: other });
            two.patches.forEach((p, i) =>
              events.push({
                kind: 'patch',
                rev: i + 1,
                patch: p,
                world: two.worlds[i + 1] as World,
              }),
            );
          }

          // The fake bridge: the mirror resyncs from `truth` on a gap.
          let truth = { rev: 0, world: start };
          const listeners = new Map<string, ((raw: unknown) => void)[]>();
          vi.resetModules();
          (globalThis as { window?: unknown }).window = {
            carbon: {
              invoke: (channel: string) => {
                if (channel !== 'world:snapshot') throw new Error(channel);
                // IPC clones: the renderer never shares objects with main.
                return Promise.resolve(
                  structuredClone({
                    rev: truth.rev,
                    dir: '/w',
                    world: truth.world,
                    issues: [],
                    history,
                  }),
                );
              },
              on: (channel: string, l: (raw: unknown) => void) => {
                listeners.set(channel, [...(listeners.get(channel) ?? []), l]);
                return () => undefined;
              },
            },
          };
          try {
            // Imported first, as the shell imports the status line before it syncs.
            const { countOf } = await import('./StatusLine.count');
            const { startWorldSync, worldStore } = await import('../state/world');
            await startWorldSync();
            const check = (): void => {
              const s = worldStore.get();
              if (s.world) expect(countOf(s)).toBe(trueCount(s.world));
            };
            check();
            const send = (channel: string, payload: unknown, counterLast: boolean): void => {
              const ls = listeners.get(channel) ?? [];
              // The counter registered first; `counterLast` delivers to the mirror first.
              for (const l of counterLast ? [...ls].reverse() : ls) l(structuredClone(payload));
            };
            for (const [i, e] of events.entries()) {
              truth = { rev: e.rev, world: e.world };
              // The reset has its own fate: a lost reset is the hardest case (the
              // next patch belongs to another world).
              const fate = e.kind === 'reset' ? resetFate : (fates[i % fates.length] ?? 'deliver');
              if (fate === 'drop') continue;
              const payload =
                e.kind === 'reset'
                  ? { rev: e.rev, dir: '/w', world: e.world, issues: [], history }
                  : { rev: e.rev, patch: e.patch, cause: 'command', history };
              const channel = e.kind === 'reset' ? 'world:reset' : 'world:patch';
              send(channel, payload, fate === 'late');
              if (fate === 'twice') send(channel, payload, false);
              check();
              await Promise.resolve(); // let a resync land
              await new Promise((r) => setTimeout(r, 0));
              check();
            }
          } finally {
            delete (globalThis as { window?: unknown }).window;
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('counts afresh when the world was loaded, not patched, even with the patches in hand', () => {
    const start = sampleWorld();
    const other = stressWorld(40, 'counter');
    const c = new EntityCounter();
    c.count(0, start);
    // A patch of another world (its reset was lost), then that world's snapshot.
    const r = applyCommand(
      other,
      { type: 'entity.create', payload: { kind: 'item', name: 'Z' } },
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    c.onPatch(1, r.value.patch);
    const loaded = structuredClone(r.value.world);
    expect(c.count(1, loaded)).toBe(trueCount(loaded));
    // And a snapshot of the same world after a gap: right too.
    const same = applyCommand(loaded, { type: 'entity.delete', payload: { id: 'band-0' } }, ctx);
    if (!same.ok) throw new Error(same.error.message);
    c.onPatch(2, same.value.patch);
    const snap = structuredClone(same.value.world);
    expect(c.count(2, snap)).toBe(trueCount(snap));
  });

  it('counts once at the start, then only from patches, when events arrive in order', () => {
    const c = new EntityCounter();
    const { worlds, patches } = play(sampleWorld(), [
      { kind: 'cmd', c: { type: 'entity.create', payload: { kind: 'item', name: 'A' } } },
      { kind: 'cmd', c: { type: 'entity.create', payload: { kind: 'item', name: 'B' } } },
      { kind: 'undo' },
      { kind: 'cmd', c: { type: 'entity.delete', payload: { id: 'glide' } } },
    ]);
    expect(c.count(0, worlds[0] as World)).toBe(trueCount(worlds[0] as World));
    patches.forEach((p, i) => {
      c.onPatch(i + 1, p);
      expect(c.count(i + 1, worlds[i + 1] as World)).toBe(trueCount(worlds[i + 1] as World));
    });
    expect(c.recounts).toBe(1);
  });
});
