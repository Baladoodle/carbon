import { useState, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import { useActions } from '../actions';
import { flash } from '../state/ui';
import { currentWorld, dispatch } from '../state/world';
import { Button, Dialog, Field, Input, Tooltip } from '../ui';
import { useAiStatus } from './client';
import { useCritiqueTriggers } from './triggers';
import './ai.css';

const usd = (n: number): string => `$${n.toFixed(2)}`;

/**
 * The AI's part of the status line: session spend against the budget (in the
 * AI's colour), a mark while a request is in flight, and, when the AI can't
 * run, why. When the budget is reached it says so and opens the budget dialog
 * on click. Mounted once, so it also owns the AI's always-on actions.
 */
export function AiStatus(): ReactNode {
  const s = useAiStatus();
  const [budgetOpen, setBudgetOpen] = useState(false);
  useCritiqueTriggers();
  useActions([
    {
      id: 'ai.budget',
      label: 'Set the AI budget',
      group: 'AI',
      enabled: () => s.mode === 'real',
      run: () => setBudgetOpen(true),
    },
  ]);

  let body: ReactNode;
  if (!s.enabled)
    body = (
      <span data-testid="status-ai" data-mode={s.mode} data-state="off" className="t-3">
        {`AI off${s.reason ? `: ${s.reason}` : ''}`}
      </span>
    );
  else if (s.paused)
    body = (
      <button
        type="button"
        data-testid="status-ai"
        data-mode={s.mode}
        data-state="paused"
        className="ai-status-paused t-warn"
        onClick={() => setBudgetOpen(true)}
      >
        {`AI paused: ${s.reason ?? 'budget reached'}`}
      </button>
    );
  else
    body = (
      <Tooltip
        content={`${usd(s.spend.monthUsd)} of ${usd(s.budget.monthUsd)} this month · ${s.model}`}
      >
        <span
          data-testid="status-ai"
          data-mode={s.mode}
          data-state={s.pending > 0 ? 'pending' : 'idle'}
          className="t-ai num"
          tabIndex={0}
        >
          {`${usd(s.spend.sessionUsd)} / ${usd(s.budget.sessionUsd)}`}
          {s.pending > 0 && <span className="ai-status-pending" aria-label="AI working" />}
        </span>
      </Tooltip>
    );

  return (
    <>
      {body}
      {budgetOpen && <BudgetDialog onClose={() => setBudgetOpen(false)} />}
    </>
  );
}

/** Raising the budget un-pauses the AI (the gateway re-reads `carbon.json` → `ai.budget`). */
function BudgetDialog({ onClose }: { onClose: () => void }): ReactNode {
  const s = useAiStatus();
  const [session, setSession] = useState(String(s.budget.sessionUsd));
  const [month, setMonth] = useState(String(s.budget.monthUsd));
  const parse = (v: string): number | null => {
    const n = Number(v);
    return v.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const sessionUsd = parse(session);
  const monthUsd = parse(month);
  const save = async (): Promise<void> => {
    if (sessionUsd === null || monthUsd === null) return;
    const ai = (currentWorld()?.settings.ai ?? {}) as Record<string, unknown>;
    const r = await dispatch(
      cmd('settings.set', { key: 'ai', value: { ...ai, budget: { sessionUsd, monthUsd } } }),
    );
    if (!r.ok) flash(r.error.message, 'error');
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="AI budget"
      showTitle
      className="ai-budget"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={sessionUsd === null || monthUsd === null}
            onClick={() => void save()}
            data-testid="ai-budget-save"
          >
            Save
          </Button>
        </>
      }
    >
      <form
        className="ai-budget-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field
          label={`Session, spent ${usd(s.spend.sessionUsd)}`}
          error={sessionUsd === null ? 'A dollar amount' : null}
        >
          <Input
            mono
            value={session}
            onChange={(e) => setSession(e.target.value)}
            data-testid="ai-budget-session"
            autoFocus
          />
        </Field>
        <Field
          label={`Month, spent ${usd(s.spend.monthUsd)}`}
          error={monthUsd === null ? 'A dollar amount' : null}
        >
          <Input
            mono
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            data-testid="ai-budget-month"
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
