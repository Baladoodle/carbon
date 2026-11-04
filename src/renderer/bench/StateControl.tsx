import { useState, type ReactNode } from 'react';
import { cmd, type Command } from '@core/commands/registry';
import type { Entity } from '@core/model/entity';
import type { EntityState } from '@core/model/kinds';
import { canTransition, missingFor } from '@core/model/lifecycle';
import { schemaOf, type World } from '@core/model/world';
import { createStore, useStore } from '../state/store';
import { flash } from '../state/ui';
import { transact } from '../state/world';
import { Button, Dialog, Input, Kbd, Textarea } from '../ui';
import { settled } from './controller';
import { defOf } from './value';

/**
 * The lifecycle on the Bench (docs/EXPERIENCE.md §8): transitions, the Why
 * gate to mark an entity decided, and kill reasons for the graveyard. Every
 * change is one command (or one transaction), so it undoes in one step, and
 * a state change triggers a critique.
 */
export const stateDialog = createStore<{ kind: 'why' | 'kill'; entity: string } | null>(null);
/** Fields a failed transition needs, shown under them on the Bench. */
export const neededStore = createStore<{
  entity: string;
  state: EntityState;
  keys: string[];
} | null>(null);

/** Missing field keys from a refused command's detail, wherever the transaction put them. */
export function missingFrom(detail: unknown): string[] {
  const d = detail as { missing?: unknown; cause?: { missing?: unknown } } | undefined;
  const m = d?.missing ?? d?.cause?.missing;
  return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
}

/** The commands that bring an entity to `state` (idea → decided passes through shaped, in one step). */
export function pathTo(
  e: Entity,
  state: EntityState,
  extra: { why?: string; killed?: { reason: string; note?: string } } = {},
): Command[] | null {
  const set = (s: EntityState, more: object = {}): Command =>
    cmd('entity.setState', { id: e.id, state: s, ...more });
  if (canTransition(e.state, state))
    return [
      set(
        state,
        state === 'decided'
          ? { why: extra.why }
          : state === 'graveyard'
            ? { killed: extra.killed }
            : {},
      ),
    ];
  if (e.state === 'idea' && state === 'decided')
    return [set('shaped'), set('decided', { why: extra.why })];
  return null;
}

/** Applies a state change; on missing fields, marks them on the Bench. */
export async function changeState(
  world: World,
  e: Entity,
  state: EntityState,
  extra: Parameters<typeof pathTo>[2] = {},
): Promise<boolean> {
  const path = pathTo(e, state, extra);
  if (!path) {
    flash(`${e.name} can’t go from ${e.state} to ${state}`, 'error');
    return false;
  }
  await settled(e.id);
  const r = await transact(`Mark ${e.name} ${state}`, path);
  if (!r.ok) {
    const keys = missingFrom(r.error.detail);
    if (keys.length > 0) {
      const kind = schemaOf(world).kinds[e.kind];
      neededStore.set({ entity: e.id, state, keys });
      const names = keys.map((k) => defOf(kind, k)?.label.toLowerCase() ?? k);
      flash(`To be ${state}, ${e.name} needs ${names.join(', ')}`, 'error');
    } else flash(r.error.message, 'error');
    return false;
  }
  neededStore.set(null);
  // The state change critiques the entity: ai/triggers.ts sees it in the patch.
  return true;
}

/** The transitions offered from a state, as menu entries. */
export function transitions(
  world: World,
  e: Entity,
): { label: string; run: () => void; keys?: string; destructive?: boolean }[] {
  const out: { label: string; run: () => void; keys?: string; destructive?: boolean }[] = [];
  if (e.state === 'idea')
    out.push({ label: 'Mark shaped', run: () => void changeState(world, e, 'shaped') });
  if (e.state === 'idea' || e.state === 'shaped')
    out.push({
      label: 'Mark decided…',
      keys: 'd',
      run: () => stateDialog.set({ kind: 'why', entity: e.id }),
    });
  if (e.state === 'exported')
    out.push({ label: 'Back to decided', run: () => void changeState(world, e, 'decided') });
  if (e.state === 'graveyard')
    out.push({ label: 'Resurrect', run: () => void changeState(world, e, 'idea') });
  if (e.state === 'idea' || e.state === 'shaped')
    out.push({
      label: 'Move to the graveyard…',
      destructive: true,
      run: () => stateDialog.set({ kind: 'kill', entity: e.id }),
    });
  return out;
}

