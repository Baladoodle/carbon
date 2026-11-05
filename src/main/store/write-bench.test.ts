import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cmd } from '@core/commands/registry';
import { stressWorld } from '@core/testing/stress';
import { WorldSession } from '../world-session';
import { resetDiskState } from './disk-state';
import { writeWorldDir } from './world-dir';

/**
 * The store's write time for one big transaction and its undo, on the
 * 2,000-entity stress world. Not part of the normal suite (it measures the
 * disk): `CARBON_BENCH=1 npx vitest run src/main/store/write-bench.test.ts`,
 * and `CARBON_BENCH_LOAD=1` to keep every core busy meanwhile.
 */
const ON = !!process.env.CARBON_BENCH;

function busyLoops(): ChildProcess[] {
  return Array.from({ length: os.availableParallelism() }, () =>
    spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }),
  );
}

/** Milliseconds to apply (in memory) and then to write (until the save queue is empty). */
async function timed(
  session: WorldSession,
  run: () => unknown,
): Promise<{ apply: number; write: number }> {
  const t = performance.now();
  run();
  const applied = performance.now();
  await session.flush();
  return { apply: applied - t, write: performance.now() - applied };
}

describe.skipIf(!ON)('store write time (benchmark)', () => {
  it('a 2,000-command transaction and its undo, on the stress world', async () => {
    const load = process.env.CARBON_BENCH_LOAD ? busyLoops() : [];
    const base = process.env.CARBON_BENCH_DIR ?? os.tmpdir();
    const dir = await mkdtemp(path.join(base, 'carbon-bench-'));
    try {
      await writeWorldDir(dir, stressWorld(2000));
      resetDiskState(dir);
      const session = await WorldSession.open(dir);
      const ids = Object.keys(session.world.entities).slice(0, 2000);
      const creates = Array.from({ length: 2000 }, (_, i) =>
        cmd('entity.create', { kind: 'material', name: `Ore ${String(i).padStart(4, '0')}` }),
      );
      const renames = ids.map((id) =>
        cmd('entity.update', { id, set: { identity: `renamed ${id}` } }),
      );
      const out: Record<string, { apply: number; write: number }> = {};
      out.create = await timed(session, () => session.dispatch(creates, 'many'));
      out.undoCreate = await timed(session, () => session.undo());
      out.update = await timed(session, () => session.dispatch(renames, 'many'));
      out.undoUpdate = await timed(session, () => session.undo());
      out.one = await timed(session, () =>
        session.dispatch([cmd('entity.update', { id: ids[0] ?? '', set: { identity: 'x' } })]),
      );
      expect(session.saveStatus().state).toBe('saved');
      process.stdout.write(
        `\nBENCH ${load.length ? `loaded×${load.length}` : 'quiet'} ${JSON.stringify(
          Object.fromEntries(
            Object.entries(out).map(([k, v]) => [k, [Math.round(v.apply), Math.round(v.write)]]),
          ),
        )}\n`,
      );
    } finally {
      for (const p of load) p.kill();
      await rm(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
