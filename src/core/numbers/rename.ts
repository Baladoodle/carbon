import type { Curve } from '../model/curves';
import { schemaOf, type World } from '../model/world';
import { defsOf, walk, type Expr } from './ast';
import { Checker } from './check';
import { xType } from './curves';
import { parseExpression, parseProgram } from './parser';
import type { Span } from './span';
import { entityOf } from './types';

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

export interface RenameResult {
  formulas: string;
  curves: Curve[] | undefined;
  /** How many references changed. */
  count: number;
}

/** References resolving to variable `name`, in the formulas and in the curves. */
function countVarRefs(world: World, name: string): number {
  const checker = new Checker({ schema: schemaOf(world), variables: world.numbers.variables });
  const program = parseProgram(world.numbers.formulas).program;
  checker.checkProgram(program);
  let n = 0;
  for (const d of defsOf(program)) n += varSpans(checker, d.body, name).length;
  for (const c of world.numbers.curves ?? []) {
    const x = new Map([['x', xType(c.over)]]);
    for (const [src, b] of [
      [c.y, x],
      [c.dots?.query, new Map()],
      [c.dots?.value, x],
    ] as const) {
      if (src === undefined) continue;
      const p = parseExpression(src);
      checker.checkStandalone(p.expr, b, src === c.dots?.value ? entityOf(null) : undefined);
      n += varSpans(checker, p.expr, name).length;
    }
  }
  return n;
}

/**
 * Whether renaming would change what some reference means: a parameter or
 * element property named `to` would capture it.
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

export function renameVariableIn(world: World, from: string, to: string): RenameResult {
  const checker = new Checker({ schema: schemaOf(world), variables: world.numbers.variables });
  const program = parseProgram(world.numbers.formulas).program;
  checker.checkProgram(program);
  const spans: Span[] = [];
  for (const d of defsOf(program)) spans.push(...varSpans(checker, d.body, from));
  let count = spans.length;
  const formulas = replaceSpans(world.numbers.formulas, spans, to);
  const rewrite = (
    src: string,
    bindings: Map<string, ReturnType<typeof xType>>,
    element?: ReturnType<typeof entityOf>,
  ): string => {
    const p = parseExpression(src);
    checker.checkStandalone(p.expr, bindings, element);
    const s = varSpans(checker, p.expr, from);
    count += s.length;
    return replaceSpans(src, s, to);
  };
  const curves = world.numbers.curves?.map((c) => {
    const x = new Map([['x', xType(c.over)]]);
    const next: Curve = { ...c, y: rewrite(c.y, x) };
    if (c.dots) {
      const dots: NonNullable<Curve['dots']> = { query: rewrite(c.dots.query, new Map()) };
      if (c.dots.value !== undefined) {
        // The element is typed as the curve does it: by the query's kind.
        const q = checker.checkStandalone(parseExpression(c.dots.query).expr, new Map());
        const t = checker.u.resolve(q.type);
        const kind =
          t.t === 'list' && t.of.t === 'entity' && t.of.kind.k === 'kind' ? t.of.kind.kind : null;
        dots.value = rewrite(c.dots.value, x, entityOf(kind));
      }
      next.dots = dots;
    }
    return next;
  });
  return { formulas, curves, count };
}
