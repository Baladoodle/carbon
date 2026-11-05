import type { AiError } from '@core/ai/gateway';
import type { Axis, Candidate, Move, Spot } from '@core/ai/moments';
import { cmd } from '@core/commands/registry';
import type { World } from '@core/model/world';
import { MOVE_DEFS } from '@core/spreads/moves';
import { makeSpread, newSpreadId, readSpread, type SpreadData } from '@core/spreads/record';
import { checkSpot, defaultMove, spotLabel } from '@core/spreads/spot';
import { keepCommands, killCommands, mergeCommands } from '@core/spreads/triage';
import { activeRules } from '@core/taste/context';
import { ai } from '../../ai/client';
import { createStore, useStore } from '../../state/store';
import { currentWorld, transact, whenRev } from '../../state/world';

/**
 * The Spread view's own state: the setup of the next spread (spot, move,
 * direction, axes, count, rules), the spread on the field, the live stream,
 * the focused and marked candidates, and the open prompt (kill reason or
 * follow). Persistent results live in the world (spread records); this is
 * only what the view is doing right now.
 */

export interface Setup {
  spot: Spot | null;
  move: Move;
  direction: string;
  /** `null`: the move's default axes. */
  axes: { x: Axis; y: Axis } | null;
  count: number;
  /** Rules on for this spread; `null`: every enabled rule. */
  ruleIds: string[] | null;
  /** Set by `→`: the spread and candidate the next one follows from. */
  parent?: { spread: string; key: string } | undefined;
}

export interface Live {
  id: string;
  spot: Spot;
  move: Move;
  axes: { x: Axis; y: Axis };
  candidates: Candidate[];
  count: number;
}

/**
 * A judgement made while the spread is still streaming. The record is written
 * once the stream ends; then these are applied in order, each as its own undo
 * step, exactly as if the keys had been pressed after the stream.
 */
export type Queued =
  | { type: 'keep'; key: string }
  | { type: 'kill'; key: string; reason: string; note?: string | undefined }
  | { type: 'merge'; keys: string[] };

export type Prompt =
  | { type: 'kill'; key: string }
  | { type: 'other'; key: string }
  | { type: 'follow'; key: string; spot: Spot };

export interface SpreadSession {
  setup: Setup;
  /** The spread on the field (a record id), when not streaming. */
  current: string | null;
  live: Live | null;
  error: AiError | null;
  focus: string | null;
  marked: string[];
  prompt: Prompt | null;
  /** Judgements made while streaming, waiting for the record (see Queued). */
  queued: Queued[];
}

export const COUNTS = [8, 12, 16] as const;

const initial: SpreadSession = {
  setup: { spot: null, move: 'fill', direction: '', axes: null, count: 12, ruleIds: null },
  current: null,
  live: null,
  error: null,
  focus: null,
  marked: [],
  prompt: null,
  queued: [],
};

export const sessionStore = createStore<SpreadSession>(initial);
export const useSession = <T>(sel: (s: SpreadSession) => T): T => useStore(sessionStore, sel);
export const patchSession = (p: Partial<SpreadSession>): void =>
  sessionStore.set((s) => ({ ...s, ...p }));
export const patchSetup = (p: Partial<Setup>): void =>
  sessionStore.set((s) => ({ ...s, setup: { ...s.setup, ...p } }));

/** Takes a new spot: picks a move that can aim at it and clears the field. */
export function adoptSpot(world: World, spot: Spot, move?: Move): void {
  const s = sessionStore.get();
  const keep =
    move ?? (checkSpot(world, spot, s.setup.move).ok ? s.setup.move : defaultMove(world, spot));
  abortLive();
  sessionStore.set({
    ...s,
    setup: { ...s.setup, spot, move: keep, parent: undefined },
    current: null,
    live: null,
    error: null,
    focus: null,
    marked: [],
    prompt: null,
    queued: [],
  });
}

/** The spread shown on the field (the stored record), if any. */
export function shownSpread(world: World | undefined | null, s: SpreadSession): SpreadData | null {
  if (!world || !s.current) return null;
  return readSpread(world.spreads[s.current]);
}

let controller: AbortController | null = null;
/** Bumped by every new run and every new spot: a stale run's results are dropped. */
let token = 0;

/** Cancels the live run and drops its results. */
export function abortLive(): void {
  token++;
  controller?.abort();
  controller = null;
}

export const effectiveAxes = (setup: Setup): { x: Axis; y: Axis } =>
  setup.axes ?? MOVE_DEFS[setup.move].axes;

/** The rule ids a spread with this setup sends. */
export const effectiveRules = (world: World, setup: Setup): string[] =>
  setup.ruleIds ?? activeRules(world.taste).map((r) => r.id);

/**
 * Runs a spread with the current setup: streams candidates onto the field,
 * then saves the record as one undo step. A newer run cancels this one.
 * Returns the error message to show, or null.
 */
