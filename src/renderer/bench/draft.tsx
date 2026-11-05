import { useState, type ReactNode } from 'react';
import { Button } from '../ui';
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
}

/**
 * A draft that follows the stored value, except that a change from outside
 * carbon while you're typing doesn't replace what you typed (docs/SYSTEM.md §4:
 * conflicts with unsaved edits ask which to keep). Changes carbon made itself
 * (an accepted suggestion, an undo) still replace it.
 */
export function useTypedDraft(stored: string, entityId: string): TypedDraft {
  const [draft, setDraft] = useState(stored);
  const [base, setBase] = useState({ text: stored, stamp: outsideStamp(entityId) });
  const [theirs, setTheirs] = useState<string | null>(null);
  if (stored !== base.text) {
    const stamp = outsideStamp(entityId);
    const typing = draft !== base.text || theirs !== null;
    setBase({ text: stored, stamp });
    if (stamp !== base.stamp && typing) setTheirs(stored);
    else {
      setDraft(stored);
      setTheirs(null);
    }
  }
  return {
    draft,
    setDraft,
    dirty: () => draft !== stored,
    theirs,
    choose: (keep) => {
      setTheirs(null);
      if (keep === 'theirs') setDraft(stored);
    },
    rebase: () => {
      const stamp = outsideStamp(entityId);
      if (stamp !== base.stamp) setBase({ text: base.text, stamp });
    },
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
