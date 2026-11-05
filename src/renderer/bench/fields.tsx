import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import type { Entity } from '@core/model/entity';
import type { FieldDef, Step } from '@core/model/fields';
import { fieldValue } from '@core/model/lifecycle';
import type { World } from '@core/model/world';
import { focusEntity } from '../state/ui';
import {
  Button,
  Combobox,
  IconButton,
  IconCheck,
  IconClose,
  IconPlus,
  Input,
  Kbd,
  Select,
  StateGlyph,
  Textarea,
  cx,
} from '../ui';
import { benchAi, commitField } from './controller';
import { refTargets } from '@core/bench/relations';
import { ConflictPrompt, useTypedDraft } from './draft';
import { benchStore, fieldId, setBench, useBench } from './store';
import { checkValue, formatValue, isTextual, parseNumber, parseText } from '@core/bench/value';

const FOCUSABLE = 'input, textarea, button[role="combobox"], [role="combobox"], button';

/** Tracks which field has focus, for tab / shift+tab / 1–3 / esc. */
function useFieldFocus(entity: string, key: string) {
  return {
    onFocus: () => setBench({ field: { entity, key } }),
    onBlurField: () => {
      // Leave the record alone if another field already took focus.
      setTimeout(() => {
        const f = document.activeElement?.closest('[data-bench-field]');
        if (!f) setBench({ field: null });
      }, 0);
    },
  };
}

export interface FieldProps {
  world: World;
  entity: Entity;
  def: FieldDef;
  /** Shown under the field when a state change needs it filled. */
  needed?: string | undefined;
  /** Visually the Bench title (the name) or the identity line. */
  variant?: 'title' | 'identity';
  /** Hide the label (the name and identity speak for themselves). */
  bare?: boolean;
}

/** One field of an entity: label, ai marker, control, AI proposals, errors. */
export function FieldRow({ world, entity, def, needed, variant, bare }: FieldProps): ReactNode {
  const id = fieldId(entity.id, def.key);
  const pending = useBench((s) => s.pending[id]);
  const three = useBench((s) =>
    s.three?.entity === entity.id && s.three.key === def.key ? s.three : null,
  );
  const loading = useBench(
    (s) => s.loading[id] === true || s.loading[fieldId(entity.id, '*')] === true,
  );
  const [error, setError] = useState<string | null>(null);
  const ai = entity.ai_fields.includes(def.key);
  const textual = isTextual(def);
  return (
    <div
      className={cx('bench-field', variant && `bench-field-${variant}`)}
      data-bench-field={def.key}
      data-ai={ai ? '' : undefined}
    >
      {!bare && (
        <div className="bench-field-head">
          <label className="bench-field-label" htmlFor={`bench-${id}`}>
            {def.label}
          </label>
          {ai && (
            <span className="bench-ai" data-testid={`ai-marker-${def.key}`}>
              ai
            </span>
          )}
          {loading && <span className="bench-ai bench-loading">…</span>}
        </div>
      )}
      {bare && ai && (
        <span className="bench-ai bench-ai-floating" data-testid={`ai-marker-${def.key}`}>
          ai
        </span>
      )}
      <Control
        world={world}
        entity={entity}
        def={def}
        onError={setError}
        suggestion={textual && pending ? formatValue(def, pending.value) : null}
        variant={variant}
      />
      {pending && (
        <div
          className="bench-proposal"
          data-testid={`proposal-${def.key}`}
          data-from={pending.from}
        >
          {!textual && (
            <span className="bench-proposal-value">→ {formatValue(def, pending.value)}</span>
          )}
          {pending.note && <span className="bench-proposal-note">{pending.note}</span>}
          <span className="bench-proposal-actions">
            <IconButton
              size="sm"
              label="Accept"
              keys="tab"
              icon={<IconCheck />}
              onClick={() => void benchAi.accept(entity.id, def.key)}
            />
            <IconButton
              size="sm"
              label="Reject"
              keys="esc"
              icon={<IconClose />}
              onClick={() => benchAi.dismiss(entity.id, def.key)}
            />
          </span>
        </div>
      )}
      {three && (
        <ol className="bench-three" data-testid={`three-${def.key}`}>
          {three.options.map((o, i) => (
            <li key={i}>
              <button
                type="button"
                className="bench-three-item"
                onClick={() => void benchAi.pickThree(i)}
              >
                <span className="bench-three-value">{formatValue(def, o.value)}</span>
                <Kbd>{String(i + 1)}</Kbd>
              </button>
            </li>
          ))}
        </ol>
      )}
      {(error ?? needed) && (
        <div className="ui-field-error" role="alert">
          {error ?? needed}
        </div>
      )}
    </div>
  );
}

