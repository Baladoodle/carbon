import { useState, type ReactNode } from 'react';
import { Button } from '../ui';
import { chosen, initialDraft, landed, observe, rebased, typed } from './draft-state';
import { outsideStamp } from './outside';

export interface TypedDraft {
  draft: string;
  setDraft: (v: string) => void;
  dirty: () => boolean;
  /** The outside value waiting for a choice, or null. */
  theirs: string | null;
  choose: (keep: 'mine' | 'theirs') => void;
  /** Call when typing starts: only outside changes from then on count. */
  rebase: () => void;
  /**
   * Call once a commit of the draft has landed: until the next keystroke the
   * draft follows the stored value again. A commit and an undo of it can land
   * in one render, leaving the stored value what it was before, so a reset on
   * a changed value alone would keep the undone text as a dirty draft.
   * `committed` is the text that was sent: typed past it since, the draft stays.
   */
  landed: (committed: string) => void;
}

/**
 * A draft that follows the stored value, except that a change from outside
 * carbon while you're typing doesn't replace what you typed (docs/SYSTEM.md §4:
 * conflicts with unsaved edits ask which to keep). Changes carbon made itself
 * (an accepted suggestion, an undo) still replace it. The rules are the pure
 * transitions in `draft-state.ts`.
 */
export function useTypedDraft(stored: string, entityId: string): TypedDraft {
  const [state, setState] = useState(() => initialDraft(stored, outsideStamp(entityId)));
  // Derived state, set during render: no extra frame.
  const seen = observe(state, stored, outsideStamp(entityId));
  if (seen !== state) setState(seen);
  return {
    draft: seen.draft,
    setDraft: (v) => setState((s) => typed(s, v)),
    dirty: () => seen.draft !== stored,
    theirs: seen.theirs,
    choose: (keep) => setState((s) => chosen(s, keep, stored)),
    landed: (committed) => setState((s) => landed(s, committed)),
    rebase: () => setState((s) => rebased(s, outsideStamp(entityId))),
  };
}

/** The inline question under a field whose draft an outside edit overtook. */
export function ConflictPrompt({
  theirs,
  onKeepMine,
  onUseTheirs,
}: {
  theirs: string;
  onKeepMine: () => void;
  onUseTheirs: () => void;
}): ReactNode {
  return (
    <div className="bench-conflict" role="alert" data-testid="field-conflict">
      <span className="bench-conflict-text">
        Changed outside carbon: <q>{theirs === '' ? '(empty)' : theirs}</q>
      </span>
      <span className="bench-conflict-actions">
        <Button size="sm" variant="ghost" onClick={onKeepMine}>
          Keep mine
        </Button>
        <Button size="sm" variant="ghost" onClick={onUseTheirs}>
          Use theirs
        </Button>
      </span>
    </div>
  );
}
