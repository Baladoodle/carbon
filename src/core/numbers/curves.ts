import type { Curve, CurveAxis, IntentPoint } from '../model/curves';
import { ENTITY_KINDS, type EntityKind } from '../model/kinds';
import type { World } from '../model/world';
import { compileExpression, type NumbersAnalysis } from './engine';
import { bandOrder } from './placement';
import type { Diagnostic } from './span';
import { entityOf, NUMBER, type Type } from './types';
import { entityRef, isEntity, isList, type Value } from './values';

/**
 * Sampling a curve for the plot, and comparing entities with its intent.
 *
 * The x axis is numeric throughout: on the band axis, x is the band's index
 * from the lowest band (0, 1, 2 …) and the formula's `x` is that band; on the
 * tier axis, x is the tier; on an attribute axis, x is the attribute's value.
 * Intent points on the band axis are stored by band id, so they follow their
 * band when bands are added or reordered.
 */
export const DEFAULT_TOLERANCE = 0.25;
export const ATTRIBUTE_SAMPLES = 64;

export interface Tick {
  x: number;
  label: string;
  /** The band, on the band axis. */
  band?: string;
}

export interface Dot {
  entity: string;
  name: string;
  x: number;
  y: number;
  /** The intent at x, when there is an intent curve. */
  intent?: number;
  /** (y − intent) / |intent|. */
  deviation?: number;
  off?: boolean;
}

export type CurvePart = 'y' | 'query' | 'value';

export interface CurveProblem {
  part: CurvePart;
  diagnostic: Diagnostic;
}

export interface CurveSample {
  axis: CurveAxis['axis'];
  /** The x range (inclusive). */
  domain: [number, number];
  ticks: Tick[];
  /** The formula at each sample; `y` is null where it has no value. */
  line: { x: number; y: number | null }[];
  dots: Dot[];
  /** Entities the query found that have no x (unplaced, or the attribute unset). */
  missing: number;
  /** Intent control points, as numbers on the x axis, sorted by x. */
  intent: { x: number; y: number }[];
  /** Static problems per part, and the first runtime error of each part. */
  problems: CurveProblem[];
  tolerance: number;
}

/** Piecewise-linear intent at x, flat beyond the first and last points. */
export function intentAt(points: { x: number; y: number }[], x: number): number | null {
  if (points.length === 0) return null;
  const first = points[0] as { x: number; y: number };
  const last = points[points.length - 1] as { x: number; y: number };
  if (x <= first.x) return first.y;
  if (x >= last.x) return last.y;
  for (let i = 1; i < points.length; i++) {
    const b = points[i] as { x: number; y: number };
    const a = points[i - 1] as { x: number; y: number };
    if (x <= b.x) return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
  }
  return last.y;
}

/** How far a value is off its intent, relative to the intent (absolute when the intent is 0). */
export function deviation(value: number, intent: number): number {
  return intent === 0 ? value : (value - intent) / Math.abs(intent);
}

export function xType(axis: CurveAxis): Type {
  return axis.axis === 'band' ? entityOf('band') : NUMBER;
}

/** Ticks and the domain of a curve's x axis in a world. */
export function axisTicks(
  world: World,
  axis: CurveAxis,
): { ticks: Tick[]; domain: [number, number] } {
  if (axis.axis === 'attribute') {
    const span = axis.max - axis.min;
    const ticks = niceTicks(axis.min, axis.max, 6).map((x) => ({ x, label: trimNum(x) }));
    return { ticks, domain: span > 0 ? [axis.min, axis.max] : [axis.min, axis.min + 1] };
  }
  const bands = bandOrder(world);
  if (axis.axis === 'band') {
    const ticks = bands.map((b, i) => ({ x: i, label: b.name, band: b.id }));
    return { ticks, domain: [0, Math.max(1, bands.length - 1)] };
  }
  const zero = bands.findIndex((b) => {
    const t = b.fields.y_top;
    return t === '+inf' || (typeof t === 'number' && t > 0);
  });
  const z = zero < 0 ? bands.length : zero;
  const ticks = bands.map((_, i) => ({ x: i - z, label: String(i - z).replace('-', '−') }));
  const lo = ticks[0]?.x ?? 0;
  const hi = ticks[ticks.length - 1]?.x ?? 1;
  return { ticks, domain: [lo, hi > lo ? hi : lo + 1] };
}

