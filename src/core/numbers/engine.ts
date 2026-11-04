import { schemaOf, type World } from '../model/world';
import { deepEqual } from '../util/json';
import { defsOf, type Def, type Program } from './ast';
import { Checker, varType, type CheckedDef, type DefUses } from './check';
import { DEFAULT_STEP_LIMIT, Evaluator, type DefResult, type EvalWorld } from './evaluate';
import { buildGraph, type Graph } from './graph';
import { parseExpression, parseProgram } from './parser';
import { explicitPlacement, type Placed, type PlacementResolver } from './placement';
import { printDef } from './printer';
import { diag, type Diagnostic, type Span } from './span';
import {
  formatScheme,
  formatType,
  NUMBER,
  STRING,
  BOOL,
  entityOf,
  listOf,
  type Type,
} from './types';
import { isEntity, valueEquals, type Value } from './values';

/**
 * The numbers engine: parse → resolve and type-check → dependency graph →
 * evaluate, for a world's `formulas.carbon` against its variables, schema and
 * entities.
 *
 * `analyzeNumbers(world)` does everything from scratch. A `NumbersEngine`
 * keeps the last analysis and, on `update(world)`, re-parses and re-checks
 * only when the source, schema or variable types changed, and re-evaluates
 * only the definitions whose text changed or that read something that
 * changed (a variable, an entity, a collection, a placement, or a definition
 * whose value changed). Both give identical results; a property test holds
 * them to it.
 */
export interface DefInfo {
  name: string;
  kind: 'const' | 'func';
  span: Span;
  nameSpan: Span;
  params: string[];
  /** Canonical source (pretty-printed). */
  text: string;
  /** `number`, or `(number, number) → number` for a function. */
  type: string;
  /** Definitions it references, in first-use order. */
  deps: string[];
  /** Variables it references. */
  variables: string[];
  /** Definitions that reference it. */
  dependents: string[];
  /** Entity properties and collections it reads (for relevance, e.g. AI prompts). */
  props: string[];
  kinds: string[];
  /** Whether it, or something it depends on, has a static error or is on a cycle. */
  blocked: boolean;
  /** Constants: the value, or the error (its own, or that of a dependency). */
  result?: DefResult;
}

export interface NumbersAnalysis {
  source: string;
  program: Program;
  /** Every problem with a span: syntax, names, types, cycles and evaluation. Sorted by position. */
  diagnostics: Diagnostic[];
  /** Definitions in source order (duplicates and reserved names left out). */
  defs: DefInfo[];
  byName: Map<string, DefInfo>;
  /** Evaluation order (dependencies first). */
  order: string[];
  /** Constants evaluated in this update (the rest were reused). */
  evaluated: string[];
  /** The value of a constant, if it has one. */
  value(name: string): Value | undefined;
  /** For `compileExpression` and curves. */
  readonly internals: Internals;
}

export interface Internals {
  checker: Checker;
  graph: Graph;
  evalWorld: EvalWorld;
  results: Map<string, DefResult>;
  stepLimit: number;
}

export interface EngineOptions {
  /** Defaults to explicit bands only (W2's resolver can be passed in). */
  placement?: PlacementResolver;
  stepLimit?: number;
}

interface Cached {
  key: string;
  result: DefResult;
  reads: Set<string>;
}

interface State {
  world: World;
  source: string;
  parsed: { program: Program; diagnostics: Diagnostic[] };
  checkKey: string;
  checker: Checker;
  graph: Graph;
  placement: Map<string, Placed>;
  cache: Map<string, Cached>;
  funcKeys: Map<string, string>;
  analysis: NumbersAnalysis;
}

const varSignature = (vars: World['numbers']['variables']): string =>
  Object.keys(vars)
    .sort()
    .map((k) => `${k}:${typeof vars[k]}`)
    .join(',');

const sameResult = (a: DefResult, b: DefResult): boolean =>
  a.ok && b.ok
    ? valueEquals(a.value, b.value)
    : !a.ok &&
      !b.ok &&
      a.error.code === b.error.code &&
      a.error.message === b.error.message &&
      a.error.span.start === b.error.span.start &&
      a.error.span.end === b.error.span.end;

