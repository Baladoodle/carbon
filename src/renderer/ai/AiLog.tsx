import { useEffect, useState, type ReactNode } from 'react';
import type { AiLogEntry } from '@core/ai/gateway';
import { useActions } from '../actions';
import { setUi } from '../state/ui';
import { Table, TBody, TD, TH, THead, TR } from '../ui';
import { ai, useAiStatus } from './client';

/**
 * The AI log overlay (ctrl+l): every call, newest first, in the AI's colour.
 * Package W4 owns and extends it (the request it sent, cache hits, filters).
 */
export function AiLog(): ReactNode {
  const [entries, setEntries] = useState<AiLogEntry[]>([]);
  const status = useAiStatus();
  useEffect(() => {
    void ai.log(200).then(setEntries);
  }, [status.pending]);
  const close = (): void => setUi({ overlay: null });
  useActions([
    {
      id: 'ai-log.close',
      label: 'Close the AI log',
      keys: ['escape', 'ctrl+l'],
      run: close,
      hidden: true,
    },
  ]);
  return (
    <div className="palette-scrim" onMouseDown={close}>
      <div
        className="ui-overlay ai-log"
        data-testid="ai-log"
        role="dialog"
        aria-label="AI log"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {entries.length === 0 ? (
          <p className="ai-log-empty t-2">No AI calls this session.</p>
        ) : (
          <Table>
            <THead>
              <tr>
                <TH>time</TH>
                <TH>moment</TH>
                <TH>entity</TH>
                <TH>result</TH>
                <TH numeric>in</TH>
                <TH numeric>out</TH>
                <TH numeric>cost</TH>
              </tr>
            </THead>
            <TBody>
              {[...entries].reverse().map((e) => (
                <TR key={e.id}>
                  <TD mono className="t-3">
                    {e.at.slice(11, 19)}
                  </TD>
                  <TD className="t-ai">{e.moment}</TD>
                  <TD>{e.entity ?? ''}</TD>
                  <TD className={e.outcome === 'error' ? 't-danger' : 't-2'}>
                    {e.error?.code ?? e.outcome}
                  </TD>
                  <TD numeric>{e.meta?.usage.input ?? ''}</TD>
                  <TD numeric>{e.meta?.usage.output ?? ''}</TD>
                  <TD numeric>{e.meta ? `$${e.meta.costUsd.toFixed(4)}` : ''}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </div>
    </div>
  );
}