/** Intent points as numbers on the x axis (band ids → indices; unknown bands dropped), sorted. */
export function intentPoints(
  points: IntentPoint[] | undefined,
  ticks: Tick[],
  axis: CurveAxis,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const p of points ?? []) {
    if (axis.axis === 'band') {
      const t = ticks.find((k) => k.band === p.x);
      if (t) out.push({ x: t.x, y: p.y });
    } else if (typeof p.x === 'number') out.push({ x: p.x, y: p.y });
  }
  return out.sort((a, b) => a.x - b.x);
}

/** Back from numeric x to a stored intent point (band index → band id). */
export function storedIntentX(x: number, ticks: Tick[], axis: CurveAxis): number | string {
  if (axis.axis !== 'band') return x;
  const t = ticks.find((k) => k.x === Math.round(x));
  return t?.band ?? x;
}

/** Evaluates a curve against an analysis: the line, the dots, the intent and any problems. */
export function sampleCurve(analysis: NumbersAnalysis, world: World, curve: Curve): CurveSample {
  const axis = curve.over;
  const { ticks, domain } = axisTicks(world, axis);
  const problems: CurveProblem[] = [];
  const firstRuntime = new Set<CurvePart>();
  const runtime = (part: CurvePart, d: Diagnostic): void => {
    if (firstRuntime.has(part)) return;
    firstRuntime.add(part);
    problems.push({ part, diagnostic: d });
  };
  const xt = xType(axis);
  const y = compileExpression(analysis, curve.y, { x: xt });
  for (const d of y.diagnostics) problems.push({ part: 'y', diagnostic: d });
  if (y.ok && y.type !== 'number')
    problems.push({
      part: 'y',
      diagnostic: {
        severity: 'error',
        stage: 'check',
        code: 'curve.type',
        message: `The curve must be a number, not ${y.type}`,
        span: { start: 0, end: curve.y.length },
      },
    });
  const yOk = y.ok && y.type === 'number';
  const xValue = (x: number): Value | null => {
    if (axis.axis !== 'band') return x;
    const t = ticks.find((k) => k.x === x);
    return t?.band ? entityRef(t.band) : null;
  };
  const yAt = (x: number): number | null => {
    if (!yOk) return null;
    const xv = xValue(x);
    if (xv === null) return null;
    const r = y.run({ x: xv });
    if (!r.ok) {
      runtime('y', r.error);
      return null;
    }
    return typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
  };

  const xs: number[] =
    axis.axis === 'attribute'
      ? Array.from(
          { length: ATTRIBUTE_SAMPLES + 1 },
          (_, i) => domain[0] + ((domain[1] - domain[0]) * i) / ATTRIBUTE_SAMPLES,
        )
      : ticks.map((t) => t.x);
  const line = xs.map((x) => ({ x, y: yAt(x) }));

  const intent = intentPoints(curve.intent, ticks, axis);
  const tolerance = curve.tolerance ?? DEFAULT_TOLERANCE;
  const dots: Dot[] = [];
  let missing = 0;
  if (curve.dots) {
    const q = compileExpression(analysis, curve.dots.query);
    for (const d of q.diagnostics) problems.push({ part: 'query', diagnostic: d });
    if (q.ok && !q.type.startsWith('list of')) {
      problems.push({
        part: 'query',
        diagnostic: {
          severity: 'error',
          stage: 'check',
          code: 'curve.query',
          message: `The dots must be a list of entities, not ${q.type}`,
          span: { start: 0, end: curve.dots.query.length },
        },
      });
    }
    const kindName = q.type.startsWith('list of ') ? q.type.slice(8) : 'entity';
    const elType = entityOf(isKind(kindName) ? kindName : null);
    const v =
      curve.dots.value !== undefined && curve.dots.value.trim() !== ''
        ? compileExpression(analysis, curve.dots.value, { x: xt }, elType)
        : null;
    if (v) for (const d of v.diagnostics) problems.push({ part: 'value', diagnostic: d });
    if (v?.ok && v.type !== 'number')
      problems.push({
        part: 'value',
        diagnostic: {
          severity: 'error',
          stage: 'check',
          code: 'curve.value',
          message: `A dot's value must be a number, not ${v.type}`,
          span: { start: 0, end: (curve.dots.value ?? '').length },
        },
      });
    const listed = q.ok ? q.run() : null;
    if (listed && !listed.ok) runtime('query', listed.error);
    const items = listed?.ok && isList(listed.value) ? listed.value.items : [];
    for (const it of items) {
      if (!isEntity(it) || it.id === null) continue;
      const e = world.entities[it.id];
      if (!e) continue;
      let x: number | null;
      if (axis.axis === 'attribute') {
        const a = compileExpression(analysis, `it.${axis.key}`, {}, entityOf(e.kind));
        const r = a.ok ? a.run({}, it) : null;
        x = r?.ok && typeof r.value === 'number' ? r.value : null;
      } else {
        const p = analysis.internals.evalWorld.placement.get(e.id);
        if (axis.axis === 'band')
          x = p?.band ? (ticks.find((t) => t.band === p.band)?.x ?? null) : null;
        else x = p?.tier ?? null;
      }
      if (x === null) {
        missing++;
        continue;
      }
      let yv: number | null = null;
      if (v) {
        if (v.ok && v.type === 'number') {
          const xv = xValue(x) ?? x;
          const r = v.run({ x: xv }, it);
          if (r.ok && typeof r.value === 'number') yv = r.value;
          else if (!r.ok) runtime('value', r.error);
        }
      } else yv = yAt(x);
      if (yv === null || !Number.isFinite(yv)) {
        missing++;
        continue;
      }
      const dot: Dot = { entity: e.id, name: e.name, x, y: yv };
      const i = intentAt(intent, x);
      if (i !== null) {
        dot.intent = i;
        dot.deviation = deviation(yv, i);
        dot.off = Math.abs(dot.deviation) > tolerance;
      }
      dots.push(dot);
    }
  }
  return { axis: axis.axis, domain, ticks, line, dots, missing, intent, problems, tolerance };
}

