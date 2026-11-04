import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AiLogEntry } from '@core/ai/gateway';
import { MOMENTS, type Moment } from '@core/ai/moments';
import { useActions } from '../actions';
import { setUi } from '../state/ui';
import { Table, TBody, TD, TH, THead, TR, Tabs, cx } from '../ui';
import { ai, aiRequest, useAiStatus } from './client';
import './ai.css';

/**
 * The AI log (ctrl+l): every AI call this session, newest first, with its
 * trigger, entity, tokens, cache hits, cost, latency and result. ↑/↓ (or j/k)
 * move, enter opens the request the call sent, escape closes it, then the log.
 * Everything here is the AI's, so it is drawn in `--ai` only (VISUAL.md §6.6);
 * errors keep `--danger`.
 */

const MOMENT_LABEL: Record<Moment, string> = {
  suggest_one: 'suggest',
  suggest_three: 'suggest ×3',
  fill_entity: 'fill',
  critique: 'critique',
  spread: 'spread',
  patterns: 'patterns',
  spec_draft: 'spec',
};

const usd = (n: number): string => (n === 0 ? '$0' : n < 0.0001 ? '<$0.0001' : `$${n.toFixed(4)}`);
const tokens = (n: number | undefined): string =>
  n === undefined || n === 0 ? '' : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);

function result(e: AiLogEntry): { text: string; tone: string } {
  if (e.outcome === 'cached') return { text: 'cached', tone: 't-ai' };
  if (e.outcome === 'cancelled') return { text: 'cancelled', tone: 't-3' };
  if (e.outcome === 'error') return { text: e.error?.code ?? 'error', tone: 't-danger' };
  const dropped = e.meta?.dropped ? ` · ${e.meta.dropped} dropped` : '';
  return { text: `${e.results ?? 0}${dropped}`, tone: 't-2' };
}

export interface LogTotals {
  calls: number;
  costUsd: number;
  /** Cache-read tokens over all input tokens, 0..1. */
  cacheRate: number;
  cached: number;
}

export function totals(entries: readonly AiLogEntry[]): LogTotals {
  let costUsd = 0;
  let read = 0;
  let input = 0;
  let calls = 0;
  let cached = 0;
  for (const e of entries) {
    if (e.outcome === 'cached') cached++;
    if (!e.meta || e.meta.cached) continue;
    calls++;
    costUsd += e.meta.costUsd;
    read += e.meta.usage.cacheRead;
    input += e.meta.usage.input + e.meta.usage.cacheRead + e.meta.usage.cacheWrite;
  }
  return { calls, costUsd, cacheRate: input > 0 ? read / input : 0, cached };
}