interface ControlProps {
  world: World;
  entity: Entity;
  def: FieldDef;
  suggestion: string | null;
  onError: (e: string | null) => void;
  variant?: 'title' | 'identity' | undefined;
}

function Control(props: ControlProps): ReactNode {
  switch (props.def.type) {
    case 'text':
    case 'longtext':
    case 'number':
    case 'height':
    case 'list':
      return <TextControl {...props} />;
    case 'enum':
      return <EnumControl {...props} />;
    case 'boolean':
      return <EnumControl {...props} />;
    case 'ref':
      return <RefControl {...props} />;
    case 'range':
      return <RangeControl {...props} />;
    case 'climate':
      return <ClimateControl {...props} />;
    case 'steps':
      return <StepsControl {...props} />;
  }
}

function TextControl({ entity, def, suggestion, onError, variant }: ControlProps): ReactNode {
  const stored = formatValue(def, fieldValue(entity, def.key));
  const { draft, setDraft, dirty, theirs, choose, rebase } = useTypedDraft(stored, entity.id);
  const focus = useFieldFocus(entity.id, def.key);
  // The kit's Input wraps itself when a suggestion shows, which remounts the
  // <input>: keep focus (and the caret at the end) on this field across that.
  const el = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const showing = suggestion !== null && suggestion !== '';
  useLayoutEffect(() => {
    const f = benchStore.get().field;
    const node = el.current;
    if (!node || f?.entity !== entity.id || f.key !== def.key || document.activeElement === node)
      return;
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
  }, [showing, entity.id, def.key]);
  const commit = async (force = false): Promise<void> => {
    // With an outside change waiting, leaving the field decides nothing.
    if (theirs !== null && !force) return;
    if (!dirty()) return onError(null);
    const p = parseText(def, draft);
    if (!p.ok) return onError(p.error);
    onError(await commitField(entity.id, def.key, p.value));
  };
  const conflict =
    theirs === null ? null : (
      <ConflictPrompt
        theirs={theirs}
        onKeepMine={() => {
          choose('mine');
          void commit(true);
        }}
        onUseTheirs={() => choose('theirs')}
      />
    );
  const common = {
    ref: el,
    id: `bench-${fieldId(entity.id, def.key)}`,
    value: draft,
    suggestion,
    mono: def.type === 'number' || def.type === 'height',
    // The identity line has no label above it: empty, the placeholder is its label.
    placeholder: variant === 'identity' ? def.label : undefined,
    'aria-label': def.label,
    onFocus: () => {
      rebase();
      focus.onFocus();
    },
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      focus.onBlurField();
      void commit();
    },
  };
  if (def.type === 'longtext')
    return (
      <>
        <Textarea
          {...common}
          rows={3}
          onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && e.preventDefault()}
        />
        {conflict}
      </>
    );
  return (
    <>
      <Input
        {...common}
        className={
          variant === 'title'
            ? 'bench-title-input'
            : variant === 'identity'
              ? 'bench-identity-input'
              : undefined
        }
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.ctrlKey) {
            e.preventDefault();
            void commit();
          }
        }}
      />
      {conflict}
    </>
  );
}