const isKind = (s: string): s is EntityKind => (ENTITY_KINDS as readonly string[]).includes(s);

/** Intent points that start on the curve itself (for "add an intent curve"). */
export function initialIntent(sample: CurveSample, axis: CurveAxis, count = 5): IntentPoint[] {
  const xs =
    axis.axis === 'attribute'
      ? Array.from(
          { length: count },
          (_, i) => sample.domain[0] + ((sample.domain[1] - sample.domain[0]) * i) / (count - 1),
        )
      : sample.ticks.map((t) => t.x);
  const known = sample.line.filter((p): p is { x: number; y: number } => p.y !== null);
  const at = (x: number): number => {
    if (known.length === 0) return 0;
    let best = known[0] as { x: number; y: number };
    for (const p of known) if (Math.abs(p.x - x) < Math.abs(best.x - x)) best = p;
    return best.y;
  };
  return xs.map((x) => ({ x: storedIntentX(x, sample.ticks, axis), y: roundNice(at(x)) }));
}

/** An entity that is far off a curve's intent (for the mechanical checks, W6). */
export interface IntentDeviation {
  curve: string;
  entity: string;
  value: number;
  intent: number;
  /** Relative: (value − intent) / |intent|. */
  deviation: number;
  tolerance: number;
}

/** Every dot, on every curve with an intent, that is further off than the curve's tolerance. */
export function intentDeviations(analysis: NumbersAnalysis, world: World): IntentDeviation[] {
  const out: IntentDeviation[] = [];
  for (const c of world.numbers.curves ?? []) {
    if (!c.intent || c.intent.length === 0 || !c.dots) continue;
    const s = sampleCurve(analysis, world, c);
    for (const d of s.dots)
      if (d.off && d.intent !== undefined && d.deviation !== undefined)
        out.push({
          curve: c.id,
          entity: d.entity,
          value: d.y,
          intent: d.intent,
          deviation: d.deviation,
          tolerance: s.tolerance,
        });
  }
  return out;
}

