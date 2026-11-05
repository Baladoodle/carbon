import { applyPatch, type Patch } from '@core/commands/patch';
import type { Note } from '@core/model/notes';
import type { World } from '@core/model/world';
import type { CheckRunner } from '@core/checks/runner';

/**
 * Feeding the check runner in a worker (checks.worker.ts) without copying the
 * whole world on every change: the worker gets the world once, then the
 * patches the mirror applied since, in `rev` order. A gap (the mirror
 * resynced from a snapshot, a reset, a missed patch) sends the world again.
 * Pure, so the protocol is unit-tested without a worker.
 */
export type ToWorker =
  { type: 'world'; rev: number; world: World } | { type: 'patch'; rev: number; patch: Patch };

export interface FromWorker {
  rev: number;
  notes: Note[];
  ms: number;
}

/** The main-thread side: collects patches, and says what to send for the mirror's state. */
export class CheckFeed {
  private sentRev = -1;
  private sentWorld: World | null = null;
  private queued: Patch = [];
  private queuedRev = -1;
  private gap = true;

  /** Every patch event, as it arrives. */
  onPatch(rev: number, patch: Patch): void {
    if (rev <= this.queuedRev) return; // already have it
    if (this.queuedRev >= 0 && rev !== this.queuedRev + 1) this.gap = true;
    this.queued.push(...patch);
    this.queuedRev = rev;
  }

  /** What to send for the mirror at `rev`, or null when the worker already has it. */
  next(rev: number, world: World): ToWorker | null {
    if (rev === this.sentRev && world === this.sentWorld) return null;
    const contiguous = !this.gap && this.sentRev >= 0 && this.queuedRev === rev;
    const msg: ToWorker = contiguous
      ? { type: 'patch', rev, patch: this.queued }
      : { type: 'world', rev, world };
    this.sentRev = rev;
    this.sentWorld = world;
    this.queued = [];
    this.queuedRev = rev;
    this.gap = false;
    return msg;
  }
}

/** The worker side: the world it holds, and the incremental runner over it. */
export function checkWorker(runner: CheckRunner): (m: ToWorker) => FromWorker | null {
  let world: World | null = null;
  return (m) => {
    const t = performance.now();
    if (m.type === 'world') world = m.world;
    else if (world) world = applyPatch(world, m.patch);
    else return null;
    return { rev: m.rev, notes: runner.run(world), ms: performance.now() - t };
  };
}
