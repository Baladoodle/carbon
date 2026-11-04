import type { Curve } from '../model/curves';
import { schemaOf, type World } from '../model/world';
import { defsOf, walk, type Expr } from './ast';
import { Checker } from './check';
import { xType } from './curves';
import { parseExpression, parseProgram } from './parser';
import type { Span } from './span';
import { entityOf, type Type } from './types';

/**
 * Renaming a variable everywhere it's used: in `formulas.carbon` and in the
 * curves' expressions. Only references that *resolve* to the variable change
 * (a parameter or element property with the same name is left alone), using
 * the resolver's spans, so the rest of the text is untouched.
 */
function varSpans(checker: Checker, e: Expr, name: string): Span[] {
  const out: Span[] = [];
  walk(e, (n) => {
    if (n.type !== 'name') return;
    const r = checker.resolutions.get(n);
    if (r?.to === 'var' && r.name === name) out.push(n.span);
  });
  return out;
}

function replaceSpans(source: string, spans: Span[], text: string): string {
  let out = source;
  for (const s of [...spans].sort((a, b) => b.start - a.start))
    out = out.slice(0, s.start) + text + out.slice(s.end);
  return out;
}

/** A dot's element type, as sampleCurve gives it: the kind its query lists. */
function dotElement(checker: Checker, query: string): Type {
  const q = checker.checkStandalone(parseExpression(query).expr, new Map());
  const t = checker.u.resolve(q.type);
  return entityOf(
    t.t === 'list' && t.of.t === 'entity' && t.of.kind.k === 'kind' ? t.of.kind.kind : null,
  );
}

interface Part {
  part: 'y' | 'query' | 'value';
  source: string;
  bindings: Map<string, Type>;
  element?: Type;
}

/** Each expression of a curve with the scope sampleCurve checks it in. */
function curveParts(checker: Checker, c: Curve): Part[] {
  const x = new Map([['x', xType(c.over)]]);
  const out: Part[] = [{ part: 'y', source: c.y, bindings: x }];
  if (c.dots) {
    out.push({ part: 'query', source: c.dots.query, bindings: new Map() });
    if (c.dots.value !== undefined)
      out.push({
        part: 'value',
        source: c.dots.value,
        bindings: x,
        element: dotElement(checker, c.dots.query),
      });
  }
  return out;
}

function checked(world: World): { checker: Checker; spans: (name: string) => Span[] } {
  const checker = new Checker({ schema: schemaOf(world), variables: world.numbers.variables });
  const program = parseProgram(world.numbers.formulas).program;
  checker.checkProgram(program);
  return {
    checker,
    spans: (name) => defsOf(program).flatMap((d) => varSpans(checker, d.body, name)),
  };
}

export interface RenameResult {
  formulas: string;
  curves: Curve[] | undefined;
  /** How many references changed. */
  count: number;
}

export function renameVariableIn(world: World, from: string, to: string): RenameResult {
  const { checker, spans } = checked(world);
  const own = spans(from);
  let count = own.length;
  const formulas = replaceSpans(world.numbers.formulas, own, to);
  const curves = world.numbers.curves?.map((c) => {
    const next: Curve = { ...c };
    for (const p of curveParts(checker, c)) {
      const e = parseExpression(p.source).expr;
      checker.checkStandalone(e, p.bindings, p.element);
      const s = varSpans(checker, e, from);
      count += s.length;
      const text = replaceSpans(p.source, s, to);
      if (p.part === 'y') next.y = text;
      else if (next.dots && p.part === 'query') next.dots = { ...next.dots, query: text };
      else if (next.dots) next.dots = { ...next.dots, value: text };
    }
    return next;
  });
  return { formulas, curves, count };
}

/** References resolving to variable `name`, in the formulas and in the curves. */
function countVarRefs(world: World, name: string): number {
  const { checker, spans } = checked(world);
  let n = spans(name).length;
  for (const c of world.numbers.curves ?? [])
    for (const p of curveParts(checker, c)) {
      const e = parseExpression(p.source).expr;
      checker.checkStandalone(e, p.bindings, p.element);
      n += varSpans(checker, e, name).length;
    }
  return n;
}

/**
 * Whether the rename would change what some reference means: a parameter or
 * element property named `to` would capture a reference to the variable.
 */
export function renameCaptures(
  world: World,
  from: string,
  to: string,
  result: RenameResult,
): boolean {
  const variables: World['numbers']['variables'] = {};
  for (const [k, v] of Object.entries(world.numbers.variables)) variables[k === from ? to : k] = v;
  const after: World = {
    ...world,
    numbers: {
      ...world.numbers,
      variables,
      formulas: result.formulas,
      ...(result.curves ? { curves: result.curves } : {}),
    },
  };
  return countVarRefs(after, to) !== countVarRefs(world, from);
}