const byPosition = (a: Diagnostic, b: Diagnostic): number =>
  a.span.start - b.span.start ||
  a.span.end - b.span.end ||
  (a.message < b.message ? -1 : a.message > b.message ? 1 : 0);

export class NumbersEngine {
  private state: State | undefined;
  private readonly resolver: PlacementResolver;
  private readonly stepLimit: number;
  /** Total constants evaluated over the engine's life (for tests). */
  evaluations = 0;

  constructor(opts: EngineOptions = {}) {
    this.resolver = opts.placement ?? explicitPlacement;
    this.stepLimit = opts.stepLimit ?? DEFAULT_STEP_LIMIT;
  }

  get analysis(): NumbersAnalysis | undefined {
    return this.state?.analysis;
  }

  update(world: World): NumbersAnalysis {
    const prev = this.state;
    if (prev && prev.world === world) return prev.analysis;
    const source = world.numbers.formulas;
    const schema = schemaOf(world);
    const parsed = prev && prev.source === source ? prev.parsed : parseProgram(source);
    const schemaSame = prev !== undefined && prev.world.schema === world.schema;
    const checkKey = varSignature(world.numbers.variables);
    let checker: Checker;
    let graph: Graph;
    if (prev && prev.parsed === parsed && schemaSame && prev.checkKey === checkKey) {
      checker = prev.checker;
      graph = prev.graph;
    } else {
      checker = new Checker({ schema, variables: world.numbers.variables });
      checker.checkProgram(parsed.program);
      const names = [...checker.defs.keys()];
      graph = buildGraph(names, checker.edges, (from, to) =>
        checker.checked.get(from)?.refSpans.get(to),
      );
    }
    const placement = this.resolver(world);

    // What changed since the last update, as read tokens.
    const full = !prev || !schemaSame;
    const changed = new Set<string>();
    if (prev && !full) {
      const pv = prev.world.numbers.variables;
      const nv = world.numbers.variables;
      for (const k of new Set([...Object.keys(pv), ...Object.keys(nv)]))
        if (pv[k] !== nv[k]) changed.add(`var:${k}`);
      if (prev.world.entities !== world.entities)
        for (const id of new Set([
          ...Object.keys(prev.world.entities),
          ...Object.keys(world.entities),
        ])) {
          const a = prev.world.entities[id];
          const b = world.entities[id];
          if (a === b || deepEqual(a, b)) continue;
          changed.add(`entity:${id}`);
          if (a) changed.add(`kind:${a.kind}`);
          if (b) changed.add(`kind:${b.kind}`);
        }
      for (const id of new Set([...prev.placement.keys(), ...placement.keys()])) {
        const a = prev.placement.get(id);
        const b = placement.get(id);
        if (a?.band !== b?.band || a?.tier !== b?.tier) changed.add(`placement:${id}`);
      }
    }

    const evalWorld: EvalWorld = { world, schema, placement };
    const results = new Map<string, DefResult>();
    const cache = new Map<string, Cached>();
    const funcKeys = new Map<string, string>();
    const evaluated: string[] = [];
    const evalDiagnostics: Diagnostic[] = [];

    // Blocked: a static error in it or in anything it depends on, or a cycle.
    const blocked = new Map<string, { by: string; at: Span } | 'self'>();
    for (const name of graph.order) {
      const c = checker.checked.get(name);
      if (!c || c.hasError || graph.cyclic.has(name)) {
        blocked.set(name, 'self');
        continue;
      }
      for (const dep of c.uses.defs)
        if (blocked.has(dep)) {
          blocked.set(name, { by: dep, at: c.refSpans.get(dep) ?? c.def.nameSpan });
          break;
        }
    }

    for (const name of graph.order) {
      const c = checker.checked.get(name);
      if (!c) continue;
      const key = `${printDef(c.def)} :: ${formatScheme(c.scheme)} :: ${blocked.has(name) ? 'blocked' : 'ok'}`;
      if (c.def.type === 'func') {
        funcKeys.set(name, key);
        if (prev?.funcKeys.get(name) !== key) changed.add(`def:${name}`);
        continue;
      }
      const b = blocked.get(name);
      if (b) {
        const result: DefResult = {
          ok: false,
          error:
            b === 'self'
              ? diag('eval', 'eval.static', `${name} has an error`, c.def.nameSpan, { def: name })
              : diag('eval', 'eval.dependency', `${b.by} has an error`, b.at, {
                  def: name,
                  hint: `Fix ${b.by} first`,
                }),
        };
        results.set(name, result);
        const old = prev?.cache.get(name);
        if (!old || !sameResult(old.result, result)) changed.add(`def:${name}`);
        continue;
      }
      const old = prev?.cache.get(name);
      const reuse =
        !full &&
        old !== undefined &&
        old.key === key &&
        ![...old.reads].some((t) => changed.has(t));
      if (reuse) {
        results.set(name, old.result);
        cache.set(name, old);
        if (!old.result.ok && old.result.error.code !== 'eval.dependency')
          evalDiagnostics.push(old.result.error);
        continue;
      }
      const ev = new Evaluator(evalWorld, checker, (n) => results.get(n), name, this.stepLimit);
      const result = ev.run(c.def.body);
      this.evaluations++;
      evaluated.push(name);
      results.set(name, result);
      cache.set(name, { key, result, reads: ev.reads });
      if (!result.ok && result.error.code !== 'eval.dependency') evalDiagnostics.push(result.error);
      if (!old || !sameResult(old.result, result)) changed.add(`def:${name}`);
    }

    const analysis = buildAnalysis(
      source,
      parsed,
      checker,
      graph,
      results,
      blocked,
      evalDiagnostics,
      evaluated,
      {
        checker,
        graph,
        evalWorld,
        results,
        stepLimit: this.stepLimit,
      },
    );
    this.state = {
      world,
      source,
      parsed,
      checkKey,
      checker,
      graph,
      placement,
      cache,
      funcKeys,
      analysis,
    };
    return analysis;
  }
}

