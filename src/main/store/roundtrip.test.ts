import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyCommand } from '@core/commands/apply';
import { cmd, type Command } from '@core/commands/registry';
import type { World } from '@core/model/world';
import {
  commandArb,
  everyCommandArb,
  EVERY_COMMAND_TYPE,
  IMAGE_ID_POOL,
} from '@core/testing/arbitraries';
import { COMMANDS } from '@core/commands/registry';
import { sampleWorld } from '@core/testing/sample';
import { resetDiskState } from './disk-state';
import { loadWorldDir, writeWorldDir } from './world-dir';
import { WorldSession } from '../world-session';

/**
 * The store's central promise (docs/SYSTEM.md §4): whatever carbon holds in
 * memory is what it reads back. Any sequence of commands, saved and reopened,
 * gives back the identical world.
 */
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-roundtrip-'));
});
afterEach(async () => {
  resetDiskState(dir);
  await rm(dir, { recursive: true, force: true });
});

const clock = (): string => '2026-11-05T01:00:00.000Z';

const curve = (id: string, tolerance?: number): Command => ({
  type: 'numbers.putCurve',
  payload: {
    curve: {
      id,
      y: 'x * 2',
      over: { axis: 'tier' },
      intent: [
        { x: 0, y: 1 },
        { x: 3, y: 9 },
      ],
      ...(tolerance ? { tolerance } : {}),
    },
  },
});

function storeCommandArb(ids: readonly string[]): fc.Arbitrary<Command> {
  return fc.oneof(
    { weight: 6, arbitrary: commandArb(ids) },
    { weight: 1, arbitrary: fc.constantFrom(curve('defense-budget'), curve('ttk', 0.1)) },
    {
      weight: 1,
      arbitrary: fc.constantFrom<Command>(
        cmd('numbers.removeCurve', { id: 'ttk' }),
        cmd('numbers.setFormulas', { source: 'k = 100\nx2(v) = v * 2\n' }),
        cmd('taste.addRule', { id: 'r-numbers', text: 'No pure numbers' }),
        cmd('taste.countReason', { key: '3', by: 1 }),
      ),
    },
  );
}

async function reopened(): Promise<unknown> {
  resetDiskState(dir);
  const { world, issues } = await loadWorldDir(dir);
  expect(issues).toEqual([]);
  return world;
}

describe('save and reload', () => {
  it('keeps intent curves', async () => {
    await writeWorldDir(dir, sampleWorld());
    resetDiskState(dir);
    const s = await WorldSession.open(dir, clock);
    expect(s.dispatch([curve('defense-budget')]).ok).toBe(true);
    await s.flush();
    expect(await reopened()).toEqual(s.world);
  });

  it('property: any sequence of commands, saved and reopened, gives back the identical world', async () => {
    const ids = Object.keys(sampleWorld().entities);
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.array(storeCommandArb(ids), { minLength: 1, maxLength: 3 }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(fc.constantFrom('undo', 'redo', 'none'), { maxLength: 8 }),
        async (steps, moves) => {
          resetDiskState(dir);
          await rm(dir, { recursive: true, force: true });
          await writeWorldDir(dir, sampleWorld());
          resetDiskState(dir);
          const s = await WorldSession.open(dir, clock);
          steps.forEach((cmds, i) => {
            s.dispatch(cmds);
            if (moves[i] === 'undo') s.undo();
            if (moves[i] === 'redo') s.redo();
          });
          await s.flush();
          expect(s.saveStatus().state).toBe('saved');
          expect(await reopened()).toEqual(s.world);
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);

  it('the every-command arbitrary reaches every command in the registry', () => {
    expect([...EVERY_COMMAND_TYPE].sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  /** The sample world plus a curve, a spread with candidates, an attribute def and a pattern. */
  function setUpWorld(): World {
    let w = sampleWorld();
    const run = (c: Command): void => {
      const r = applyCommand(w, c, { now: clock() });
      if (!r.ok) throw new Error(`${c.type}: ${r.error.message}`);
      w = r.value.world;
    };
    run(curve('ttk'));
    run(cmd('schema.setAttributeDef', { kind: 'item', def: { key: 'heat', min: 0 } }));
    run(
      cmd('taste.learnPatterns', {
        patterns: [{ text: 'Likes trade-offs', examples: [], strength: 0.5 }],
        judged: 1,
        at: clock(),
      }),
    );
    const cand = (key: string) => ({
      key,
      kind: 'item' as const,
      name: `Candidate ${key}`,
      identity: 'It does a thing.',
      fields: {},
      attributes: {},
      relations: [],
      position: { x: 0.5, y: 0.5 },
      wildcard: false,
    });
    const axis = { label: 'a', low: 'lo', high: 'hi' };
    run(
      cmd('spread.save', {
        record: {
          id: 's2',
          created: clock(),
          updated: clock(),
          spot: { type: 'cell', band: 'low-sky', lane: 'items' },
          move: 'fill',
          axes: { x: axis, y: axis },
          count: 3,
          candidates: [cand('c1'), cand('c2'), cand('c3')],
        },
      }),
    );
    // images-core: images on the two entities the image commands target, so selects and removes land.
    const ids = Object.keys(w.entities).slice(0, 2);
    for (const [i, image] of IMAGE_ID_POOL.entries())
      run(
        cmd('image.add', {
          image: {
            id: image,
            entity: ids[i % 2] as string,
            kind: i === 0 ? 'concept' : 'icon',
            origin: { by: 'fake', prompt: 'p', size: '1024x1024' },
            created: clock(),
            hashes: { output: 'a'.repeat(64) },
          },
          select: i === 0,
        }),
      );
    return w;
  }

  it('property: every command kind, with awkward values, saved and reopened, gives back the identical world', async () => {
    const start = setUpWorld();
    const ids = Object.keys(start.entities);
    const relations = Object.values(start.entities).flatMap((e) =>
      e.relations.map((r) => ({ from: e.id, type: r.type, to: r.target })),
    );
    const applied = new Map<string, number>();
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.array(
            everyCommandArb(ids, { relations, patterns: start.taste.patterns.map((p) => p.id) }),
            { minLength: 1, maxLength: 3 },
          ),
          {
            minLength: 1,
            maxLength: 10,
          },
        ),
        fc.array(fc.constantFrom('undo', 'redo', 'none', 'none'), { maxLength: 10 }),
        async (steps, moves) => {
          resetDiskState(dir);
          await rm(dir, { recursive: true, force: true });
          await writeWorldDir(dir, start);
          resetDiskState(dir);
          const s = await WorldSession.open(dir, clock);
          steps.forEach((cmds, i) => {
            if (s.dispatch(cmds).ok)
              for (const c of cmds) applied.set(c.type, (applied.get(c.type) ?? 0) + 1);
            if (moves[i] === 'undo') s.undo();
            if (moves[i] === 'redo') s.redo();
          });
          await s.flush();
          expect(s.saveStatus().state).toBe('saved');
          expect(await reopened()).toEqual(s.world);
        },
      ),
      { numRuns: 150 },
    );
    // Most kinds must actually have applied, or the property proves little.
    const never = EVERY_COMMAND_TYPE.filter((t) => !applied.has(t));
    expect(never, `never applied: ${never.join(', ')}`).toEqual([]);
  }, 300_000);
});
