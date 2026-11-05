import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cmd, type Command } from '@core/commands/registry';
import { commandArb } from '@core/testing/arbitraries';
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
});