function EnumControl({ entity, def, onError }: ControlProps): ReactNode {
  const v = fieldValue(entity, def.key);
  const focus = useFieldFocus(entity.id, def.key);
  const options =
    def.type === 'boolean'
      ? [
          { value: 'yes', label: 'yes' },
          { value: 'no', label: 'no' },
        ]
      : (def.options ?? []).map((o) => ({ value: o, label: o }));
  const value =
    def.type === 'boolean'
      ? v === true
        ? 'yes'
        : v === false
          ? 'no'
          : undefined
      : typeof v === 'string'
        ? v
        : undefined;
  return (
    <div className="bench-row" onFocus={focus.onFocus} onBlur={focus.onBlurField}>
      <Select
        id={`bench-${fieldId(entity.id, def.key)}`}
        aria-label={def.label}
        value={value}
        options={options}
        className="bench-grow"
        onValueChange={(x) =>
          void commitField(entity.id, def.key, def.type === 'boolean' ? x === 'yes' : x).then(
            onError,
          )
        }
      />
      {value !== undefined && (
        <IconButton
          size="sm"
          label={`Clear ${def.label.toLowerCase()}`}
          icon={<IconClose />}
          onClick={() => void commitField(entity.id, def.key, null).then(onError)}
        />
      )}
    </div>
  );
}

function RefControl({ world, entity, def, onError }: ControlProps): ReactNode {
  const v = fieldValue(entity, def.key);
  const focus = useFieldFocus(entity.id, def.key);
  const items = refTargets(world, def.refKinds, entity.id).map((t) => ({
    value: t.id,
    label: t.name,
    glyph: <StateGlyph state={t.state} tooltip={false} />,
  }));
  return (
    <div className="bench-row" onFocus={focus.onFocus} onBlur={focus.onBlurField}>
      <Combobox
        id={`bench-${fieldId(entity.id, def.key)}`}
        aria-label={def.label}
        items={items}
        value={typeof v === 'string' ? v : null}
        onChange={(x) => void commitField(entity.id, def.key, x).then(onError)}
        className="bench-grow"
      />
      {typeof v === 'string' && (
        <IconButton
          size="sm"
          label={`Clear ${def.label.toLowerCase()}`}
          icon={<IconClose />}
          onClick={() => void commitField(entity.id, def.key, null).then(onError)}
        />
      )}
    </div>
  );
}

/**
 * Number pairs (range, climate): each input commits when the pair is valid. An outside
 * edit that lands in an end you're typing in waits for Keep mine / Use theirs.
 */
function NumberPair({
  id,
  entityId,
  labels,
  values,
  onCommit,
  onFocus,
  onBlur,
  first,
}: {
  id: string;
  entityId: string;
  labels: [string, string];
  values: [number | undefined, number | undefined];
  onCommit: (a: number | null, b: number | null) => void;
  onFocus: () => void;
  onBlur: () => void;
  first?: boolean;
}): ReactNode {
  const fmt = (n: number | undefined): string =>
    n === undefined ? '' : n < 0 ? `−${-n}` : String(n);
  const a = useTypedDraft(fmt(values[0]), entityId);
  const b = useTypedDraft(fmt(values[1]), entityId);
  const waiting = a.theirs !== null || b.theirs !== null;
  const commit = (force = false): void => {
    if (waiting && !force) return;
    if (!a.dirty() && !b.dirty()) return;
    onCommit(parseNumber(a.draft), parseNumber(b.draft));
  };
  const blur = (): void => {
    onBlur();
    commit();
  };
  const focus = (): void => {
    a.rebase();
    b.rebase();
    onFocus();
  };
  const key = (e: { key: string; preventDefault: () => void }): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    }
  };
  return (
    <>
      <div className="bench-pair">
        <Input
          id={first ? id : undefined}
          mono
          aria-label={labels[0]}
          value={a.draft}
          onChange={(e) => a.setDraft(e.target.value)}
          onFocus={focus}
          onBlur={blur}
          onKeyDown={key}
        />
        <span className="t-3">…</span>
        <Input
          mono
          aria-label={labels[1]}
          value={b.draft}
          onChange={(e) => b.setDraft(e.target.value)}
          onFocus={focus}
          onBlur={blur}
          onKeyDown={key}
        />
      </div>
      {waiting && (
        <ConflictPrompt
          theirs={`${fmt(values[0])} … ${fmt(values[1])}`}
          onKeepMine={() => {
            a.choose('mine');
            b.choose('mine');
            commit(true);
          }}
          onUseTheirs={() => {
            a.choose('theirs');
            b.choose('theirs');
          }}
        />
      )}
    </>
  );
}

