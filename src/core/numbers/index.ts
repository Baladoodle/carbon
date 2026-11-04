/**
 * The numbers engine's public API (W3). Pure: no I/O, no clock, no `eval`.
 * Other packages import from here only. Documented in docs/build-notes/numbers.md §1.
 */
import type { World } from '../model/world';
import type { NumbersAnalysis } from './engine';
import { formatValue, toPlain, type PlainValue } from './values';

export {
  analyzeNumbers,
  compileExpression,
  NumbersEngine,
  typeOfValue,
  type Compiled,
  type DefInfo,
  type EngineOptions,
  type NumbersAnalysis,
} from './engine';
export type { DefResult } from './evaluate';
export { DEFAULT_STEP_LIMIT } from './evaluate';
export { parseProgram, parseExpression } from './parser';
export { printExpr, printDef, printProgram } from './printer';
export type { Program, Def, Expr } from './ast';
export { lineCol, lineStarts, type Diagnostic, type Span, type LineCol } from './span';
export {
  formatValue,
  formatNumber,
  toPlain,
  valueEquals,
  entityRef,
  type Value,
  type PlainValue,
} from './values';
export { NUMBER, BOOL, STRING, entityOf, listOf, formatType, type Type } from './types';
export {
  explicitPlacement,
  bandOrder,
  bandTiers,
  type Placed,
  type PlacementResolver,
} from './placement';
export {
  sampleCurve,
  intentAt,
  intentDeviations,
  initialIntent,
  axisTicks,
  intentPoints,
  storedIntentX,
  deviation,
  niceTicks,
  roundNice,
  DEFAULT_TOLERANCE,
  type CurveSample,
  type Dot,
  type Tick,
  type IntentDeviation,
  type CurveProblem,
  type CurvePart,
} from './curves';
export { propsOf, COLLECTIONS, type Prop } from './props';
export { BUILTINS } from './builtins';
export { KEYWORDS } from './lexer';
export { numbersCommands } from './commands';
export { renameVariableIn } from './rename';

/** A formula as other packages show it: its source, type and value (or error). */
export interface FormulaSummary {
  name: string;
  /** Canonical source, e.g. `taken(raw, def) = raw * k / (k + def)`. */
  text: string;
  type: string;
  /** Constants: the value, readable (e.g. `19.2308`, `Hollows`); functions: undefined. */
  value?: string;
  /** JSON-safe value, for prompts and exports. */
  plain?: PlainValue;
  error?: string;
  /** 1-based line in formulas.carbon. */
  line: number;
}

function lineOf(source: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source.charCodeAt(i) === 10) n++;
  return n;
}

export function summarize(
  analysis: NumbersAnalysis,
  world: World,
  name: string,
): FormulaSummary | undefined {
  const d = analysis.byName.get(name);
  if (!d) return undefined;
  const s: FormulaSummary = {
    name,
    text: d.text,
    type: d.type,
    line: lineOf(analysis.source, d.span.start),
  };
  if (d.result?.ok) {
    s.value = formatValue(d.result.value, { name: (id) => world.entities[id]?.name });
    s.plain = toPlain(d.result.value);
  } else if (d.result) s.error = d.result.error.message;
  return s;
}

/**
 * The formulas relevant to an entity (for AI prompts, W4, and exports, W6):
 * those that read one of its kind's attributes or fields, query its kind, or
 * depend on such a formula; plus everything they depend on. In source order.
 */
export function relevantFormulas(
  analysis: NumbersAnalysis,
  world: World,
  entityId: string,
): FormulaSummary[] {
  const e = world.entities[entityId];
  if (!e) return [];
  const own = new Set<string>([...Object.keys(e.attributes), ...Object.keys(e.fields)]);
  const direct = new Set<string>();
  for (const d of analysis.defs)
    if (
      d.kinds.includes(e.kind) ||
      d.kinds.includes('*') ||
      d.props.some((p) => own.has(p) || own.has(p.replace(/_(min|max)$/, '')))
    )
      direct.add(d.name);
  // Close over dependents (what uses them) and dependencies (what they use).
  const keep = new Set(direct);
  const up = [...direct];
  while (up.length > 0) {
    const n = up.pop() as string;
    for (const m of analysis.byName.get(n)?.dependents ?? [])
      if (!keep.has(m)) {
        keep.add(m);
        up.push(m);
      }
  }
  const down = [...keep];
  while (down.length > 0) {
    const n = down.pop() as string;
    for (const m of analysis.byName.get(n)?.deps ?? [])
      if (!keep.has(m)) {
        keep.add(m);
        down.push(m);
      }
  }
  return analysis.defs
    .filter((d) => keep.has(d.name))
    .map((d) => summarize(analysis, world, d.name) as FormulaSummary);
}

/** Every formula, summarised (for a world digest). */
export function allFormulas(analysis: NumbersAnalysis, world: World): FormulaSummary[] {
  return analysis.defs.map((d) => summarize(analysis, world, d.name) as FormulaSummary);
}

/** Formula errors as plain records (for W6's mechanical checks). */
export interface FormulaError {
  /** Stable for the same problem in the same place: `numbers:<code>:<def>:<line>`. */
  id: string;
  code: string;
  message: string;
  hint?: string;
  def?: string;
  line: number;
  col: number;
  severity: 'error' | 'warning';
}

export function formulaErrors(analysis: NumbersAnalysis): FormulaError[] {
  return analysis.diagnostics.map((d) => {
    let line = 1;
    let last = -1;
    for (let i = 0; i < d.span.start && i < analysis.source.length; i++)
      if (analysis.source.charCodeAt(i) === 10) {
        line++;
        last = i;
      }
    const out: FormulaError = {
      id: `numbers:${d.code}:${d.def ?? ''}:${line}`,
      code: d.code,
      message: d.message,
      line,
      col: d.span.start - last,
      severity: d.severity,
    };
    if (d.hint) out.hint = d.hint;
    if (d.def) out.def = d.def;
    return out;
  });
}
