import { useState, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import { imageSettings } from '@core/images/pricing';
import { useActions } from '../actions';
import { flash } from '../state/ui';
import { currentWorld, dispatch } from '../state/world';
import { Button, Dialog, Field, Input, Tooltip } from '../ui';
import { usd, useImageStatus } from './client';

/**
 * OpenAI's part of the status line, beside Claude's: image spend against its
 * own session budget, a mark while a call is in flight, and the pause when
 * the budget is reached (a click raises it). Hidden while images are off.
 */
export function ImageStatusPiece(): ReactNode {
  const s = useImageStatus();
  const [open, setOpen] = useState(false);
  useActions([
    {
      id: 'images.budget',
      label: 'Set the image budget',
      group: 'Images',
      enabled: () => s.mode !== 'off',
      run: () => setOpen(true),
    },
  ]);
  if (s.mode === 'off' && s.spend.sessionUsd === 0) return null;
  const body = s.paused ? (
    <button
      type="button"
      className="ai-status-paused t-warn"
      data-testid="status-images"
      data-state="paused"
      onClick={() => setOpen(true)}
    >
      {`Images paused: ${s.reason ?? 'budget reached'}`}
    </button>
  ) : (
    <Tooltip
      content={`OpenAI images: ${usd(s.spend.monthUsd)} of ${usd(s.budget.monthUsd)} this month · ${s.model} · ${s.quality}`}
    >
      <span
        className="t-ai num"
        tabIndex={0}
        data-testid="status-images"
        data-mode={s.mode}
        data-state={s.pending > 0 ? 'pending' : 'idle'}
      >
        {`images ${usd(s.spend.sessionUsd)} / ${usd(s.budget.sessionUsd)}`}
        {s.pending > 0 && <span className="ai-status-pending" aria-label="Images working" />}
      </span>
    </Tooltip>
  );
  return (
    <>
      {body}
      {open && <ImageBudgetDialog onClose={() => setOpen(false)} />}
    </>
  );
}

/** Raising the image budget un-pauses images (the gateway re-reads `settings.images.budget`). */
function ImageBudgetDialog({ onClose }: { onClose: () => void }): ReactNode {
  const s = useImageStatus();
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
    const raw = (currentWorld()?.settings as { images?: unknown } | undefined)?.images;
    const base = raw && typeof raw === 'object' ? raw : imageSettings(undefined);
    const r = await dispatch(
      cmd('settings.set', {
        key: 'images',
        value: { ...base, budget: { sessionUsd, monthUsd } },
      }),
    );
    if (!r.ok) flash(r.error.message, 'error');
    else onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Image budget"
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
            data-testid="image-budget-save"
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
            data-testid="image-budget-session"
            autoFocus
          />
        </Field>
        <Field
          label={`Month, spent ${usd(s.spend.monthUsd)}`}
          error={monthUsd === null ? 'A dollar amount' : null}
        >
          <Input mono value={month} onChange={(e) => setMonth(e.target.value)} />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
