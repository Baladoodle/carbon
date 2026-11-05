import { useMemo, useRef, useState, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import type { Curve, CurveAxis } from '@core/model/curves';
import { ENTITY_KINDS, type EntityState } from '@core/model/kinds';
import { schemaOf, type World } from '@core/model/world';
import {
  editIntent,
  initialIntent,
  intentAt,
  nextIntentX,
  sampleCurve,
  storedIntentX,
  type CurvePart,
  type CurveSample,
  type NumbersAnalysis,
} from '@core/numbers';
import { useActions } from '../../actions';
import { flash } from '../../state/ui';
import { dispatch } from '../../state/world';
import {
  cx,
  IconButton,
  IconClose,
  IconIntent,
  IconPlus,
  Input,
  Empty,
  Kbd,
  Select,
} from '../../ui';
import { CurvePlot } from './CurvePlot';

const uniqueId = (curves: Curve[]): string => {
  for (let i = 1; ; i++) if (!curves.some((c) => c.id === `curve-${i}`)) return `curve-${i}`;
};

/** A first curve worth looking at: the first one-parameter function, over bands if it takes a band. */
export function newCurve(analysis: NumbersAnalysis, curves: Curve[]): Curve {
  const f = analysis.defs.find((d) => d.kind === 'func' && d.params.length === 1 && !d.blocked);
  const over: CurveAxis = f?.type.startsWith('(band)') ? { axis: 'band' } : { axis: 'tier' };
  return { id: uniqueId(curves), y: f ? `${f.name}(x)` : 'x', over };
}

const axisValue = (o: CurveAxis): string =>
  o.axis === 'attribute' ? `attr:${o.kind}.${o.key}` : o.axis;

/** Stores intent points given in numeric x (as on the plot); none removes the intent. */
function setIntent(curve: Curve, sample: CurveSample, points: { x: number; y: number }[]): void {
  void dispatch(
    cmd('numbers.setIntent', {
      id: curve.id,
      points:
        points.length === 0
          ? null
          : points.map((p) => ({ x: storedIntentX(p.x, sample.ticks, curve.over), y: p.y })),
    }),
  );
}

async function put(curve: Curve): Promise<boolean> {
  const r = await dispatch(cmd('numbers.putCurve', { curve }));
  if (!r.ok) flash(r.error.message, 'error');
  return r.ok;
}

/** A text field committed on enter or blur (escape restores it). */
function ExprInput({
  value,
  onCommit,
  label,
  placeholder,
  error,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  placeholder?: string;
  error?: string | undefined;
  className?: string;
}): ReactNode {
  const [text, setText] = useState(value);
  // Follow the stored value when it changes (undo, another edit).
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
  }
  return (
    <Input
      mono
      aria-label={label}
      className={className}
      value={text}
      placeholder={placeholder}
      invalid={!!error}
      title={error}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          setText(value);
          e.currentTarget.blur();
        }
      }}
      onBlur={() => {
        if (text !== value) onCommit(text);
      }}
    />
  );
}

