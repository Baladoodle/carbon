import type { Move } from '@core/ai/moments';
import { MOVE_DEFS } from '@core/spreads/moves';
import { readSpread, type SpreadData } from '@core/spreads/record';
import { checkSpot } from '@core/spreads/spot';
import { followSpot, keepCommands, killCommands, mergeCommands } from '@core/spreads/triage';
import { flash, setUi } from '../../state/ui';
import { currentWorld, transact, undo } from '../../state/world';
import {
  adoptSpot,
  patchSession,
  patchSetup,
  runSpread,
  sessionStore,
  settled,
  stopSpread,
  type Queued,
} from './session';

/**
 * Triage from the keyboard (docs/EXPERIENCE.md §4). Each action is one
 * transaction built in core (src/core/spreads/triage.ts), so `u` (or ctrl+z)
 * undoes exactly one key press.
 */

function shown(): SpreadData | null {
  const w = currentWorld();
  const id = sessionStore.get().current;
  return w && id ? readSpread(w.spreads[id]) : null;
}

/** Keys judged while streaming (queued for the record). */
export function queuedKeys(queue: readonly Queued[]): Set<string> {
  return new Set(queue.flatMap((q) => (q.type === 'merge' ? q.keys : [q.key])));
}

/** While streaming: queues a judgement on a candidate that has arrived (see session.ts). */
function enqueue(q: Queued, order: readonly string[]): boolean {
  const s = sessionStore.get();
  if (!s.live) return false;
  const keys = q.type === 'merge' ? q.keys : [q.key];
  const taken = queuedKeys(s.queued);
  if (keys.some((k) => taken.has(k) || !s.live?.candidates.some((c) => c.key === k))) return true;
  const queued = [...s.queued, q];
  const judged = queuedKeys(queued);
  patchSession({
    queued,
    prompt: null,
    marked: s.marked.filter((k) => !judged.has(k)),
  });
  const open = order.filter((k) => !judged.has(k));
  const i = order.indexOf(keys[0] ?? '');
  patchSession({ focus: open.find((k) => order.indexOf(k) > i) ?? open[0] ?? null });
  return true;
}

/** After a judgement: the next open candidate in reading order becomes the focus. */
function advance(order: readonly string[], from: string, spread: SpreadData | null): void {
  if (!spread) return;
  const open = order.filter((k) => !spread.judgements[k] && k !== from);
  const i = order.indexOf(from);
  const next = open.find((k) => order.indexOf(k) > i) ?? open[0] ?? null;
  patchSession({ focus: next });
}

/** `k`. Resolves to whether it was kept, and the entity it became or changed. */
export async function keep(
  key: string,
  order: readonly string[],
): Promise<{ ok: boolean; entity?: string | undefined }> {
  if (enqueue({ type: 'keep', key }, order)) return { ok: true };
  const w = currentWorld();
  const s = shown();
  if (!w || !s) return { ok: false };
  const t = keepCommands(w, s, key);
  if (!t.ok) {
    flash(t.error.message, 'error');
    return { ok: false };
  }
  const r = await transact(t.value.label, t.value.commands);
  if (!r.ok) {
    flash(r.error.message, 'error');
    return { ok: false };
  }
  if (t.value.entity) setUi({ focus: t.value.entity });
  patchSession({ marked: sessionStore.get().marked.filter((k) => k !== key) });
  advance(order, key, shown());
  return { ok: true, entity: t.value.entity };
}

export async function kill(
  key: string,
  reason: string,
  order: readonly string[],
  note?: string,
): Promise<void> {
  if (enqueue({ type: 'kill', key, reason, note }, order)) return;
  const w = currentWorld();
  const s = shown();
  if (!w || !s) return;
  const t = killCommands(w, s, key, reason, note);
  patchSession({ prompt: null });
  if (!t.ok) return flash(t.error.message, 'error');
  const r = await transact(t.value.label, t.value.commands);
  if (!r.ok) return flash(r.error.message, 'error');
  patchSession({ marked: sessionStore.get().marked.filter((k) => k !== key) });
  advance(order, key, shown());
}

export async function merge(order: readonly string[]): Promise<void> {
  const marked = sessionStore.get().marked;
  if (sessionStore.get().live) {
    if (marked.length < 2) return flash('Mark two or more candidates to merge', 'error');
    enqueue({ type: 'merge', keys: [...marked] }, order);
    return;
  }
  const w = currentWorld();
  const s = shown();
  if (!w || !s) return;
  const t = mergeCommands(w, s, marked);
  if (!t.ok) return flash(t.error.message, 'error');
  const r = await transact(t.value.label, t.value.commands);
  if (!r.ok) return flash(r.error.message, 'error');
  if (t.value.entity) setUi({ focus: t.value.entity });
  patchSession({ marked: [] });
  advance(order, marked[0] ?? '', shown());
}

export function toggleMark(key: string): void {
  const { marked } = sessionStore.get();
  patchSession({
    marked: marked.includes(key) ? marked.filter((k) => k !== key) : [...marked, key],
  });
}

/** `→`: opens the move picker for a follow-up; a new candidate is kept first (one more undo step). */
export async function follow(key: string, order: readonly string[]): Promise<void> {
  // A follow-up needs the record: stop the stream (keeping what came) and wait for it.
  if (sessionStore.get().live) {
    stopSpread();
    await settled();
  }
  const w = currentWorld();
  const s = shown();
  if (!w || !s) return;
  let spot = followSpot(w, s, key);
  if (!spot) {
    const kept = await keep(key, order);
    if (!kept.ok || !kept.entity) return;
    spot = { type: 'entity', entity: kept.entity };
  }
  patchSession({ prompt: { type: 'follow', key, spot }, focus: key });
}

/** Picks a move in the follow prompt: the next spread starts at once. */
export function followWith(move: Move): void {
  const s = sessionStore.get();
  const w = currentWorld();
  if (!w || s.prompt?.type !== 'follow') return;
  const { spot, key } = s.prompt;
  const check = checkSpot(w, spot, move);
  if (!check.ok) return flash(check.error.message, 'error');
  const parent = s.current ? { spread: s.current, key } : undefined;
  adoptSpot(w, spot, move);
  patchSetup({ parent, direction: '' });
  void runSpread().then((e) => e && flash(e, 'error'));
}

/** `u`: undo the last step (the same history as ctrl+z). */
export function undoLast(): void {
  // While streaming, nothing has reached the world yet: take back the last queued judgement.
  const s = sessionStore.get();
  if (s.live) {
    const last = s.queued[s.queued.length - 1];
    if (!last) return flash('Nothing to undo yet', 'info');
    patchSession({
      queued: s.queued.slice(0, -1),
      focus: last.type === 'merge' ? (last.keys[0] ?? null) : last.key,
    });
    return;
  }
  void undo().then((r) =>
    flash(r.ok ? `Undid ${r.label ?? ''}` : r.error.message, r.ok ? 'info' : 'error'),
  );
}

export const moveLabel = (m: Move): string => MOVE_DEFS[m].label;
