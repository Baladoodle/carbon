/**
 * The state of a Bench field's draft, as pure transitions (`draft.tsx` is the
 * hook around them). A draft follows the stored value, except that a change
 * from outside carbon while you're typing waits for Keep mine / Use theirs
 * (docs/SYSTEM.md §4), and that once your own commit has landed the draft
 * follows the store again until you type: a commit and an undo of it can land
 * in one render, leaving the stored value as it was, and a reset on a changed
 * value alone would then keep the undone text as a dirty draft.
 */
export interface DraftState {
  draft: string;
  /** The stored value last seen, and the outside stamp it was seen with. */
  base: { text: string; stamp: number };
  /** An outside value waiting for a choice. */
  theirs: string | null;
  /** A commit of the draft landed and nothing was typed since: follow the store. */
  following: boolean;
}

export const initialDraft = (stored: string, stamp: number): DraftState => ({
  draft: stored,
  base: { text: stored, stamp },
  theirs: null,
  following: false,
});

/** What a render sees: the stored value and the entity's outside stamp now. */
export function observe(s: DraftState, stored: string, stamp: number): DraftState {
  if (stored !== s.base.text) {
    const typing = (s.draft !== s.base.text && !s.following) || s.theirs !== null;
    const base = { text: stored, stamp };
    if (stamp !== s.base.stamp && typing) return { ...s, base, theirs: stored };
    return { ...s, base, draft: stored, theirs: null };
  }
  if (s.following && s.theirs === null && s.draft !== stored) return { ...s, draft: stored };
  return s;
}

export const typed = (s: DraftState, text: string): DraftState => ({
  ...s,
  draft: text,
  following: false,
});

export const chosen = (s: DraftState, keep: 'mine' | 'theirs', stored: string): DraftState => ({
  ...s,
  theirs: null,
  ...(keep === 'theirs' ? { draft: stored } : {}),
});

/** Typing starts: only outside changes from now on count. */
export const rebased = (s: DraftState, stamp: number): DraftState =>
  stamp === s.base.stamp ? s : { ...s, base: { text: s.base.text, stamp } };

/** A commit of `committed` landed; typed past it since, the draft stays. */
export const landed = (s: DraftState, committed: string): DraftState =>
  s.draft === committed ? { ...s, following: true } : s;