function CurveCard({
  curve,
  world,
  analysis,
  onHandleFocus,
}: {
  curve: Curve;
  world: World;
  analysis: NumbersAnalysis;
  onHandleFocus: (index: number) => void;
}): ReactNode {
  const sample = useMemo(() => sampleCurve(analysis, world, curve), [analysis, world, curve]);
  const schema = schemaOf(world);
  const problem = (part: CurvePart): string | undefined => {
    const p = sample.problems.find((x) => x.part === part && x.diagnostic.severity === 'error');
    return p
      ? `${p.diagnostic.message}${p.diagnostic.hint ? `. ${p.diagnostic.hint}` : ''}`
      : undefined;
  };
  const states: Record<string, EntityState> = {};
  for (const d of sample.dots) {
    const e = world.entities[d.entity];
    if (e) states[d.entity] = e.state;
  }
  const axisOptions = [
    { value: 'band', label: 'Bands' },
    { value: 'tier', label: 'Tiers' },
    ...ENTITY_KINDS.flatMap((k) =>
      schema.kinds[k].attributes.map((a) => ({
        value: `attr:${k}.${a.key}`,
        label: `${k}.${a.key}`,
      })),
    ),
  ];
  const setAxis = (v: string): void => {
    if (v === 'band' || v === 'tier') {
      if (curve.over.axis === v) return;
      const { intent: _drop, ...rest } = curve;
      void put({ ...rest, over: { axis: v } });
      return;
    }
    const [kind, key] = v.slice(5).split('.') as [string, string];
    const def = schema.kinds[kind as (typeof ENTITY_KINDS)[number]].attributes.find(
      (a) => a.key === key,
    );
    const values = Object.values(world.entities)
      .filter((e) => e.kind === kind && Object.prototype.hasOwnProperty.call(e.attributes, key))
      .map((e) => e.attributes[key] as number);
    const min = def?.min ?? Math.min(0, ...values);
    const max = def?.max ?? Math.max(min + 1, ...values.map((x) => x * 2), 10);
    const { intent: _drop, ...rest } = curve;
    void put({
      ...rest,
      over: { axis: 'attribute', kind: kind as (typeof ENTITY_KINDS)[number], key, min, max },
    });
  };
  const setDots = (query: string, value: string | undefined): void => {
    const { dots: _drop, ...rest } = curve;
    const q = query.trim();
    if (q === '') void put(rest);
    else
      void put({
        ...rest,
        dots:
          value !== undefined && value.trim() !== ''
            ? { query: q, value: value.trim() }
            : { query: q },
      });
  };
  const toggleIntent = (): void => {
    if (curve.intent) void dispatch(cmd('numbers.setIntent', { id: curve.id, points: null }));
    else
      void dispatch(
        cmd('numbers.setIntent', { id: curve.id, points: initialIntent(sample, curve.over) }),
      );
  };
  const range = (which: 'min' | 'max', text: string): void => {
    if (curve.over.axis !== 'attribute') return;
    const n = Number(text);
    if (!Number.isFinite(n) || text.trim() === '') return flash('A number', 'error');
    void put({ ...curve, over: { ...curve.over, [which]: n } });
  };
  const yErr = problem('y');
  return (
    <article className="numbers-curve" data-curve={curve.id} data-testid="numbers-curve">
      <div className="numbers-curve-head">
        <span className="mono t-3">y =</span>
        <ExprInput
          value={curve.y}
          label="Curve formula"
          error={yErr}
          className="numbers-curve-y"
          onCommit={(y) => void put({ ...curve, y })}
        />
        <Select
          aria-label="Over"
          value={axisValue(curve.over)}
          onValueChange={setAxis}
          options={axisOptions}
          className="numbers-curve-axis"
        />
        {curve.over.axis === 'attribute' && (
          <>
            <ExprInput
              value={String(curve.over.min)}
              label="From"
              className="numbers-curve-range"
              onCommit={(t) => range('min', t)}
            />
            <span className="t-3">–</span>
            <ExprInput
              value={String(curve.over.max)}
              label="To"
              className="numbers-curve-range"
              onCommit={(t) => range('max', t)}
            />
          </>
        )}
        <IconButton
          size="sm"
          label={curve.intent ? 'Remove intent curve' : 'Add intent curve'}
          icon={<IconIntent />}
          active={!!curve.intent}
          onClick={toggleIntent}
          data-testid="curve-intent-toggle"
        />
        <IconButton
          size="sm"
          label="Remove curve"
          icon={<IconClose />}
          onClick={() => void dispatch(cmd('numbers.removeCurve', { id: curve.id }))}
        />
      </div>
      <div className="numbers-curve-dots">
        <span className="t-3">dots</span>
        <ExprInput
          value={curve.dots?.query ?? ''}
          label="Dots"
          placeholder='items where subkind == "armor"'
          error={problem('query')}
          className="numbers-curve-query"
          onCommit={(q) => setDots(q, curve.dots?.value)}
        />
        <ExprInput
          value={curve.dots?.value ?? ''}
          label="Dot value"
          placeholder=".defense"
          error={problem('value')}
          className="numbers-curve-value"
          onCommit={(v) => setDots(curve.dots?.query ?? '', v)}
        />
        {sample.missing > 0 && (
          <span
            className="t-3 num numbers-curve-missing"
            title="Not on the plot: no place yet, or no value"
          >
            +{sample.missing}
          </span>
        )}
      </div>
      {(yErr ?? problem('query') ?? problem('value')) && (
        <div className="ui-field-error numbers-curve-error" role="alert">
          {yErr ?? problem('query') ?? problem('value')}
        </div>
      )}
      <CurvePlot
        sample={sample}
        states={states}
        label={curve.y}
        onIntent={(points) => setIntent(curve, sample, points)}
        onHandleFocus={onHandleFocus}
      />
    </article>
  );
}

export function Curves({
  world,
  analysis,
}: {
  world: World;
  analysis: NumbersAnalysis;
}): ReactNode {
  const curves = world.numbers.curves ?? [];
  const add = (): void => void put(newCurve(analysis, curves));
  // The intent point that last had keyboard focus: the palette's intent
  // actions work on it (on the plot, `+` and delete do the same).
  const last = useRef<{ id: string; index: number } | null>(null);
  const target = (): { curve: Curve; sample: CurveSample; index: number } | null => {
    const l = last.current;
    const curve = l ? curves.find((c) => c.id === l.id) : undefined;
    if (!l || !curve) return null;
    const sample = sampleCurve(analysis, world, curve);
    return l.index < sample.intent.length ? { curve, sample, index: l.index } : null;
  };
  useActions([
    { id: 'numbers.newCurve', label: 'New curve', group: 'Numbers', keys: ['c'], run: add },
    {
      id: 'numbers.addIntentPoint',
      label: 'Add an intent point',
      group: 'Numbers',
      enabled: () => {
        const t = target();
        return !!t && nextIntentX(t.sample.intent, t.index, t.sample) !== null;
      },
      run: () => {
        const t = target();
        if (!t) return;
        const x = nextIntentX(t.sample.intent, t.index, t.sample);
        if (x === null) return;
        const y = intentAt(t.sample.intent, x) ?? 0;
        setIntent(t.curve, t.sample, editIntent(t.sample.intent, { type: 'add', x, y }, t.sample));
      },
    },
    {
      id: 'numbers.removeIntentPoint',
      label: 'Remove an intent point',
      group: 'Numbers',
      enabled: () => target() !== null,
      run: () => {
        const t = target();
        if (!t) return;
        setIntent(
          t.curve,
          t.sample,
          editIntent(t.sample.intent, { type: 'remove', index: t.index }, t.sample),
        );
        last.current = null;
      },
    },
  ]);
  return (
    <section className={cx('numbers-curves')} aria-label="Curves" data-testid="numbers-curves">
      {curves.map((c) => (
        <CurveCard
          key={c.id}
          curve={c}
          world={world}
          analysis={analysis}
          onHandleFocus={(index) => (last.current = { id: c.id, index })}
        />
      ))}
      {curves.length === 0 ? (
        <Empty className="numbers-empty">
          No curves yet. <Kbd>c</Kbd> to add one.
        </Empty>
      ) : (
        <IconButton
          size="sm"
          label="New curve"
          keys="c"
          icon={<IconPlus />}
          onClick={add}
          data-testid="numbers-add-curve"
        />
      )}
    </section>
  );
}