export function AiLog(): ReactNode {
  const [entries, setEntries] = useState<AiLogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | Moment>('all');
  const [cursor, setCursor] = useState(0);
  const [open, setOpen] = useState<{
    id: string;
    text: string | null;
    params?: Record<string, unknown>;
  } | null>(null);
  const status = useAiStatus();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    void ai.log(1000).then((l) => live && setEntries(l));
    return () => {
      live = false;
    };
  }, [status.pending, status.spend.sessionUsd, status.enabled]);

  const newest = useMemo(() => [...entries].reverse(), [entries]);
  const rows = useMemo(
    () => (filter === 'all' ? newest : newest.filter((e) => e.moment === filter)),
    [newest, filter],
  );
  const t = useMemo(() => totals(entries), [entries]);
  const at = Math.min(cursor, Math.max(0, rows.length - 1));
  const current = rows[at];

  useEffect(() => {
    scroller.current?.querySelector('[data-current]')?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  const close = (): void => setUi({ overlay: null });
  const openRequest = (e: AiLogEntry | undefined): void => {
    if (!e) return;
    void aiRequest(e.id).then((r) =>
      setOpen({ id: e.id, text: r?.text ?? null, ...(r ? { params: r.params } : {}) }),
    );
  };
  const move = (d: number) => (): void => setCursor(Math.max(0, Math.min(rows.length - 1, at + d)));
  useActions([
    {
      id: 'ai-log.close',
      label: 'Close the AI log',
      keys: ['escape', 'ctrl+l'],
      run: () => (open ? setOpen(null) : close()),
      hidden: true,
    },
    { id: 'ai-log.down', label: 'Next call', keys: ['arrowdown', 'j'], run: move(1), hidden: true },
    {
      id: 'ai-log.up',
      label: 'Previous call',
      keys: ['arrowup', 'k'],
      run: move(-1),
      hidden: true,
    },
    {
      id: 'ai-log.open',
      label: 'Open the request',
      keys: ['enter'],
      run: () => openRequest(current),
      hidden: true,
    },
  ]);

  const present = MOMENTS.filter((m) => entries.some((e) => e.moment === m));
  const tabs = [
    { value: 'all', label: 'all', count: entries.length },
    ...present.map((m) => ({
      value: m,
      label: MOMENT_LABEL[m],
      count: entries.filter((e) => e.moment === m).length,
    })),
  ];

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
          <>
            <div className="ai-log-head">
              {present.length > 1 ? (
                <Tabs
                  value={filter}
                  onValueChange={(v) => {
                    setFilter(v as 'all' | Moment);
                    setCursor(0);
                  }}
                  tabs={tabs}
                  aria-label="Moment"
                />
              ) : (
                <span />
              )}
              <span className="ai-log-totals num t-ai" data-testid="ai-log-totals">
                {`${usd(t.costUsd)} · ${t.calls} ${t.calls === 1 ? 'call' : 'calls'}`}
                {t.cached > 0 && ` · ${t.cached} cached`}
                {t.calls > 0 && ` · ${Math.round(t.cacheRate * 100)}% cache read`}
              </span>
            </div>
            <div className="ai-log-body" ref={scroller}>
              <Table>
                <THead>
                  <tr>
                    <TH>time</TH>
                    <TH>moment</TH>
                    <TH>entity</TH>
                    <TH>result</TH>
                    <TH numeric>in</TH>
                    <TH numeric>cache</TH>
                    <TH numeric>out</TH>
                    <TH numeric>cost</TH>
                    <TH numeric>ms</TH>
                  </tr>
                </THead>
                <TBody>
                  {rows.map((e, i) => {
                    const r = result(e);
                    const u = e.meta?.usage;
                    return (
                      <TR
                        key={e.id}
                        current={i === at}
                        data-testid="ai-log-row"
                        data-outcome={e.outcome}
                        onClick={() => {
                          setCursor(i);
                          openRequest(e);
                        }}
                      >
                        <TD mono className="t-3">
                          {e.at.slice(11, 19)}
                        </TD>
                        <TD className="t-ai">
                          {MOMENT_LABEL[e.moment]}
                          {e.trigger && e.trigger !== 'on_demand' && (
                            <span className="t-3">{` · ${e.trigger === 'finish_edit' ? 'edit' : 'state'}`}</span>
                          )}
                        </TD>
                        <TD mono className="ai-log-entity">
                          {e.entity ?? ''}
                        </TD>
                        <TD className={r.tone} title={e.error?.message}>
                          {r.text}
                        </TD>
                        <TD numeric>{tokens(u ? u.input + u.cacheWrite : e.estimate)}</TD>
                        <TD numeric className="t-ai">
                          {tokens(u?.cacheRead)}
                        </TD>
                        <TD numeric>{tokens(u?.output)}</TD>
                        <TD numeric>{e.meta && !e.meta.cached ? usd(e.meta.costUsd) : ''}</TD>
                        <TD numeric className="t-3">
                          {e.meta && !e.meta.cached ? Math.round(e.meta.latencyMs) : ''}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
            {open && (
              <div className={cx('ai-log-request')} data-testid="ai-log-request">
                {open.params && (
                  <div className="ai-log-params num t-2">
                    {Object.entries(open.params)
                      .map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`)
                      .join(' · ')}
                  </div>
                )}
                <pre className="ai-log-prompt mono">
                  {open.text ?? 'The request text is kept for this session’s calls only.'}
                </pre>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