/** About `count` round tick values covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count: number): number[] {
  if (!(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step)
    out.push(Number(v.toPrecision(12)));
  return out;
}

/** Rounds to 3 significant digits (for intent points dragged by hand). */
export function roundNice(v: number): number {
  if (v === 0 || !Number.isFinite(v)) return 0;
  return Number(v.toPrecision(3));
}

const trimNum = (x: number): string => String(Number(x.toPrecision(6))).replace('-', '−');

/** An edit of an intent curve's control points (numeric x, as on the plot). */
export type IntentEdit =
  | { type: 'add'; x: number; y: number }
  | { type: 'move'; index: number; x?: number; y?: number }
  | { type: 'remove'; index: number };

/**
 * Applies an edit to intent points (numeric x, as `CurveSample.intent`). The
 * result is sorted by x with no two points at the same x, every x inside the
 * domain, and, on the band and tier axes, every x on a tick:
 *
 *  - add: snapped to the nearest tick (bands, tiers) or clamped to the range
 *    (attributes); a point already at that x takes the new y instead
 *  - move: y is free; x snaps or clamps the same way, and a point never passes
 *    or lands on a neighbour (such an x move is ignored, the y move kept)
 *  - remove: the point goes; removing the last one leaves no intent
 */
export function editIntent(
  points: readonly { x: number; y: number }[],
  edit: IntentEdit,
  sample: Pick<CurveSample, 'axis' | 'domain' | 'ticks'>,
): { x: number; y: number }[] {
  const sorted = [...points].sort((a, b) => a.x - b.x).map((p) => ({ ...p }));
  const categorical = sample.axis !== 'attribute';
  const place = (x: number): number | null => {
    if (!Number.isFinite(x)) return null;
    if (!categorical) return Math.min(sample.domain[1], Math.max(sample.domain[0], x));
    let best: number | null = null;
    for (const t of sample.ticks)
      if (best === null || Math.abs(t.x - x) < Math.abs(best - x)) best = t.x;
    return best;
  };
  const okY = (y: number | undefined): y is number => y !== undefined && Number.isFinite(y);
  switch (edit.type) {
    case 'add': {
      const x = place(edit.x);
      if (x === null || !okY(edit.y)) return sorted;
      const at = sorted.find((p) => p.x === x);
      if (at) at.y = edit.y;
      else sorted.push({ x, y: edit.y });
      return sorted.sort((a, b) => a.x - b.x);
    }
    case 'remove':
      return sorted.filter((_, i) => i !== edit.index);
    case 'move': {
      const p = sorted[edit.index];
      if (!p) return sorted;
      if (okY(edit.y)) p.y = edit.y;
      if (edit.x !== undefined) {
        const x = place(edit.x);
        const lo = sorted[edit.index - 1]?.x ?? -Infinity;
        const hi = sorted[edit.index + 1]?.x ?? Infinity;
        if (x !== null && x > lo && x < hi) p.x = x;
      }
      return sorted;
    }
  }
}

/**
 * Where a new point goes when it's added from the keyboard next to point
 * `index`: halfway to the next point (or the domain's end), else halfway to
 * the previous one; on bands and tiers, the nearest free tick to the right,
 * else to the left. `null` when there is no room.
 */
export function nextIntentX(
  points: readonly { x: number; y: number }[],
  index: number,
  sample: Pick<CurveSample, 'axis' | 'domain' | 'ticks'>,
): number | null {
  const sorted = [...points].sort((a, b) => a.x - b.x);
  const p = sorted[index];
  if (!p) return null;
  const taken = new Set(sorted.map((q) => q.x));
  if (sample.axis !== 'attribute') {
    const xs = sample.ticks.map((t) => t.x).filter((x) => !taken.has(x));
    return xs.find((x) => x > p.x) ?? [...xs].reverse().find((x) => x < p.x) ?? null;
  }
  const next = sorted[index + 1]?.x ?? sample.domain[1];
  const prev = sorted[index - 1]?.x ?? sample.domain[0];
  const right = (p.x + next) / 2;
  if (right > p.x && right < next && !taken.has(right)) return right;
  const left = (prev + p.x) / 2;
  if (left < p.x && left > prev && !taken.has(left)) return left;
  return null;
}
