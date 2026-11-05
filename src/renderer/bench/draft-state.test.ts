import { describe, expect, it } from 'vitest';
import { chosen, initialDraft, landed, observe, rebased, typed } from './draft-state';

describe('a Bench draft', () => {
  it('follows carbon’s own changes and keeps your typing from them only while uncommitted', () => {
    let s = initialDraft('Glide', 0);
    s = observe(s, 'Glide II', 0); // an accept, an undo: carbon's own, no outside stamp
    expect(s.draft).toBe('Glide II');
  });

  it('a commit and its undo landing in one render: the draft goes back to the stored value', () => {
    let s = initialDraft('Glide', 0);
    s = typed(s, 'Glide II');
    // Enter commits "Glide II"; ctrl+z undoes it; both patches land before one render,
    // so the render sees "Glide" again, the value it saw last.
    s = observe(s, 'Glide', 0);
    expect(s.draft).toBe('Glide II'); // on the value alone, nothing changed
    s = landed(s, 'Glide II');
    s = observe(s, 'Glide', 0);
    expect(s.draft).toBe('Glide');
  });

  it('typing after the commit was sent keeps the newer text, even when an undo took the commit', () => {
    let s = initialDraft('Glide', 0);
    s = typed(s, 'Glide II'); // sent
    s = typed(s, 'Glide III'); // typed on before it landed
    s = observe(s, 'Glide', 0); // the commit and an undo, in one render
    s = landed(s, 'Glide II');
    s = observe(s, 'Glide', 0);
    expect(s.draft).toBe('Glide III');
  });

  it('after a landed commit, the next keystroke stops following', () => {
    let s = landed(typed(initialDraft('A', 0), 'B'), 'B');
    s = observe(s, 'B', 0);
    s = typed(s, 'BC');
    s = observe(s, 'B', 0);
    expect(s.draft).toBe('BC');
  });

  it('an outside change while you type waits for a choice', () => {
    let s = rebased(initialDraft('A', 0), 0);
    s = typed(s, 'Mine');
    s = observe(s, 'Theirs', 1);
    expect(s).toMatchObject({ draft: 'Mine', theirs: 'Theirs' });
    expect(chosen(s, 'theirs', 'Theirs')).toMatchObject({ draft: 'Theirs', theirs: null });
    expect(chosen(s, 'mine', 'Theirs')).toMatchObject({ draft: 'Mine', theirs: null });
  });

  it('an outside change after your commit landed just shows (you aren’t typing)', () => {
    let s = typed(initialDraft('A', 0), 'B');
    s = landed(observe(s, 'B', 0), 'B');
    s = observe(s, 'C', 1);
    expect(s).toMatchObject({ draft: 'C', theirs: null });
  });
});
