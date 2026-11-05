import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import type { SaveStatus } from '@shared/ipc';
import { AiStatus } from '../ai/AiStatus';
import { ImageStatusPiece } from '../images/StatusPiece';
import { invoke, on } from '../bridge';
import { useNotes } from '../state/notes';
import { useWorldMeta } from '../state/world';
import { Tooltip } from '../ui';
import { useEntityCount } from './StatusLine.count';

function useSaveStatus(): SaveStatus {
  const [s, set] = useState<SaveStatus>({ state: 'saved' });
  useEffect(() => {
    void invoke('store:status', null).then(set);
    return on('store:status', set);
  }, []);
  return s;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Only things that change and that you act on (VISUAL.md §1): the entity count
 * (the world directory is in its tooltip), open notes, unreadable files, AI
 * spend or why the AI is off, and the save state while it isn't simply saved.
 */
export function StatusLine(): ReactNode {
  const meta = useWorldMeta();
  const count = useEntityCount();
  const notes = useNotes();
  const save = useSaveStatus();
  const quarantined = meta.issues.some((i) => i.message.includes('.carbon/quarantine/'));
  return (
    <footer className="status" data-testid="status-line">
      <Tooltip content={meta.dir}>
        <span data-testid="status-entities" tabIndex={0}>
          {plural(count ?? 0, 'entity', 'entities')}
        </span>
      </Tooltip>
      {notes.length > 0 && (
        <span className="t-warn" data-testid="status-notes" data-count={notes.length}>
          {plural(notes.length, 'note', 'notes')}
        </span>
      )}
      {meta.issues.length > 0 && (
        <Tooltip content={meta.issues.map((i) => `${i.path}: ${i.message}`).join('\n')}>
          <span
            className="t-danger"
            tabIndex={0}
            data-testid="status-issues"
            // A click opens the quarantine folder when files were moved there (W6).
            role={quarantined ? 'button' : undefined}
            onClick={quarantined ? () => void invoke('store:openQuarantine', null) : undefined}
            onKeyDown={
              quarantined
                ? (e) => {
                    if (e.key === 'Enter') void invoke('store:openQuarantine', null);
                  }
                : undefined
            }
          >
            {plural(meta.issues.length, 'unreadable file', 'unreadable files')}
          </span>
        </Tooltip>
      )}
      <span className="spacer" />
      <AiStatus />
      <ImageStatusPiece />
      <span
        data-testid="status-save"
        data-state={save.state}
        className={save.state === 'error' ? 't-danger' : undefined}
        title={save.message}
      >
        {save.state === 'saving' ? 'saving…' : save.state === 'error' ? 'save failed' : ''}
      </span>
      {meta.status === 'error' && <span className="t-danger">{meta.error}</span>}
    </footer>
  );
}