/** The Why gate: deciding needs a written Why. */
export function WhyDialog({ world, entity }: { world: World; entity: Entity }): ReactNode {
  const open = useStore(stateDialog, (s) => s?.kind === 'why' && s.entity === entity.id);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && stateDialog.set(null)}
      title={`Why ${entity.name}?`}
      showTitle
    >
      {open && <WhyBody world={world} entity={entity} />}
    </Dialog>
  );
}

function WhyBody({ world, entity }: { world: World; entity: Entity }): ReactNode {
  const [why, setWhy] = useState(entity.why);
  const missing = missingFor(schemaOf(world), { ...entity, why: why.trim() }, 'decided').filter(
    (k) => k !== 'why',
  );
  const kind = schemaOf(world).kinds[entity.kind];
  const submit = async (): Promise<void> => {
    if (why.trim() === '') return;
    // On failure the dialog closes too: the Bench marks the fields still needed.
    stateDialog.set(null);
    await changeState(world, entity, 'decided', { why: why.trim() });
  };
  return (
    <>
      <Textarea
        autoFocus
        aria-label="Why"
        rows={4}
        value={why}
        onChange={(e) => setWhy(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            e.stopPropagation();
            void submit();
          }
        }}
        data-testid="why-input"
      />
      {missing.length > 0 && (
        <div className="ui-field-error bench-dialog-note">
          Still needs {missing.map((k) => defOf(kind, k)?.label.toLowerCase() ?? k).join(', ')}
        </div>
      )}
      <div className="ui-dialog-footer">
        <Button variant="ghost" onClick={() => stateDialog.set(null)}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={why.trim() === ''}
          onClick={() => void submit()}
          data-testid="why-submit"
        >
          Mark decided
        </Button>
      </div>
    </>
  );
}

/** Kill reasons (docs/EXPERIENCE.md §4), picked with their key. */
export function KillDialog({ world, entity }: { world: World; entity: Entity }): ReactNode {
  const open = useStore(stateDialog, (s) => s?.kind === 'kill' && s.entity === entity.id);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && stateDialog.set(null)}
      title={`Kill ${entity.name}`}
      showTitle
    >
      {open && <KillBody world={world} entity={entity} />}
    </Dialog>
  );
}

function KillBody({ world, entity }: { world: World; entity: Entity }): ReactNode {
  const [other, setOther] = useState<string | null>(null);
  const reasons = world.taste.reasons;
  const kill = async (reason: string, note?: string): Promise<void> => {
    stateDialog.set(null);
    await changeState(world, entity, 'graveyard', {
      killed: { reason, ...(note ? { note } : {}) },
    });
  };
  return (
    <div
      className="bench-reasons"
      onKeyDown={(e) => {
        if (other !== null || e.ctrlKey || e.altKey || e.metaKey) return;
        const r = reasons.find((x) => x.key === e.key);
        if (!r) return;
        e.preventDefault();
        e.stopPropagation();
        if (r.key === '0') setOther('');
        else void kill(r.label);
      }}
      data-testid="kill-reasons"
    >
      {other === null ? (
        reasons.map((r, i) => (
          <button
            key={r.key}
            type="button"
            className="bench-reason"
            autoFocus={i === 0}
            onClick={() => (r.key === '0' ? setOther('') : void kill(r.label))}
          >
            <span>{r.label}</span>
            <Kbd>{r.key}</Kbd>
          </button>
        ))
      ) : (
        <Input
          autoFocus
          aria-label="Reason"
          value={other}
          onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && other.trim() !== '') {
              e.preventDefault();
              void kill('other', other.trim());
            }
          }}
          data-testid="kill-other"
        />
      )}
    </div>
  );
}
