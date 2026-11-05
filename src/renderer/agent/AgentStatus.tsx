import { useEffect, useState, type ReactNode } from 'react';
import type { AgentLogEntry } from '@shared/agent';
import { RANK, useActions } from '../actions';
import { flash, setUi, uiStore, useUi } from '../state/ui';
import { undo, useWorldMeta } from '../state/world';
import { Button, Empty, Input, Table, TBody, TD, TH, THead, TR, Tooltip, cx } from '../ui';
import {
  connectedLabel,
  setAgentSettings,
  startAgentSync,
  useAgentLog,
  useAgentStatus,
} from './client';
import './agent.css';

/**
 * The agent's part of the status line (docs/MCP.md §6): while an agent is
 * connected, its name in `--agent`; a click opens the Agent overlay. Mounted
 * once, so it also owns the sync, the overlay and its action.
 */
export function AgentStatus(): ReactNode {
  useEffect(() => startAgentSync(), []);
  const s = useAgentStatus();
  const overlay = useUi((u) => u.overlay);
  useActions(
    [
      {
        id: 'agent.open',
        label: 'Agent access and log',
        group: 'AI',
        keys: ['ctrl+shift+l'],
        run: () => setUi({ overlay: uiStore.get().overlay === 'agent' ? null : 'agent' }),
      },
    ],
    true,
    { rank: RANK.shell },
  );
  const label = connectedLabel(s);
  const tip = [
    s.connections.length > 0
      ? `Connected: ${s.connections.map((c) => c.client ?? 'agent').join(', ')}`
      : null,
    s.settings.access ? null : 'Agent access is off',
    s.settings.spend
      ? `May spend: $${s.spend.sessionUsd.toFixed(2)} of $${s.settings.budget.sessionUsd.toFixed(2)}`
      : 'Paid calls off',
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <>
      {label !== null && (
        <Tooltip content={tip} keys="ctrl+shift+l">
          <button
            type="button"
            className={cx('agent-status', !s.settings.access && 'agent-status-off')}
            data-testid="status-agent"
            data-client={label}
            onClick={() => setUi({ overlay: 'agent' })}
          >
            <span className="agent-dot" aria-hidden />
            {s.settings.access ? label : `${label}: access off`}
          </button>
        </Tooltip>
      )}
      {overlay === 'agent' && <AgentPanel />}
    </>
  );
}

const usd = (n: number): string => `$${n.toFixed(2)}`;
const cost = (n: number | undefined): string =>
  n === undefined || n === 0 ? '' : n < 0.0001 ? '<$0.0001' : `$${n.toFixed(4)}`;

/** A labelled on/off switch. */
function Switch({
  on,
  label,
  onChange,
  testid,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
  testid: string;
}): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className="agent-switch"
      data-testid={testid}
      onClick={() => onChange(!on)}
    >
      <span className="agent-switch-track" aria-hidden>
        <span className="agent-switch-thumb" />
      </span>
      {label}
    </button>
  );
}

/**
 * The Agent overlay (ctrl+shift+l): access, spending and its budget, who is
 * connected, and every tool call this session, newest first. A write can be
 * undone from here while it's still the last change.
 */
function AgentPanel(): ReactNode {
  const s = useAgentStatus();
  const log = useAgentLog();
  const { rev } = useWorldMeta();
  const [session, setSession] = useState(String(s.settings.budget.sessionUsd));
  const [month, setMonth] = useState(String(s.settings.budget.monthUsd));
  const close = (): void => setUi({ overlay: null });
  useActions([
    {
      id: 'agent.close',
      label: 'Close',
      keys: ['escape', 'ctrl+shift+l'],
      run: close,
      hidden: true,
      inInputs: true,
    },
  ]);
  const parse = (v: string): number | null => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const sessionUsd = parse(session);
  const monthUsd = parse(month);
  const budgetChanged =
    sessionUsd !== s.settings.budget.sessionUsd || monthUsd !== s.settings.budget.monthUsd;
  const saveBudget = (): void => {
    if (sessionUsd === null || monthUsd === null) return;
    void setAgentSettings({ budget: { sessionUsd, monthUsd } });
  };
  const rows = [...log].reverse();

  return (
    <div className="palette-scrim" onMouseDown={close}>
      <div
        className="ui-overlay agent-panel"
        data-testid="agent-panel"
        role="dialog"
        aria-label="Agent"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="agent-head">
          <Switch
            on={s.settings.access}
            label="Agent access"
            testid="agent-access"
            onChange={(access) => void setAgentSettings({ access })}
          />
          <Switch
            on={s.settings.spend}
            label="Allow agents to spend"
            testid="agent-spend"
            onChange={(spend) => void setAgentSettings({ spend })}
          />
          <form
            className="agent-budget"
            onSubmit={(e) => {
              e.preventDefault();
              saveBudget();
            }}
          >
            <span className="t-2 num">{`${usd(s.spend.sessionUsd)} of`}</span>
            <Input
              mono
              aria-label="Agent budget per session"
              value={session}
              invalid={sessionUsd === null}
              onChange={(e) => setSession(e.target.value)}
              data-testid="agent-budget-session"
            />
            <span className="t-2 num">{`· ${usd(s.spend.monthUsd)} of`}</span>
            <Input
              mono
              aria-label="Agent budget per month"
              value={month}
              invalid={monthUsd === null}
              onChange={(e) => setMonth(e.target.value)}
              data-testid="agent-budget-month"
            />
            {budgetChanged && sessionUsd !== null && monthUsd !== null && (
              <Button size="sm" type="submit" data-testid="agent-budget-save">
                Save
              </Button>
            )}
          </form>
          <span className="agent-who t-2" data-testid="agent-connections">
            {s.connections.length === 0
              ? s.listening
                ? null
                : (s.reason ?? null)
              : s.connections.map((c) => c.client ?? 'agent').join(', ')}
          </span>
        </div>
        {rows.length === 0 ? (
          <Empty className="agent-empty">
            No agent calls yet. Connect one with <code className="mono">carbon mcp</code>.
          </Empty>
        ) : (
          <div className="agent-body">
            <Table>
              <THead>
                <TR>
                  <TH>Time</TH>
                  <TH>Tool</TH>
                  <TH>What</TH>
                  <TH>Result</TH>
                  <TH numeric>Cost</TH>
                  <TH />
                </TR>
              </THead>
              <TBody>
                {rows.map((e) => (
                  <Row
                    key={e.id}
                    e={e}
                    undoable={e.kind === 'write' && e.rev === rev && e.outcome === 'ok'}
                  />
                ))}
              </TBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ e, undoable }: { e: AgentLogEntry; undoable: boolean }): ReactNode {
  return (
    <TR data-testid="agent-log-row" data-tool={e.tool} data-outcome={e.outcome}>
      <TD mono className="t-3">
        {e.at.slice(11, 19)}
      </TD>
      <TD mono className="t-agent">
        {e.tool}
      </TD>
      <TD className="agent-what">{e.summary}</TD>
      <TD className={e.outcome === 'error' ? 't-danger' : 't-2'} title={e.error?.message}>
        {e.outcome === 'error' ? (e.error?.code ?? 'error') : 'ok'}
      </TD>
      <TD numeric className="t-3">
        {cost(e.costUsd)}
      </TD>
      <TD>
        {undoable && (
          <Button
            size="sm"
            variant="ghost"
            data-testid="agent-undo"
            onClick={() =>
              void undo().then((r) => {
                if (!r.ok) flash(r.error.message, 'error');
              })
            }
          >
            Undo
          </Button>
        )}
      </TD>
    </TR>
  );
}