function RangeControl({ entity, def, onError }: ControlProps): ReactNode {
  const v = fieldValue(entity, def.key) as { min?: number; max?: number } | undefined;
  const focus = useFieldFocus(entity.id, def.key);
  return (
    <NumberPair
      id={`bench-${fieldId(entity.id, def.key)}`}
      entityId={entity.id}
      first
      labels={[`${def.label} from`, `${def.label} to`]}
      values={[v?.min, v?.max]}
      onFocus={focus.onFocus}
      onBlur={focus.onBlurField}
      onCommit={(min, max) => {
        if (min === null && max === null)
          return void commitField(entity.id, def.key, null).then(onError);
        if (min === null || max === null) return onError('Both ends, as numbers');
        const r = checkValue(def, { min, max });
        if (!r.ok) return onError(r.error);
        void commitField(entity.id, def.key, r.value).then(onError);
      }}
    />
  );
}

function ClimateControl({ entity, def, onError }: ControlProps): ReactNode {
  const v = fieldValue(entity, def.key) as
    | { temperature?: { min: number; max: number }; moisture?: { min: number; max: number } }
    | undefined;
  const focus = useFieldFocus(entity.id, def.key);
  const put = (axis: 'temperature' | 'moisture', min: number | null, max: number | null): void => {
    if (min === null || max === null) return onError('Both ends, from 0 to 1');
    const other = axis === 'temperature' ? 'moisture' : 'temperature';
    const next = { [axis]: { min, max }, [other]: v?.[other] ?? { min: 0.4, max: 0.6 } };
    const r = checkValue(def, next);
    if (!r.ok) return onError('From 0 to 1, low end first');
    void commitField(entity.id, def.key, r.value).then(onError);
  };
  return (
    <div className="bench-climate">
      {(['temperature', 'moisture'] as const).map((axis, i) => (
        <div key={axis} className="bench-climate-row">
          <span className="t-2 t-meta bench-climate-axis">{axis}</span>
          <NumberPair
            id={`bench-${fieldId(entity.id, def.key)}`}
            entityId={entity.id}
            first={i === 0}
            labels={[`${axis} from`, `${axis} to`]}
            values={[v?.[axis]?.min, v?.[axis]?.max]}
            onFocus={focus.onFocus}
            onBlur={focus.onBlurField}
            onCommit={(a, b) => put(axis, a, b)}
          />
        </div>
      ))}
    </div>
  );
}

/** An item's route: steps, each with what it needs. */
function StepsControl({ world, entity, def, onError }: ControlProps): ReactNode {
  const raw = fieldValue(entity, def.key);
  const steps: Step[] = Array.isArray(raw) ? (raw as Step[]) : [];
  const focus = useFieldFocus(entity.id, def.key);
  const save = (next: Step[]): void => {
    const r = checkValue(def, next);
    if (!r.ok) return onError(r.error);
    void commitField(entity.id, def.key, next.length === 0 ? null : next).then(onError);
  };
  const items = Object.values(world.entities)
    .filter((t) => t.id !== entity.id)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({
      value: t.id,
      label: t.name,
      hint: t.kind,
      glyph: <StateGlyph state={t.state} tooltip={false} />,
    }));
  const addRef = useRef<HTMLButtonElement>(null);
  return (
    <div className="bench-steps" onFocus={focus.onFocus} onBlur={focus.onBlurField}>
      {steps.map((s, i) => (
        <StepRow
          key={i}
          entityId={entity.id}
          index={i}
          step={s}
          world={world}
          items={items}
          first={i === 0}
          id={`bench-${fieldId(entity.id, def.key)}`}
          onChange={(next) => save(steps.map((x, j) => (j === i ? next : x)))}
          onRemove={() => save(steps.filter((_, j) => j !== i))}
        />
      ))}
      <Button
        ref={addRef}
        size="sm"
        variant="ghost"
        className="bench-add"
        onClick={() => save([...steps, { text: 'New step' }])}
        {...(steps.length === 0 ? { id: `bench-${fieldId(entity.id, def.key)}` } : {})}
      >
        <IconPlus /> Step
      </Button>
    </div>
  );
}

