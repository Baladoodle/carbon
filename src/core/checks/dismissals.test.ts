import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import { critiqueNotes } from '../bench/critique';
import type { World } from '../model/world';
import { commandArb } from '../testing/arbitraries';
import { sampleWorld } from '../testing/sample';
import { stressWorld } from '../testing/stress';
import { CHECK_KINDS, checkNoteSubjects } from './checks';
import { DISMISSAL_GRACE_DAYS, isDeadDismissal, pruneDismissals } from './dismissals';
import { runChecks } from './runner';

const ctx = { now: '2026-11-05T10:00:00.000Z' };
const step = (w: World, c: Command): World => {
  const r = applyCommand(w, c, ctx);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.world;
};

describe('checkNoteSubjects', () => {
  it('property: names only entities the note is about, and they exist', () => {
    const start = sampleWorld();
    const ids = Object.keys(start.entities);
    fc.assert(
      fc.property(fc.array(commandArb(ids), { maxLength: 15 }), (cs) => {
        let w = start;
        for (const c of cs) {
          const r = applyCommand(w, c, ctx);
          if (r.ok) w = r.value.world;
        }
        for (const n of runChecks(w)) {
          const subjects = checkNoteSubjects(n.id);
          for (const s of subjects) {
            expect(n.entities, n.id).toContain(s);
            expect(w.entities[s], n.id).toBeDefined();
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('reads the subjects of every kind that has them', () => {
    const notes = [...runChecks(stressWorld(400)), ...runChecks(sampleWorld())];
    const seen = new Map<string, number>();
    for (const n of notes)
      seen.set(n.kind, Math.max(seen.get(n.kind) ?? 0, checkNoteSubjects(n.id).length));
    for (const [kind, max] of seen) {
      const none = kind === 'lane-imbalance' || kind === 'formula-error';
      expect(max > 0, kind).toBe(!none);
      expect(CHECK_KINDS).toContain(kind);
    }
    // Ids it can't read give nothing, never a guess.
    expect(checkNoteSubjects('check:relation:Not An Id:x')).toEqual([]);
    expect(checkNoteSubjects('check:mystery:a:b')).toEqual([]);
    expect(checkNoteSubjects('ai:glide:x:y')).toEqual([]);
    expect(checkNoteSubjects('check:cycle:supersedes:a,b')).toEqual(['a', 'b']);
    expect(checkNoteSubjects('check:lane-empty:items:deep..ground')).toEqual(['deep', 'ground']);
  });
});

describe('dead dismissals', () => {
  it('a critique note: alive while its entity is as it was, dead once it changes or goes', () => {
    let w = sampleWorld();
    const [n] = critiqueNotes(w, 'glide', [
      { kind: 'weak_identity', text: 'Sharper.', entities: [] },
    ]);
    if (!n?.inputsHash) throw new Error('no note');
    expect(isDeadDismissal(w, n.id, n.inputsHash)).toBe(false);
    // The renderer hashed its mirror's copy, which crossed IPC as JSON: the same hash.
    const mirror = JSON.parse(JSON.stringify(w)) as World;
    expect(
      critiqueNotes(mirror, 'glide', [{ kind: 'weak_identity', text: 'Sharper.', entities: [] }])[0]
        ?.inputsHash,
    ).toBe(n.inputsHash);
    w = step(w, cmd('entity.update', { id: 'glide', set: { identity: 'Changed.' } }));
    expect(isDeadDismissal(w, n.id, n.inputsHash)).toBe(true);
    expect(
      isDeadDismissal(
        step(sampleWorld(), cmd('entity.delete', { id: 'glide' })),
        n.id,
        n.inputsHash,
      ),
    ).toBe(true);
  });

  it('a check note: alive while its entities exist, dead when one is gone', () => {
    let w = step(
      sampleWorld(),
      cmd('entity.create', { kind: 'item', name: 'Spore Lantern', fields: { subkind: 'tool' } }),
    );
    const dup = runChecks(w).find((n) => n.kind === 'duplicate-name');
    if (!dup?.inputsHash) throw new Error('no duplicate note');
    expect(isDeadDismissal(w, dup.id, dup.inputsHash)).toBe(false);
    w = step(w, cmd('entity.delete', { id: 'spore-lantern-2' }));
    expect(isDeadDismissal(w, dup.id, dup.inputsHash)).toBe(true);
  });

  it('keeps what it can’t judge', () => {
    const w = sampleWorld();
    expect(isDeadDismissal(w, 'check:formula-error:abc', 'h')).toBe(false);
    expect(isDeadDismissal(w, 'check:lane-imbalance:items', 'h')).toBe(false);
    expect(isDeadDismissal(w, 'something-else', 'h')).toBe(false);
  });
});

describe('pruneDismissals', () => {
  const w = sampleWorld();
  const deadId = 'check:required-missing:gone-entity';
  const liveId = 'check:required-missing:glide';
  const day = (d: number): string => new Date(Date.UTC(2026, 10, 1 + d)).toISOString();

  it('marks a dead dismissal, keeps it through the grace period, then prunes it', () => {
    const file = { notes: { [deadId]: 'h1', [liveId]: 'h2' }, dead: {} };
    const a = pruneDismissals(file, w, day(0));
    expect(a.changed).toBe(true);
    expect(a.pruned).toEqual([]);
    expect(a.file).toEqual({ notes: file.notes, dead: { [deadId]: day(0) } });
    const b = pruneDismissals(a.file, w, day(DISMISSAL_GRACE_DAYS - 1));
    expect(b.changed).toBe(false);
    expect(b.file).toEqual(a.file);
    const c = pruneDismissals(b.file, w, day(DISMISSAL_GRACE_DAYS));
    expect(c.pruned).toEqual([deadId]);
    expect(c.file).toEqual({ notes: { [liveId]: 'h2' }, dead: {} });
  });

  it('forgets the date of a dismissal that comes alive again (the world came back)', () => {
    const file = { notes: { [liveId]: 'h2' }, dead: { [liveId]: day(0) } };
    const r = pruneDismissals(file, w, day(40));
    expect(r.pruned).toEqual([]);
    expect(r.file).toEqual({ notes: { [liveId]: 'h2' }, dead: {} });
  });

  it('treats an unreadable date as today', () => {
    const r = pruneDismissals(
      { notes: { [deadId]: 'h' }, dead: { [deadId]: 'garbage' } },
      w,
      day(5),
    );
    expect(r.file.dead).toEqual({ [deadId]: day(5) });
  });
});
