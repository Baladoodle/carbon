import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Candidate } from '@core/ai/moments';
import { applyCommand, applyCommands } from '@core/commands/apply';
import { cmd, type Command } from '@core/commands/registry';
import type { World } from '@core/model/world';
import { MOVE_DEFS } from '@core/spreads/moves';
import { makeSpread } from '@core/spreads/record';
import { sampleWorld } from '@core/testing/sample';

/**
 * Triage focus while a judgement is in flight: `k` then `x` at once must act
 * on the next card, never on the one just kept (animating out). The world's
 * transaction is held open here, so the window that load opened in the
 * acceptance walk-through is deterministic.
 */

const NOW = '2026-11-05T10:00:00.000Z';
let world: World;
let pending: { commands: Command[]; settle: (ok: boolean) => void }[] = [];

vi.mock('../../state/world', () => ({
  currentWorld: () => world,
  transact: (_label: string, commands: Command[]) =>
    new Promise((resolve) => {
      pending.push({
        commands,
        settle: (ok) => {
          if (!ok) return resolve({ ok: false, error: { message: 'refused' } });
          const r = applyCommands(world, commands, { now: NOW });
          if (!r.ok) return resolve({ ok: false, error: { message: r.error.message } });
          world = r.value.world;
          resolve({ ok: true });
        },
      });
    }),
  undo: () => Promise.resolve({ ok: true }),
  whenRev: () => Promise.resolve(),
}));
vi.mock('../../state/ui', () => ({ flash: () => undefined, setUi: () => undefined }));
vi.mock('../../ai/client', () => ({ ai: {} }));

const { keep, kill, merge, triageTarget } = await import('./actions');
const { patchSession, sessionStore } = await import('./session');

const cand = (key: string): Candidate => ({
  key,
  kind: 'item',
  name: `Candidate ${key}`,
  identity: `It does thing ${key}.`,
  fields: {},
  attributes: {},
  relations: [],
  position: { x: 0.5, y: 0.5 },
  wildcard: false,
});
const ORDER = ['c1', 'c2', 'c3', 'c4'];

beforeEach(() => {
  pending = [];
  const spread = makeSpread({
    id: 's1',
    now: NOW,
    request: {
      spot: { type: 'cell', band: 'low-sky', lane: 'items' },
      move: 'fill',
      count: 4,
      axes: MOVE_DEFS.fill.axes,
      ruleIds: [],
    },
    candidates: ORDER.map(cand),
    status: 'done',
  });
  const r = applyCommand(sampleWorld(), cmd('spread.save', { record: spread }), { now: NOW });
  if (!r.ok) throw new Error(r.error.message);
  world = r.value.world;
  patchSession({ current: 's1', live: null, queued: [], marked: [], prompt: null, focus: 'c1' });
});

describe('triage focus while a judgement is in flight', () => {
  it('k moves the focus to the next open card at once, before the world answers', async () => {
    const done = keep('c1', ORDER);
    // The transaction is still out: the focus has already left the kept card.
    expect(pending).toHaveLength(1);
    expect(sessionStore.get().focus).toBe('c2');
    pending[0]!.settle(true);
    expect(await done).toMatchObject({ ok: true });
    expect(sessionStore.get().focus).toBe('c2');
    expect(world.spreads.s1?.judgements).toHaveProperty('c1');
  });

  it('k then x back to back: the kill targets the next card, not the kept one', async () => {
    const kept = keep('c1', ORDER);
    // What `x` does: open the kill prompt on the focused card.
    const target = sessionStore.get().focus;
    expect(target).toBe('c2');
    const killed = kill(target!, '1', ORDER);
    expect(sessionStore.get().focus).toBe('c3');
    for (const p of pending) p.settle(true);
    await Promise.all([kept, killed]);
    const j = (world.spreads.s1 as unknown as { judgements: Record<string, { verdict: string }> })
      .judgements;
    expect(j.c1?.verdict).toBe('keep');
    expect(j.c2?.verdict).toBe('kill');
    expect(sessionStore.get().focus).toBe('c3');
  });

  it('a judgement the world refuses puts the focus back', async () => {
    const done = keep('c2', ORDER);
    expect(sessionStore.get().focus).toBe('c3');
    pending[0]!.settle(false);
    expect(await done).toMatchObject({ ok: false });
    expect(sessionStore.get().focus).toBe('c1');
  });

  it('a refusal does not move a focus you moved since', async () => {
    const done = keep('c1', ORDER);
    patchSession({ focus: 'c4' });
    pending[0]!.settle(false);
    await done;
    expect(sessionStore.get().focus).toBe('c4');
  });

  it('a merge moves past every merged card at once', async () => {
    patchSession({ marked: ['c1', 'c2'], focus: 'c2' });
    const done = merge(ORDER);
    expect(sessionStore.get().focus).toBe('c3');
    pending[0]!.settle(true);
    await done;
    expect(sessionStore.get().focus).toBe('c3');
  });

  it('triage keys target only an open card, read when the key is pressed', async () => {
    expect(triageTarget()).toBe('c1');
    const done = keep('c1', ORDER);
    expect(triageTarget()).toBe('c2');
    pending[0]!.settle(true);
    await done;
    // Focus put back on the kept (outgoing) card: no key may act on it.
    patchSession({ focus: 'c1' });
    expect(triageTarget()).toBeNull();
    patchSession({ focus: 'nope' });
    expect(triageTarget()).toBeNull();
    patchSession({ focus: null });
    expect(triageTarget()).toBeNull();
  });

  it('while streaming, a queued card is no target', () => {
    patchSession({
      live: {
        id: 'live',
        spot: { type: 'cell', band: 'low-sky', lane: 'items' },
        move: 'fill',
        axes: MOVE_DEFS.fill.axes,
        candidates: [cand('c1'), cand('c2')],
      } as never,
      queued: [{ type: 'keep', key: 'c1' }],
      focus: 'c1',
    });
    expect(triageTarget()).toBeNull();
    patchSession({ focus: 'c2' });
    expect(triageTarget()).toBe('c2');
  });
});
