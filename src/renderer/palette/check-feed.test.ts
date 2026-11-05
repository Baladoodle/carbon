import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '@core/commands/apply';
import { createCheckRunner, runChecks } from '@core/checks/runner';
import { commandArb } from '@core/testing/arbitraries';
import { sampleWorld } from '@core/testing/sample';
import type { World } from '@core/model/world';
import { CheckFeed, checkWorker, type ToWorker } from './check-feed';

const ctx = { now: '2026-11-05T00:00:00.000Z' };

describe('the check feed', () => {
  it('property: the worker’s notes always equal a full run on the mirror’s world', () => {
    const ids = Object.keys(sampleWorld().entities);
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            command: commandArb(ids),
            // Whether a run happens after this patch, and whether this patch is "lost"
            // to the feed (the mirror resynced instead).
            run: fc.boolean(),
            lost: fc.boolean(),
          }),
          { maxLength: 25 },
        ),
        (steps) => {
          let world: World = sampleWorld();
          let rev = 0;
          const feed = new CheckFeed();
          const worker = checkWorker(createCheckRunner());
          const sent: ToWorker[] = [];
          const runAndCompare = (): void => {
            const m = feed.next(rev, world);
            if (!m) return;
            sent.push(m);
            const out = worker(structuredClone(m));
            expect(out?.rev).toBe(rev);
            expect(out?.notes).toEqual(runChecks(world));
          };
          runAndCompare();
          for (const s of steps) {
            const r = applyCommand(world, s.command, ctx);
            if (r.ok && r.value.patch.length > 0) {
              world = r.value.world;
              rev++;
              if (!s.lost) feed.onPatch(rev, r.value.patch);
            }
            if (s.run) runAndCompare();
          }
          runAndCompare();
          // Nothing to send when the worker is up to date.
          expect(feed.next(rev, world)).toBeNull();
        },
      ),
      { numRuns: 120 },
    );
  });

  it('sends patches, not the world, while nothing is missed', () => {
    const feed = new CheckFeed();
    let w = sampleWorld();
    expect(feed.next(0, w)?.type).toBe('world');
    const r = applyCommand(w, { type: 'entity.delete', payload: { id: 'glide' } }, ctx);
    if (!r.ok) throw new Error(r.error.message);
    w = r.value.world;
    feed.onPatch(1, r.value.patch);
    feed.onPatch(1, r.value.patch); // a duplicate is ignored
    expect(feed.next(1, w)).toEqual({ type: 'patch', rev: 1, patch: r.value.patch });
  });
});
