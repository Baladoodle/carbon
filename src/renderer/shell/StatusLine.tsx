import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { SaveStatus } from '@shared/ipc';
import { useAiStatus } from '../ai/client';
import { invoke, on } from '../bridge';
import { useNotes } from '../state/notes';
import { useUi } from '../state/ui';
import { useWorld, useWorldMeta } from '../state/world';

const tildify = (dir: string): string => dir.replace(/^\/(?:home\/[^/]+|root)(?=\/|$)/, '~');

function useSaveStatus(): SaveStatus {
  const [s, set] = useState<SaveStatus>({ state: 'saved' });
  useEffect(() => {
    void invoke('store:status', null).then(set);
    return on('store:status', set);
  }, []);
  return s;
}

/** world · entities · notes · AI spend · save state (docs/EXPERIENCE.md §1). */
export function StatusLine(): ReactNode {
  const meta = useWorldMeta();
  const count = useWorld((w) => Object.keys(w.entities).length);
  const notes = useNotes();
  const aiStatus = useAiStatus();
  const save = useSaveStatus();
  const flash = useUi((s) => s.flash);
  const ai = !aiStatus.enabled
    ? `AI off${aiStatus.reason ? `: ${aiStatus.reason}` : ''}`
    : `AI $${aiStatus.spend.sessionUsd.toFixed(2)}${aiStatus.mode === 'fake' ? ' (fake)' : ''}${aiStatus.pending > 0 ? ' …' : ''}`;
  return (
    <footer className="status" data-testid="status-line">
      <span title={meta.dir}>world: {tildify(meta.dir)}</span>
      <span data-testid="status-entities">{count ?? 0} entities</span>
      <span>
        {notes.length} {notes.length === 1 ? 'note' : 'notes'}
      </span>
      {meta.issues.length > 0 && (
        <span className="warn" title={meta.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}>
          {meta.issues.length} unreadable {meta.issues.length === 1 ? 'file' : 'files'}
        </span>
      )}
      <span data-testid="status-ai" className={aiStatus.enabled ? undefined : 'dim'}>
        {ai}
      </span>
      <span
        data-testid="status-save"
        className={save.state === 'error' ? 'error' : undefined}
        title={save.message}
      >
        {save.state === 'saving'
          ? '⟳ saving'
          : save.state === 'error'
            ? '⚠ save failed'
            : '✓ saved'}
      </span>
      <span className="spacer" />
      {flash && <span className={flash.tone === 'error' ? 'error' : 'accent'}>{flash.text}</span>}
      {meta.status === 'error' && <span className="error">{meta.error}</span>}
    </footer>
  );
}
