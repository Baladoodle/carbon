import { useEffect, useState, type ReactNode } from 'react';
import type { AiLogEntry } from '@core/ai/gateway';
import { useActions } from '../actions';
import { setUi } from '../state/ui';
import { ai, useAiStatus } from './client';

/**
 * The AI log overlay (ctrl+l). A basic list; package W4 owns and extends it
 * (opening the request it sent, cache hits, filters).
 */
export function AiLog(): ReactNode {
  const [entries, setEntries] = useState<AiLogEntry[]>([]);
  const status = useAiStatus();
  useEffect(() => {
    void ai.log(200).then(setEntries);
  }, [status.pending]);
  useActions([
    {
      id: 'ai-log.close',
      label: 'Close the AI log',
      keys: ['escape', 'ctrl+l'],
      run: () => setUi({ overlay: null }),
      hidden: true,
    },
  ]);
  return (
    <div className="overlay" data-testid="ai-log" role="dialog" aria-label="AI log">
      <div className="overlay-panel wide">
        <header className="overlay-head">
          AI log{' '}
          <span className="dim">
            · {status.mode} · ${status.spend.sessionUsd.toFixed(2)} this session
          </span>
        </header>
        {entries.length === 0 ? (
          <p className="dim pad">No AI calls yet.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>time</th>
                <th>moment</th>
                <th>entity</th>
                <th>outcome</th>
                <th>tokens in/out</th>
                <th>cost</th>
              </tr>
            </thead>
            <tbody>
              {[...entries].reverse().map((e) => (
                <tr key={e.id}>
                  <td className="mono dim">{e.at.slice(11, 19)}</td>
                  <td>{e.moment}</td>
                  <td>{e.entity ?? ''}</td>
                  <td>{e.outcome}</td>
                  <td className="mono">
                    {e.meta ? `${e.meta.usage.input}/${e.meta.usage.output}` : ''}
                  </td>
                  <td className="mono">{e.meta ? `$${e.meta.costUsd.toFixed(4)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