export async function runSpread(): Promise<string | null> {
  const world = currentWorld();
  const { setup } = sessionStore.get();
  if (!world || !setup.spot) return 'Nothing to spread on';
  const check = checkSpot(world, setup.spot, setup.move);
  if (!check.ok) return check.error.message;
  abortLive();
  const my = token;
  const ac = new AbortController();
  controller = ac;
  const axes = effectiveAxes(setup);
  const ruleIds = effectiveRules(world, setup);
  const direction = setup.direction.trim();
  const id = newSpreadId(world, setup.spot, new Date().toISOString());
  const live: Live = {
    id,
    spot: setup.spot,
    move: setup.move,
    axes,
    candidates: [],
    count: setup.count,
  };
  patchSession({
    live,
    current: null,
    error: null,
    focus: null,
    marked: [],
    prompt: null,
    queued: [],
  });
  let finish: () => void = () => undefined;
  running = new Promise<void>((r) => (finish = r));
  try {
    return await stream(my, ac, id, setup, world, axes, ruleIds, direction);
  } finally {
    finish();
  }
}

/** Resolves when the current run (if any) has ended and its record is saved. */
export const settled = (): Promise<void> => running;
let running: Promise<void> = Promise.resolve();

async function stream(
  my: number,
  ac: AbortController,
  id: string,
  setup: Setup,
  world: World,
  axes: { x: Axis; y: Axis },
  ruleIds: string[],
  direction: string,
): Promise<string | null> {
  if (!setup.spot) return null;
  const request = {
    spot: setup.spot,
    move: setup.move,
    count: setup.count,
    axes,
    ruleIds,
    ...(direction ? { direction } : {}),
  };
  const out = await ai.run('spread', request, {
    signal: ac.signal,
    onPartial: (c) => {
      if (token !== my) return;
      sessionStore.set((s) =>
        s.live?.id === id && !s.live.candidates.some((x) => x.key === c.key)
          ? {
              ...s,
              live: { ...s.live, candidates: [...s.live.candidates, c] },
              focus: s.focus ?? c.key,
            }
          : s,
      );
    },
  });
  if (token !== my) return null; // superseded by a newer run or spot
  controller = null;
  const streamed = sessionStore.get().live?.candidates ?? [];
  const candidates = out.ok ? out.result.candidates : streamed;
  const status = out.ok ? 'done' : out.error.code === 'cancelled' ? 'cancelled' : 'failed';
  if (candidates.length === 0) {
    patchSession({
      live: null,
      queued: [],
      error: out.ok || out.error.code === 'cancelled' ? null : out.error,
    });
    return null;
  }
  const record = makeSpread({
    id,
    now: new Date().toISOString(),
    request: {
      spot: setup.spot,
      move: setup.move,
      count: setup.count,
      axes: out.ok ? out.result.axes : axes,
      ruleIds,
      direction,
    },
    candidates,
    status,
    parent: setup.parent,
    dropped: out.meta?.dropped ?? 0,
    costUsd: out.meta?.costUsd ?? 0,
  });
  const latest = currentWorld() ?? world;
  const saved = await transact(
    `Spread: ${MOVE_DEFS[setup.move].label} ${spotLabel(latest, setup.spot)}`,
    [cmd('spread.save', { record })],
  );
  // The record must be in the mirror before anything reads it (triage, the field).
  if (saved.ok) await whenRev(saved.rev);
  if (token !== my) return null;
  const queue = sessionStore.get().queued;
  const judged = new Set(queue.flatMap((q) => (q.type === 'merge' ? q.keys : [q.key])));
  const prev = sessionStore.get().focus;
  const focus =
    prev && !judged.has(prev)
      ? prev
      : (candidates.find((c) => !judged.has(c.key))?.key ?? candidates[0]?.key ?? null);
  patchSession({
    live: null,
    current: saved.ok ? id : null,
    focus,
    queued: [],
    error: out.ok || out.error.code === 'cancelled' ? null : out.error,
  });
  if (!saved.ok) return saved.error.message;
  return drain(id, queue);
}

/** Applies the judgements made while streaming, in order, each as one undo step. */
async function drain(id: string, queue: readonly Queued[]): Promise<string | null> {
  let problem: string | null = null;
  for (const q of queue) {
    const w = currentWorld();
    const s = w ? readSpread(w.spreads[id]) : null;
    if (!w || !s) break;
    const t =
      q.type === 'keep'
        ? keepCommands(w, s, q.key)
        : q.type === 'kill'
          ? killCommands(w, s, q.key, q.reason, q.note)
          : mergeCommands(w, s, q.keys);
    if (!t.ok) {
      problem ??= t.error.message;
      continue;
    }
    const r = await transact(t.value.label, t.value.commands);
    if (!r.ok) problem ??= r.error.message;
    else await whenRev(r.rev);
  }
  return problem;
}

/** Stops the stream; what arrived so far is kept and saved. */
export function stopSpread(): void {
  controller?.abort();
}
