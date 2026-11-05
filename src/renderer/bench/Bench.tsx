import { useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import type { Entity } from '@core/model/entity';
import { schemaOf, type World } from '@core/model/world';
import { useActions, type Action, RANK } from '../actions';
import { dismissNote, useNotes } from '../state/notes';
import { useStore } from '../state/store';
import { flash, focusEntity, uiStore, useUi } from '../state/ui';
import { transact, undo, useEntity, useWorld } from '../state/world';
import {
  Button,
  IconButton,
  IconClose,
  IconPlus,
  Input,
  Empty,
  Kbd,
  Menu,
  StateGlyph,
  toast,
  type MenuEntry,
} from '../ui';
import { placementOf } from '@core/column/placement';
import './bench.css';
import { finishEditing } from '../ai/triggers';
import { entityConsequences } from '@core/numbers';
import { useNumbers } from '../views/numbers/analysis';
import { benchAi, commitAttribute, settled } from './controller';
import { ConflictPrompt, useTypedDraft } from './draft';
import { watchOutside } from './outside';
import { FieldRow, focusSibling, useFocusRequest } from './fields';
import { Relations } from './Relations';
import { KillDialog, neededStore, stateDialog, transitions, WhyDialog } from './StateControl';
import { benchStore, fieldId, setBench, useBench } from './store';
import { attributesFor, COMMON_DEFS, defOf, parseNumber } from '@core/bench/value';
import type { FieldDef } from '@core/model/fields';
import { splitFields } from '@core/bench/optional';
import { missingFor, requiredFor } from '@core/model/lifecycle';
import { requestFieldFocus } from './store';
import { BenchImages, benchImageMenu } from '../images/BenchImages';

/**
 * The Bench (docs/EXPERIENCE.md §3): the entity in focus, rendered from its
 * kind's schema. Every edit is a command (undoable); the AI moments run at
 * their keys; with nothing in focus it shows the empty state (VISUAL.md §7).
 */
export function Bench(): ReactNode {
  useEffect(watchOutside, []);
  const focus = useUi((s) => s.focus);
  const entity = useEntity(focus);
  const world = useWorld((w) => w, Object.is);

  // Closing the Bench finishes the edit (moving focus is handled in ai/triggers.ts).
  const prev = useRef<string | null>(null);
  useEffect(() => {
    prev.current = focus;
  }, [focus]);
  useEffect(
    () => () => {
      if (prev.current) void finishEditing(prev.current);
    },
    [],
  );

  if (!entity || !world)
    return (
      <div className="bench-empty" data-testid="bench-empty">
        <Empty>
          Nothing in focus. <Kbd>ctrl+k</Kbd> to find an entity.
        </Empty>
      </div>
    );
  return <EntityBench key={entity.id} world={world} entity={entity} />;
}

const typingIn = (root: HTMLElement | null): boolean => {
  const a = document.activeElement;
  return (
    !!root &&
    a instanceof HTMLElement &&
    root.contains(a) &&
    (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA')
  );
};

function EntityBench({ world, entity }: { world: World; entity: Entity }): ReactNode {
  const root = useRef<HTMLDivElement>(null);
  const kind = schemaOf(world).kinds[entity.kind];
  const field = useBench((s) => (s.field?.entity === entity.id ? s.field.key : null));
  const critiquing = useBench((s) => s.critiquing[entity.id] === true);
  const filling = useBench((s) => s.loading[fieldId(entity.id, '*')] === true);
  const proposals = useBench(
    (s) =>
      Object.entries(s.pending).filter(
        ([k, p]) => k.startsWith(`${entity.id}:`) && p.from === 'fill',
      ).length,
  );
  const needed = useStore(neededStore, (s) => (s?.entity === entity.id ? s : null));
  const numbers = useNumbers();
  const notes = useNotes(entity.id);
  useFocusRequest(root, entity.id);
  // A refused state change shows every field the target state needs, not only the first step's.
  const revealAfter = useRef<string | null>(null);
  const optional = useOptional(
    world,
    entity,
    needed ? [...needed.keys, ...requiredFor(schemaOf(world), entity, needed.state)] : [],
  );

  // Leaving the Bench for the view counts as finishing the edit.
  const onBlur = (e: FocusEvent): void => {
    const next = e.relatedTarget as Node | null;
    if (next && root.current?.contains(next)) return;
    // Dialogs and menus of the Bench live in portals: don't count them as leaving.
    if (
      next instanceof HTMLElement &&
      next.closest('[role="dialog"], [role="menu"], [role="listbox"]')
    )
      return;
    void finishEditing(entity.id);
  };

  const pendingHere = (): boolean => {
    const s = benchStore.get();
    const f = s.field;
    return (
      !!f &&
      f.entity === entity.id &&
      (!!s.pending[fieldId(f.entity, f.key)] ||
        (s.three?.entity === f.entity && s.three.key === f.key))
    );
  };
  const focusedField = (): string | null => {
    const f = benchStore.get().field;
    return f && f.entity === entity.id && defOf(kind, f.key) ? f.key : null;
  };
  const notInDialog = (): boolean => uiStore.get().overlay === null && stateDialog.get() === null;

  const actions: Action[] = [
    {
      id: 'bench.suggest',
      label: 'Suggest one',
      group: 'Bench',
      keys: ['tab'],
      inInputs: true,
      hidden: true,
      enabled: () =>
        notInDialog() && focusedField() !== null && defOf(kind, focusedField() ?? '')?.ai !== false,
      run: () => {
        const k = focusedField();
        if (k) void benchAi.suggestOne(entity.id, k);
      },
    },
    {
      id: 'bench.suggestThree',
      label: 'Suggest three',
      group: 'Bench',
      keys: ['shift+tab'],
      inInputs: true,
      hidden: true,
      enabled: () =>
        notInDialog() && focusedField() !== null && defOf(kind, focusedField() ?? '')?.ai !== false,
      run: () => {
        const k = focusedField();
        if (k) void benchAi.suggestThree(entity.id, k);
      },
    },
    ...[0, 1, 2].map((i): Action => ({
      id: `bench.pick${i + 1}`,
      label: `Pick suggestion ${i + 1}`,
      keys: [String(i + 1)],
      inInputs: true,
      hidden: true,
      enabled: () => {
        const t = benchStore.get().three;
        return t !== null && t.entity === entity.id && t.options[i] !== undefined;
      },
      run: () => void benchAi.pickThree(i),
    })),
    {
      id: 'bench.dismiss',
      label: 'Dismiss the suggestion',
      keys: ['escape'],
      inInputs: true,
      hidden: true,
      enabled: () => notInDialog() && (pendingHere() || typingIn(root.current)),
      run: () => {
        const k = focusedField();
        if (k && pendingHere()) return benchAi.dismiss(entity.id, k);
        (document.activeElement as HTMLElement | null)?.blur();
      },
    },
    {
      id: 'bench.fill',
      label: 'Fill empty fields',
      group: 'Bench',
      keys: ['ctrl+enter'],
      inInputs: true,
      enabled: notInDialog,
      run: () => void settled(entity.id).then(() => benchAi.fill(entity.id)),
    },
    {
      id: 'bench.acceptAll',
      label: 'Accept every proposal',
      group: 'Bench',
      enabled: () => benchAi.proposalsOf(entity.id).length > 0,
      run: () => void benchAi.acceptAll(entity.id),
    },
    {
      id: 'bench.rejectAll',
      label: 'Reject every proposal',
      group: 'Bench',
      enabled: () => benchAi.proposalsOf(entity.id).length > 0,
      run: () => benchAi.rejectAll(entity.id),
    },
    {
      id: 'bench.critique',
      label: 'Critique now',
      group: 'Bench',
      keys: ['?'],
      enabled: notInDialog,
      run: () => void settled(entity.id).then(() => benchAi.critique(entity.id, 'on_demand')),
    },
    {
      id: 'bench.save',
      label: 'Finish editing',
      group: 'Bench',
      keys: ['ctrl+s'],
      inInputs: true,
      run: () => {
        // Commit the field being typed in (its blur commits), then critique if anything changed.
        const a = document.activeElement as HTMLElement | null;
        if (a && root.current?.contains(a)) {
          a.blur();
          a.focus();
        }
        void finishEditing(entity.id);
      },
    },
    {
      id: 'bench.decide',
      label: 'Mark decided…',
      group: 'Bench',
      keys: ['d'],
      enabled: () => notInDialog() && (entity.state === 'idea' || entity.state === 'shaped'),
      run: () => stateDialog.set({ kind: 'why', entity: entity.id }),
    },
    ...transitions(world, entity)
      .filter((t) => t.keys !== 'd')
      .map((t, i): Action => ({
        id: `bench.state.${i}`,
        label: t.label,
        group: 'Bench',
        run: t.run,
      })),
    {
      id: 'bench.next',
      label: 'Next field',
      keys: ['alt+arrowdown'],
      inInputs: true,
      hidden: true,
      run: () => focusSibling(root.current, 1),
    },
    {
      id: 'bench.prev',
      label: 'Previous field',
      keys: ['alt+arrowup'],
      inInputs: true,
      hidden: true,
      run: () => focusSibling(root.current, -1),
    },
    {
      id: 'bench.dismissNotes',
      label: `Dismiss the notes on ${entity.name}`,
      group: 'Bench',
      enabled: () => notes.length > 0,
      run: () => {
        for (const n of notes) dismissNote(n.id);
      },
    },
    ...entity.relations.map((r): Action => ({
      id: `bench.unrelate.${r.type}.${r.target}`,
      label: `Unrelate ${world.entities[r.target]?.name ?? r.target} (${schemaOf(world).relations[r.type]?.label ?? r.type})`,
      group: 'Bench',
      run: () =>
        void transact(`Unrelate ${world.entities[r.target]?.name ?? r.target}`, [
          cmd('relation.remove', { from: entity.id, type: r.type, to: r.target }),
        ]).then((x) => {
          if (!x.ok) flash(x.error.message, 'error');
        }),
    })),
    ...optional.hidden.map((d): Action => ({
      id: `bench.addField.${d.key}`,
      label: `Add field: ${d.label}`,
      group: 'Bench',
      run: () => optional.reveal(d.key),
    })),
    {
      id: 'bench.delete',
      label: `Delete ${entity.name}`,
      group: 'Bench',
      run: () => void remove(entity),
    },
  ];
  // Below the views (their keys win while you're in them), above every layer while focus is in the Bench.
  useActions(actions, true, { rank: RANK.panel, within: root });

  const where = placementOf(world, entity.id);
  const place = where.places[0];
  const placeNames = place
    ? [place.band, place.biome]
        .filter((x): x is string => !!x && x !== entity.id)
        .map((id) => world.entities[id]?.name ?? id)
    : [];
  const menu: MenuEntry[] = [
    {
      label: 'Fill empty fields',
      keys: 'ctrl+enter',
      onSelect: () => void benchAi.fill(entity.id),
    },
    {
      label: 'Critique now',
      keys: '?',
      onSelect: () => void benchAi.critique(entity.id, 'on_demand'),
    },
    'separator',
    ...benchImageMenu(world, entity),
    'separator',
    ...transitions(world, entity).map((t): MenuEntry => ({
      label: t.label,
      onSelect: t.run,
      ...(t.keys ? { keys: t.keys } : {}),
      ...(t.destructive ? { destructive: true } : {}),
    })),
    'separator',
    { label: 'Delete', destructive: true, onSelect: () => void remove(entity) },
  ];
  // Only while it's still missing: a field filled since the refusal no longer says so.
  const stillMissing = needed ? missingFor(schemaOf(world), entity, needed.state) : [];
  const neededFor = (key: string): string | undefined =>
    needed?.keys.includes(key) && stillMissing.includes(key)
      ? `Needed to be ${needed.state}`
      : undefined;
  const attrs = attributesFor(kind, entity);
  // Live consequences (EXPERIENCE §3): the formulas that read this entity, evaluated for it.
  const consequences = numbers
    ? entityConsequences(numbers.analysis, numbers.world, entity.id)
    : [];
  const extraAttrs = Object.keys(entity.attributes).filter((k) => !attrs.some((a) => a.key === k));

  return (
    <div
      ref={root}
      className="bench-entity"
      data-testid="bench-entity"
      data-entity={entity.id}
      data-state={entity.state}
      data-field={field ?? undefined}
      onBlur={onBlur}
    >
      <div className="bench-head">
        <StateGlyph state={entity.state} size={12} />
        <span className="bench-crumb t-2 t-meta">
          <span>
            {entity.kind === 'item' && typeof entity.fields.subkind === 'string'
              ? entity.fields.subkind
              : kind.label}
          </span>
          {placeNames.map((n) => (
            <span key={n}>{n}</span>
          ))}
          {where.inferred && <span className="t-3">inferred</span>}
        </span>
        <span className="bench-head-spacer" />
        {(critiquing || filling) && (
          <span className="bench-ai bench-loading" data-testid="bench-ai-busy">
            …
          </span>
        )}
        <Menu
          align="end"
          trigger={
            <IconButton size="sm" label="More" icon={<MoreIcon />} data-testid="bench-menu" />
          }
          items={menu}
        />
      </div>

      <FieldRow
        world={world}
        entity={entity}
        def={COMMON_DEFS.name}
        variant="title"
        bare
        needed={neededFor('name')}
      />
      <FieldRow
        world={world}
        entity={entity}
        def={COMMON_DEFS.identity}
        variant="identity"
        bare
        needed={neededFor('identity')}
      />

      <BenchImages world={world} entity={entity} />

      {proposals > 0 && (
        <div className="bench-proposals" data-testid="bench-proposals">
          <span className="t-ai">{proposals === 1 ? '1 proposal' : `${proposals} proposals`}</span>
          <span className="bench-head-spacer" />
          <Button size="sm" variant="ghost" onClick={() => benchAi.rejectAll(entity.id)}>
            Reject all
          </Button>
          <Button
            size="sm"
            onClick={() => void benchAi.acceptAll(entity.id)}
            data-testid="bench-accept-all"
          >
            Accept all
          </Button>
        </div>
      )}

      <section className="bench-section">
        {optional.shown
          .filter((d) => d.key !== 'why')
          .map((d) => (
            <FieldRow key={d.key} world={world} entity={entity} def={d} needed={neededFor(d.key)} />
          ))}
        {optional.hidden.length > 0 && (
          <Menu
            trigger={
              <Button
                size="sm"
                variant="ghost"
                className="bench-add bench-add-field"
                data-testid="bench-add-field"
              >
                <IconPlus /> Field
              </Button>
            }
            items={optional.hidden.map((d) => ({
              label: d.label,
              onSelect: () => (revealAfter.current = d.key),
            }))}
            onClosed={() => {
              const k = revealAfter.current;
              revealAfter.current = null;
              if (k) optional.reveal(k);
              else document.querySelector<HTMLElement>('[data-testid="bench-add-field"]')?.focus();
            }}
          />
        )}
      </section>

      {(attrs.length > 0 || extraAttrs.length > 0 || consequences.length > 0) && (
        <section className="bench-section">
          <h3 className="section-label">Attributes</h3>
          {attrs.map((a) => (
            <AttributeRow
              key={a.key}
              entity={entity}
              attrKey={a.key}
              label={a.label ?? a.key}
              unit={a.unit}
              min={a.min}
              max={a.max}
            />
          ))}
          {extraAttrs.map((k) => (
            <AttributeRow key={k} entity={entity} attrKey={k} label={k} />
          ))}
          {consequences.length > 0 && (
            <dl className="bench-consequences" data-testid="bench-consequences">
              {consequences.map((c) => (
                <div key={c.name} className="bench-consequence">
                  <dt className="mono t-2">{c.label}</dt>
                  {c.error !== undefined ? (
                    <dd className="t-danger">{c.error}</dd>
                  ) : (
                    <dd className="num">{c.value}</dd>
                  )}
                </div>
              ))}
            </dl>
          )}
        </section>
      )}

      <section className="bench-section">
        <h3 className="section-label">Relations</h3>
        <Relations world={world} entity={entity} />
      </section>

      {optional.shown.some((d) => d.key === 'why') && (
        <section className="bench-section">
          <h3 className="section-label">Why</h3>
          <FieldRow
            world={world}
            entity={entity}
            def={COMMON_DEFS.why}
            bare
            needed={neededFor('why')}
          />
        </section>
      )}

      {notes.length > 0 && (
        <section className="bench-section">
          <h3 className="section-label">Notes</h3>
          <ul className="bench-notes" data-testid="bench-notes">
            {notes.map((n) => (
              <li
                key={n.id}
                className="bench-note"
                data-source={n.source}
                data-severity={n.severity}
              >
                <span className="bench-note-text">{n.text}</span>
                {n.entities
                  .filter((x) => x !== entity.id)
                  .map((x) => (
                    <button
                      key={x}
                      type="button"
                      className="bench-note-link"
                      onClick={() => focusEntity(x)}
                    >
                      {world.entities[x]?.name ?? x}
                    </button>
                  ))}
                <IconButton
                  size="sm"
                  label="Dismiss"
                  icon={<IconClose />}
                  onClick={() => dismissNote(n.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      )}

      <WhyDialog world={world} entity={entity} />
      <KillDialog world={world} entity={entity} />
    </div>
  );
}

/**
 * The fields the Bench shows, and the empty optional ones waiting behind
 * "+ Field" (core/bench/optional.ts). A field that has shown stays shown until
 * the entity leaves the Bench, so clearing one never makes it vanish under you.
 */
function useOptional(
  world: World,
  entity: Entity,
  needed: readonly string[],
): { shown: FieldDef[]; hidden: FieldDef[]; reveal: (key: string) => void } {
  const kind = schemaOf(world).kinds[entity.kind];
  const defs: FieldDef[] = [
    ...kind.fields,
    COMMON_DEFS.description,
    COMMON_DEFS.tags,
    COMMON_DEFS.why,
  ];
  // Fields with a reason of the moment: focus, a proposal or three waiting, a focus request.
  const live = useBench((s) => {
    const keys: string[] = [];
    if (s.field?.entity === entity.id) keys.push(s.field.key);
    if (s.three?.entity === entity.id) keys.push(s.three.key);
    if (s.focusRequest?.entity === entity.id) keys.push(s.focusRequest.key);
    for (const k of Object.keys(s.pending))
      if (k.startsWith(`${entity.id}:`)) keys.push(k.slice(entity.id.length + 1));
    return keys.join('\n');
  });
  const [sticky, setSticky] = useState<readonly string[]>([]);
  const also = new Set([...sticky, ...needed, ...(live ? live.split('\n') : [])]);
  const split = splitFields(
    schemaOf(world),
    entity,
    defs.map((d) => d.key),
    also,
  );
  // Derived state, set during render: no extra frame.
  if (split.shown.some((k) => !sticky.includes(k)))
    setSticky([...new Set([...sticky, ...split.shown])]);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const pick = (keys: string[]): FieldDef[] =>
    keys.map((k) => byKey.get(k)).filter((d): d is FieldDef => !!d);
  return {
    shown: pick(split.shown),
    hidden: pick(split.hidden),
    reveal: (key) => requestFieldFocus(entity.id, key),
  };
}

function AttributeRow({
  entity,
  attrKey,
  label,
  unit,
  min,
  max,
}: {
  entity: Entity;
  attrKey: string;
  label: string;
  unit?: string | undefined;
  min?: number | undefined;
  max?: number | undefined;
}): ReactNode {
  const stored = entity.attributes[attrKey];
  const text = stored === undefined ? '' : stored < 0 ? `−${-stored}` : String(stored);
  const { draft, setDraft, theirs, choose, rebase, landed } = useTypedDraft(text, entity.id);
  const [error, setError] = useState<string | null>(null);
  const ai = entity.ai_fields.includes(`attributes.${attrKey}`);
  const commit = async (force = false): Promise<void> => {
    // With an outside change waiting, leaving the field decides nothing.
    if (theirs !== null && !force) return;
    if (draft === text) return setError(null);
    if (draft.trim() === '') return setError(await commitAttribute(entity.id, attrKey, null));
    const n = parseNumber(draft);
    if (n === null) return setError('A number');
    if (min !== undefined && n < min) return setError(`At least ${min}`);
    if (max !== undefined && n > max) return setError(`At most ${max}`);
    const sent = draft;
    const error = await commitAttribute(entity.id, attrKey, n);
    setError(error);
    if (error === null) landed(sent);
  };
  return (
    <div className="bench-field bench-attr" data-bench-field={`attributes.${attrKey}`}>
      <div className="bench-field-head">
        <label className="bench-field-label" htmlFor={`bench-attr-${entity.id}-${attrKey}`}>
          {label}
        </label>
        {ai && <span className="bench-ai">ai</span>}
      </div>
      <div className="bench-row">
        <Input
          id={`bench-attr-${entity.id}-${attrKey}`}
          mono
          value={draft}
          invalid={error !== null}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => {
            rebase();
            setBench({ field: null });
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void commit();
            }
          }}
          className="bench-attr-input"
        />
        {unit && <span className="t-3 t-meta">{unit}</span>}
      </div>
      {theirs !== null && (
        <ConflictPrompt
          theirs={theirs}
          onKeepMine={() => {
            choose('mine');
            void commit(true);
          }}
          onUseTheirs={() => choose('theirs')}
        />
      )}
      {error && <div className="ui-field-error">{error}</div>}
    </div>
  );
}

async function remove(e: Entity): Promise<void> {
  const r = await transact(`Delete ${e.name}`, [cmd('entity.delete', { id: e.id })]);
  if (!r.ok) return flash(r.error.message, 'error');
  benchAi.cancel(e.id);
  focusEntity(null);
  toast(`Deleted ${e.name}`, { action: { label: 'Undo', run: () => void undo() } });
}

const MoreIcon = (): ReactNode => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <circle cx="3.5" cy="8" r="1.2" />
    <circle cx="8" cy="8" r="1.2" />
    <circle cx="12.5" cy="8" r="1.2" />
  </svg>
);