function StepRow({
  entityId,
  index,
  step,
  world,
  items,
  first,
  id,
  onChange,
  onRemove,
}: {
  entityId: string;
  index: number;
  step: Step;
  world: World;
  items: { value: string; label: string; hint: string; glyph: ReactNode }[];
  first: boolean;
  id: string;
  onChange: (s: Step) => void;
  onRemove: () => void;
}): ReactNode {
  const {
    draft: text,
    setDraft: setText,
    dirty,
    theirs,
    choose,
    rebase,
  } = useTypedDraft(step.text, entityId);
  const needs = step.needs ?? [];
  const commit = (force = false): void => {
    // With an outside change waiting, leaving the step decides nothing.
    if (theirs !== null && !force) return;
    if (dirty()) onChange({ ...step, text: text.trim() === '' ? step.text : text.trim() });
  };
  return (
    <div className="bench-step" data-step={index}>
      <span className="bench-step-n num t-3">{index + 1}</span>
      <div className="bench-step-body">
        <div className="bench-row">
          <Input
            aria-label={`Step ${index + 1}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={rebase}
            onBlur={() => commit()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commit();
              }
            }}
            {...(first ? { id } : {})}
          />
          <IconButton
            size="sm"
            label={`Remove step ${index + 1}`}
            icon={<IconClose />}
            onClick={onRemove}
          />
        </div>
        {theirs !== null && (
          <ConflictPrompt
            theirs={theirs}
            onKeepMine={() => {
              choose('mine');
              commit(true);
            }}
            onUseTheirs={() => choose('theirs')}
          />
        )}
        <div className="bench-needs">
          {needs.map((n) => (
            <EntityChip
              key={n}
              world={world}
              id={n}
              onRemove={() => onChange({ ...step, needs: needs.filter((x) => x !== n) })}
            />
          ))}
          <Combobox
            aria-label={`What step ${index + 1} needs`}
            className="bench-needs-pick"
            items={items.filter((it) => !needs.includes(it.value))}
            value={null}
            onChange={(x) => onChange({ ...step, needs: [...needs, x] })}
          />
        </div>
      </div>
    </div>
  );
}

/** An entity as a small chip: its state glyph and name; click to put it on the Bench. */
export function EntityChip({
  world,
  id,
  onRemove,
}: {
  world: World;
  id: string;
  onRemove?: () => void;
}): ReactNode {
  const e = world.entities[id];
  return (
    <span className={cx('bench-chip', !e && 'bench-chip-missing')} data-chip={id}>
      <button
        type="button"
        className="bench-chip-name"
        onClick={() => e && focusEntity(id)}
        disabled={!e}
      >
        {e && <StateGlyph state={e.state} tooltip={false} size={9} />}
        <span>{e?.name ?? id}</span>
      </button>
      {onRemove && (
        <button
          type="button"
          className="bench-chip-x"
          aria-label={`Remove ${e?.name ?? id}`}
          onClick={onRemove}
        >
          <IconClose />
        </button>
      )}
    </span>
  );
}

/** Focuses the field `key` on the Bench (its first control), optionally selecting its text. */
export function focusField(root: HTMLElement | null, key: string, select = false): boolean {
  const field = root?.querySelector<HTMLElement>(`[data-bench-field="${CSS.escape(key)}"]`);
  const el = field?.querySelector<HTMLElement>(FOCUSABLE);
  if (!el) return false;
  el.focus();
  if (select && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) el.select();
  return true;
}

/** Moves focus to the next (+1) or previous (−1) field. */
export function focusSibling(root: HTMLElement | null, dir: 1 | -1): void {
  if (!root) return;
  const fields = [...root.querySelectorAll<HTMLElement>('[data-bench-field]')];
  const cur = fields.findIndex((f) => f.contains(document.activeElement));
  const next = fields[cur < 0 ? 0 : Math.max(0, Math.min(fields.length - 1, cur + dir))];
  next?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
}

/** Keeps a focus request until the field exists, then focuses it once. */
export function useFocusRequest(
  root: RefObject<HTMLElement | null>,
  entityId: string | undefined,
): void {
  const req = useBench((s) => s.focusRequest);
  useEffect(() => {
    if (!req || req.entity !== entityId) return;
    if (focusField(root.current, req.key, req.select)) setBench({ focusRequest: null });
  });
}