function buildAnalysis(
  source: string,
  parsed: { program: Program; diagnostics: Diagnostic[] },
  checker: Checker,
  graph: Graph,
  results: Map<string, DefResult>,
  blocked: Map<string, unknown>,
  evalDiagnostics: Diagnostic[],
  evaluated: string[],
  internals: Internals,
): NumbersAnalysis {
  const defs: DefInfo[] = [];
  const byName = new Map<string, DefInfo>();
  for (const d of defsOf(parsed.program)) {
    const c = checker.checked.get(d.name);
    if (!c || c.def !== d) continue;
    const info = defInfo(d, c, graph, blocked.has(d.name), results.get(d.name));
    defs.push(info);
    byName.set(d.name, info);
  }
  const seen = new Set<string>();
  const diagnostics = [
    ...parsed.diagnostics,
    ...checker.diagnostics,
    ...graph.diagnostics,
    ...evalDiagnostics,
  ]
    .filter((d) => {
      const k = `${d.code}|${d.span.start}|${d.span.end}|${d.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort(byPosition);
  return {
    source,
    program: parsed.program,
    diagnostics,
    defs,
    byName,
    order: graph.order,
    evaluated,
    value(name) {
      const r = results.get(name);
      return r?.ok ? r.value : undefined;
    },
    internals,
  };
}

function defInfo(
  d: Def,
  c: CheckedDef,
  graph: Graph,
  isBlocked: boolean,
  result: DefResult | undefined,
): DefInfo {
  const uses: DefUses = c.uses;
  const info: DefInfo = {
    name: d.name,
    kind: d.type,
    span: d.span,
    nameSpan: d.nameSpan,
    params: d.type === 'func' ? d.params.map((p) => p.name) : [],
    text: printDef({ ...d, comment: undefined }),
    type: formatScheme(c.scheme),
    deps: [...uses.defs],
    variables: [...uses.variables],
    dependents: [...(graph.dependents.get(d.name) ?? [])],
    props: [...uses.props].sort(),
    kinds: [...uses.kinds].sort(),
    blocked: isBlocked,
  };
  if (result) info.result = result;
  return info;
}

/** Analyses a world from scratch. */
export function analyzeNumbers(world: World, opts: EngineOptions = {}): NumbersAnalysis {
  return new NumbersEngine(opts).update(world);
}

/** The static type of a runtime value (for bindings). */
export function typeOfValue(v: Value, world: World): Type {
  if (typeof v === 'number') return NUMBER;
  if (typeof v === 'string') return STRING;
  if (typeof v === 'boolean') return BOOL;
  if (isEntity(v)) return entityOf(v.id ? (world.entities[v.id]?.kind ?? null) : null);
  const first = v.items[0];
  return listOf(first === undefined ? NUMBER : typeOfValue(first, world));
}

const compiledCache = new WeakMap<
  Checker,
  Map<
    string,
    { parsed: ReturnType<typeof parseExpression>; checked: ReturnType<Checker['checkStandalone']> }
  >
>();

export interface Compiled {
  source: string;
  diagnostics: Diagnostic[];
  /** The expression's static type, e.g. `number`. */
  type: string;
  ok: boolean;
  /** Properties and collections it reads. */
  props: string[];
  defs: string[];
  /** Evaluates it (only when `ok`). */
  run(bindings?: Record<string, Value>, element?: Value): DefResult;
}

/**
 * Compiles a standalone expression (a curve's `y`, a dot query, an AI or
 * check probe) against an analysis: the program's definitions and variables
 * are in scope, plus `bindings` (e.g. `x`) and, if given, an element (`it`).
 */
export function compileExpression(
  analysis: NumbersAnalysis,
  source: string,
  bindingTypes: Record<string, Type> = {},
  elementType?: Type,
): Compiled {
  const { checker, evalWorld, results, stepLimit } = analysis.internals;
  // The checked form depends only on the checker (which outlives updates that
  // don't touch the source, schema or variable types), so repeated sampling,
  // e.g. while dragging an intent point, doesn't re-check.
  let memo = compiledCache.get(checker);
  if (!memo) {
    memo = new Map();
    compiledCache.set(checker, memo);
  }
  const key = `${source}\u0000${Object.entries(bindingTypes)
    .map(([k, t]) => `${k}:${formatType(t)}`)
    .join(',')}\u0000${elementType ? formatType(elementType) : ''}`;
  let hit = memo.get(key);
  if (!hit) {
    const p = parseExpression(source);
    const c = checker.checkStandalone(p.expr, new Map(Object.entries(bindingTypes)), elementType);
    hit = { parsed: p, checked: c };
    if (memo.size > 500) memo.clear();
    memo.set(key, hit);
  }
  const { parsed, checked } = hit;
  const diagnostics = [...parsed.diagnostics, ...checked.diagnostics];
  // A definition it uses that has no value blocks it.
  for (const d of checked.uses.defs) {
    const r = results.get(d);
    const info = analysis.byName.get(d);
    if (info?.kind === 'func' && info.blocked)
      diagnostics.push(
        diag(
          'check',
          'eval.dependency',
          `${d} has an error`,
          { start: 0, end: source.length },
          { hint: `Fix ${d} first` },
        ),
      );
    else if (r && !r.ok)
      diagnostics.push(
        diag(
          'check',
          'eval.dependency',
          `${d} has an error`,
          { start: 0, end: source.length },
          { hint: `Fix ${d} first` },
        ),
      );
  }
  const ok = !diagnostics.some((d) => d.severity === 'error');
  return {
    source,
    diagnostics,
    type: formatType(checker.u.resolve(checked.type)),
    ok,
    props: [...checked.uses.props].sort(),
    defs: [...checked.uses.defs].sort(),
    run(bindings = {}, element) {
      if (!ok) {
        const first = diagnostics.find((d) => d.severity === 'error');
        return {
          ok: false,
          error: first ?? diag('check', 'compile', 'Has errors', { start: 0, end: source.length }),
        };
      }
      const ev = new Evaluator(evalWorld, checker, (n) => results.get(n), undefined, stepLimit);
      return ev.runWith(parsed.expr, new Map(Object.entries(bindings)), element);
    },
  };
}

export { varType };
