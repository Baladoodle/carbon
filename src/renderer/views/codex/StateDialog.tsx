import { useState, type ReactNode } from 'react';
import { ENTITY_STATES, type EntityState } from '@core/model/kinds';
import { canTransition } from '@core/model/lifecycle';
import { schemaOf } from '@core/model/world';
import { useActions } from '../../actions';
import { flash } from '../../state/ui';
import { currentWorld, transact, useWorld } from '../../state/world';
import { Button, Dialog, Field, Input, Kbd, StateGlyph, Textarea, cx } from '../../ui';
import { needsWhy, planBulkState } from './columns';

const STATE_KEY: Record<EntityState, string> = {
  idea: 'i',
  shaped: 's',
  decided: 'd',
  exported: 'e',
  graveyard: 'g',
};

type Step =
  { step: 'pick' } | { step: 'why' } | { step: 'kill' } | { step: 'note'; reason: string };

/**
 * Sets the state of many entities in one transaction (one undo step). Deciding
 * asks for a Why (used where an entity has none); the graveyard asks for a kill
 * reason. Entities that can't make the move are left out and named afterwards.
 */
export function StateDialog({
  ids,
  preset,
  onClose,
}: {
  ids: string[];
  preset?: 'decided';
  onClose: () => void;
}): ReactNode {
  const reasons = useWorld((w) => w.taste.reasons) ?? [];
  const names = useWorld((w) => ids.map((id) => w.entities[id]?.name ?? id)) ?? [];
  const states = useWorld((w) => ids.map((id) => w.entities[id]?.state)) ?? [];
  const [why, setWhy] = useState('');
  const [note, setNote] = useState('');
  const [step, setStep] = useState<Step>(() => {
    const w = currentWorld();
    if (preset === 'decided') return w && needsWhy(w, ids) ? { step: 'why' } : { step: 'pick' };
    return { step: 'pick' };
  });

  const apply = async (
    state: EntityState,
    opts: { why?: string; killed?: { reason: string; note?: string } } = {},
  ): Promise<void> => {
    const w = currentWorld();
    if (!w) return;
    const plan = planBulkState(w, schemaOf(w), ids, state, opts);
    const name = (id: string): string => w.entities[id]?.name ?? id;
    const skippedText = plan.skipped
      .slice(0, 2)
      .map((s) => `${name(s.id)} ${s.reason}`)
      .join('; ');
    if (plan.commands.length === 0) {
      flash(skippedText || 'Nothing to change', 'error');
      onClose();
      return;
    }
    const label =
      plan.commands.length === 1
        ? `Mark ${name(ids[0] ?? '')} ${state}`
        : `Mark ${plan.commands.length} ${state}`;
    const r = await transact(label, plan.commands);
    if (!r.ok) flash(r.error.message, 'error');
    else if (plan.skipped.length > 0)
      flash(
        `${plan.commands.length} marked ${state}; ${plan.skipped.length} left: ${skippedText}${plan.skipped.length > 2 ? '…' : ''}`,
      );
    onClose();
  };

  const choose = (state: EntityState): void => {
    const w = currentWorld();
    if (state === 'decided' && w && needsWhy(w, ids)) setStep({ step: 'why' });
    else if (state === 'graveyard') setStep({ step: 'kill' });
    else void apply(state);
  };

  const reachable = (s: EntityState): boolean =>
    states.some((x) => x !== undefined && x !== s && canTransition(x, s));

  const pickReason = (key: string): void => {
    const r = reasons.find((x) => x.key === key);
    if (!r) return;
    if (r.key === '0') setStep({ step: 'note', reason: r.label });
    else void apply('graveyard', { killed: { reason: r.label } });
  };

  useActions(
    step.step === 'pick'
      ? ENTITY_STATES.map((s) => ({
          id: `codex.state.${s}`,
          label: s,
          keys: [STATE_KEY[s]],
          hidden: true,
          enabled: () => reachable(s),
          run: () => choose(s),
        }))
      : step.step === 'kill'
        ? reasons.map((r) => ({
            id: `codex.kill.${r.key}`,
            label: r.label,
            keys: [r.key],
            hidden: true,
            run: () => pickReason(r.key),
          }))
        : [],
  );

  const title = ids.length === 1 ? (names[0] ?? '') : `${ids.length} entities`;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={title}
      showTitle
      className="codex-dialog"
      footer={
        step.step === 'why' || step.step === 'note' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={step.step === 'why' ? why.trim() === '' : false}
              onClick={() =>
                step.step === 'why'
                  ? void apply('decided', { why })
                  : void apply('graveyard', {
                      killed: {
                        reason: step.reason,
                        ...(note.trim() ? { note: note.trim() } : {}),
                      },
                    })
              }
            >
              {step.step === 'why' ? 'Decide' : 'Kill'}
            </Button>
          </>
        ) : undefined
      }
    >
      <div data-testid="codex-state-dialog">
        {step.step === 'pick' && (
          <ul className="codex-choices" role="listbox" aria-label="State">
            {ENTITY_STATES.map((s) => (
              <li key={s}>
                <button
                  type="button"
                  className={cx('ui-menu-item', 'codex-choice')}
                  disabled={!reachable(s)}
                  onClick={() => choose(s)}
                  data-state={s}
                >
                  <StateGlyph state={s} tooltip={false} />
                  <span>{s}</span>
                  <Kbd>{STATE_KEY[s]}</Kbd>
                </button>
              </li>
            ))}
          </ul>
        )}
        {step.step === 'why' && (
          <Field label="Why">
            <Textarea
              autoFocus
              rows={3}
              value={why}
              aria-label="Why"
              data-testid="codex-why"
              onChange={(e) => setWhy(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && why.trim() !== '') {
                  e.preventDefault();
                  void apply('decided', { why });
                }
              }}
            />
          </Field>
        )}
        {step.step === 'kill' && (
          <ul className="codex-choices" role="listbox" aria-label="Kill reason">
            {reasons.map((r) => (
              <li key={r.key}>
                <button
                  type="button"
                  className="ui-menu-item codex-choice"
                  onClick={() => pickReason(r.key)}
                >
                  <span>{r.label}</span>
                  <Kbd>{r.key}</Kbd>
                </button>
              </li>
            ))}
          </ul>
        )}
        {step.step === 'note' && (
          <Field label="Reason">
            <Input
              autoFocus
              value={note}
              aria-label="Reason"
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void apply('graveyard', {
                    killed: { reason: step.reason, ...(note.trim() ? { note: note.trim() } : {}) },
                  });
                }
              }}
            />
          </Field>
        )}
      </div>
    </Dialog>
  );
}
