import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import type { World } from '../model/world';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import { walk, type BinaryOp, type Def, type Expr, type Program } from './ast';
import { analyzeNumbers, compileExpression, NumbersEngine, type NumbersAnalysis } from './engine';
import { DEFAULT_STEP_LIMIT, Evaluator } from './evaluate';
import { parseProgram } from './parser';
import { printProgram } from './printer';
import { NUMBER } from './types';
import { toPlain } from './values';

/**
 * Fuzzing the whole pipeline (review-b) with programs whose names refer to
 * each other: random ASTs over a shared pool of definitions, variables,
 * collections, properties and built-ins, so references resolve, functions
 * call functions, queries run and cycles happen. Plus random token streams.
 */

const S = { start: 0, end: 0 };
const DEFS = ['a', 'b', 'c', 'f', 'g', 'h'];
const PARAMS = ['x', 'y'];
const VARS = ['k', 'base_health'];
const COLLECTIONS = ['items', 'bands', 'entities', 'creatures'];
const PROPS = ['defense', 'damage', 'subkind', 'band', 'tier', 'name', 'kind', 'menace'];
const BUILTINS: [string, number][] = [
  ['min', 2],
  ['max', 1],
  ['abs', 1],
  ['sqrt', 1],
  ['log', 1],
  ['round', 2],
  ['clamp', 3],
  ['if', 3],
  ['sum', 2],
  ['avg', 2],
  ['count', 1],
  ['count', 2],
  ['contains', 2],
  ['lerp', 3],
  ['pow', 2],
];
const OPS: BinaryOp[] = [
  'or',
  'and',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
];

const num = (value: number): Expr => ({ type: 'num', value, span: S });
const name = (n: string): Expr => ({ type: 'name', name: n, span: S });

const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => ({
  e: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.oneof(fc.nat(20), fc.constantFrom(0, 0.5, 1e308, 1e-300, 7)).map(num),
    fc.constantFrom<Expr>(
      { type: 'str', value: 'armor', span: S },
      { type: 'bool', value: true, span: S },
      { type: 'none', span: S },
    ),
    fc.constantFrom(...DEFS, ...PARAMS, ...VARS, ...COLLECTIONS, ...PROPS, 'it').map(name),
    fc
      .constantFrom(...PROPS)
      .map((n): Expr => ({ type: 'accessor', name: n, span: S, nameSpan: S })),
    fc
      .tuple(fc.constantFrom<'-' | 'not'>('-', 'not'), tie('e'))
      .map(([op, operand]): Expr => ({ type: 'unary', op, operand, span: S })),
    fc
      .tuple(fc.constantFrom(...OPS), tie('e'), tie('e'))
      .map(([op, left, right]): Expr => ({ type: 'binary', op, left, right, span: S, opSpan: S })),
    fc
      .tuple(tie('e'), fc.constantFrom(...PROPS))
      .map(([object, n]): Expr => ({ type: 'member', object, name: n, span: S, nameSpan: S })),
    fc
      .tuple(fc.constantFrom(...BUILTINS), fc.array(tie('e'), { minLength: 3, maxLength: 3 }))
      .map(([[callee, arity], args]): Expr => ({
        type: 'call',
        callee,
        calleeSpan: S,
        args: args.slice(0, arity),
        span: S,
      })),
    fc
      .tuple(fc.constantFrom(...DEFS), fc.array(tie('e'), { maxLength: 2 }))
      .map(([callee, args]): Expr => ({ type: 'call', callee, calleeSpan: S, args, span: S })),
    fc
      .tuple(fc.constantFrom(...COLLECTIONS).map(name), tie('e'))
      .map(([source, cond]): Expr => ({ type: 'where', source, cond, span: S, opSpan: S })),
    fc.array(tie('e'), { maxLength: 3 }).map((items): Expr => ({ type: 'list', items, span: S })),
  ),
})).e;

/** A program defining some of the pool, as constants or functions of x (and y). */
const programArb: fc.Arbitrary<string> = fc
  .uniqueArray(fc.tuple(fc.constantFrom(...DEFS), fc.integer({ min: 0, max: 2 }), exprArb), {
    selector: ([n]) => n,
    maxLength: 6,
  })
  .map((defs) => {
    const items: Def[] = defs.map(([n, arity, body]) =>
      arity === 0
        ? { type: 'const', name: n, nameSpan: S, body, span: S }
        : {
            type: 'func',
            name: n,
            nameSpan: S,
            params: PARAMS.slice(0, arity).map((p) => ({ name: p, span: S })),
            body,
            span: S,
          },
    );
    const program: Program = { items };
    return printProgram(program);
  });

function canon(a: NumbersAnalysis): unknown {
  return {
    defs: a.defs.map((d) => ({
      name: d.name,
      type: d.type,
      blocked: d.blocked,
      deps: d.deps,
      result: d.result
        ? d.result.ok
          ? { ok: toPlain(d.result.value) }
          : { err: [d.result.error.code, d.result.error.message, d.result.error.span] }
        : null,
    })),
    diagnostics: a.diagnostics.map((d) => [d.code, d.message, d.span.start, d.span.end]),
    order: a.order,
  };
}

const step = (w: World, c: Command): World => {
  const r = applyCommand(w, c, { now: SAMPLE_TIME });
  return r.ok ? r.value.world : w;
};

const commandArb: fc.Arbitrary<Command> = fc.oneof(
  { weight: 3, arbitrary: programArb.map((source) => cmd('numbers.setFormulas', { source })) },
  {
    weight: 2,
    arbitrary: fc
      .record({
        name: fc.constantFrom(...VARS),
        value: fc.oneof(fc.integer({ min: -3, max: 300 }), fc.constantFrom(0, 'text', true)),
      })
      .map((p) => cmd('numbers.setVariable', p)),
  },
  {
    weight: 2,
    arbitrary: fc
      .record({
        id: fc.constantFrom('vent-glass-visor', 'cinder-sting', 'spore-lantern'),
        key: fc.constantFrom('defense', 'damage'),
        value: fc.option(fc.integer({ min: -5, max: 50 }), { nil: null }),
      })
      .map((p) => cmd('entity.setAttribute', p)),
  },
  {
    weight: 1,
    arbitrary: fc
      .record({
        id: fc.constantFrom('vent-glass-visor', 'moss-grazer', 'low-sky'),
        state: fc.constantFrom('graveyard', 'idea', 'decided'),
      })
      .map((p) => cmd('entity.setState', { ...p, why: 'because', killed: { reason: 'seen it' } })),
  },
  {
    weight: 1,
    arbitrary: fc
      .integer({ min: -2000, max: 2000 })
      .map((v) => cmd('entity.setField', { id: 'low-sky', field: 'y_top', value: v })),
  },
);

describe('random programs over a shared pool of names', () => {
  it('analysis never throws, every span is inside the source, and every constant settles', () => {
    fc.assert(
      fc.property(programArb, (src) => {
        const w = step(sampleWorld(), cmd('numbers.setFormulas', { source: src }));
        const a = analyzeNumbers(w, { stepLimit: 5_000 });
        for (const d of a.diagnostics) {
          expect(d.span.start).toBeGreaterThanOrEqual(0);
          expect(d.span.end).toBeLessThanOrEqual(src.length);
          expect(d.span.start).toBeLessThanOrEqual(d.span.end);
        }
        for (const d of a.defs) {
          if (d.kind === 'func') continue;
          expect(d.result, d.name).toBeDefined();
          if (d.result?.ok) expect(Number.isNaN(d.result.value)).toBe(false);
          else if (d.result) {
            expect(d.result.error.span.end).toBeLessThanOrEqual(src.length);
            expect(d.result.error.span.start).toBeGreaterThanOrEqual(0);
          }
        }
      }),
      { numRuns: 400 },
    );
  });

  it('incremental evaluation always equals evaluation from scratch', () => {
    fc.assert(
      fc.property(fc.array(commandArb, { minLength: 1, maxLength: 10 }), (commands) => {
        let w = sampleWorld();
        const engine = new NumbersEngine({ stepLimit: 5_000 });
        engine.update(w);
        for (const c of commands) {
          w = step(w, c);
          expect(canon(engine.update(w))).toEqual(canon(analyzeNumbers(w, { stepLimit: 5_000 })));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('the step limit holds for every evaluation', () => {
    fc.assert(
      fc.property(programArb, fc.integer({ min: 1, max: 2_000 }), (src, limit) => {
        const w = step(sampleWorld(), cmd('numbers.setFormulas', { source: src }));
        const a = analyzeNumbers(w, { stepLimit: limit });
        const { checker, evalWorld, results } = a.internals;
        for (const d of a.defs) {
          if (d.kind !== 'const' || d.blocked) continue;
          const def = checker.defs.get(d.name);
          if (!def) continue;
          const ev = new Evaluator(evalWorld, checker, (n) => results.get(n), d.name, limit);
          const r = ev.run(def.body);
          // One node over the limit is how it notices.
          expect(ev.steps).toBeLessThanOrEqual(
            limit + 1 + Object.keys(evalWorld.world.entities).length,
          );
          if (!r.ok && r.error.code === 'eval.steps') expect(ev.steps).toBeGreaterThan(limit);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('standalone expressions report spans inside their own source', () => {
    fc.assert(
      fc.property(programArb, exprArb, (src, e) => {
        const w = step(sampleWorld(), cmd('numbers.setFormulas', { source: src }));
        const a = analyzeNumbers(w, { stepLimit: 5_000 });
        const text = printProgram({
          items: [{ type: 'const', name: 'q', nameSpan: S, body: e, span: S }],
        })
          .slice('q = '.length)
          .trimEnd();
        const c = compileExpression(a, text, { x: NUMBER, y: NUMBER });
        const inside = (s: { start: number; end: number }): void => {
          expect(s.start).toBeGreaterThanOrEqual(0);
          expect(s.end).toBeLessThanOrEqual(text.length);
        };
        for (const d of c.diagnostics) inside(d.span);
        const r = c.run({ x: 2, y: 3 });
        if (!r.ok) inside(r.error.span);
      }),
      { numRuns: 400 },
    );
  });
});

/** Tokens of the language, joined at random: a stream the parser has to survive. */
const token = fc.oneof(
  fc.constantFrom(
    ...DEFS,
    ...PARAMS,
    ...VARS,
    ...COLLECTIONS,
    ...PROPS,
    'where',
    'and',
    'or',
    'not',
    'true',
    'false',
    'none',
    'it',
    'sum',
    'count',
    'if',
    '(',
    ')',
    '[',
    ']',
    ',',
    '.',
    ':',
    '=',
    '==',
    '!=',
    '<',
    '<=',
    '>',
    '>=',
    '+',
    '-',
    '*',
    '/',
    '%',
    '^',
    '"s"',
    '"',
    '\\',
    '#c',
    '1',
    '0',
    '2.5',
    '1e999',
    '1_',
    '9e-400',
    '\n',
    '\n  ',
    ' ',
    '\t',
    '\r',
    '&',
    '!',
    'é',
    '😀',
    '\uD800',
    '\uDC00',
    '\u0000',
  ),
);
const stream = fc.array(token, { maxLength: 80 }).map((t) => t.join(' '));
const tight = fc.array(token, { maxLength: 80 }).map((t) => t.join(''));

describe('random token streams', () => {
  it('never throw, never hang, and every span is inside the source', () => {
    fc.assert(
      fc.property(fc.oneof(stream, tight), (src) => {
        const t = performance.now();
        const p = parseProgram(src);
        for (const d of p.diagnostics) {
          expect(d.span.start).toBeGreaterThanOrEqual(0);
          expect(d.span.end).toBeLessThanOrEqual(src.length);
          expect(d.span.start).toBeLessThanOrEqual(d.span.end);
        }
        const w = step(sampleWorld(), cmd('numbers.setFormulas', { source: src }));
        const a = analyzeNumbers(w);
        for (const d of a.diagnostics) {
          expect(d.span.start).toBeGreaterThanOrEqual(0);
          expect(d.span.end).toBeLessThanOrEqual(src.length);
        }
        expect(performance.now() - t).toBeLessThan(2_000);
        // Whatever parsed, printed, parses to the same definitions.
        const printed = printProgram(p.program);
        if (
          !p.program.items.some(
            (i) => i.type !== 'blank' && i.type !== 'comment' && containsError(i),
          )
        )
          expect(printProgram(parseProgram(printed).program)).toBe(printed);
      }),
      { numRuns: 1_000 },
    );
  });
});

function containsError(d: Def): boolean {
  let bad = false;
  walk(d.body, (e) => {
    if (e.type === 'error') bad = true;
  });
  return bad;
}

it('the default step limit is the documented one', () => {
  expect(DEFAULT_STEP_LIMIT).toBe(200_000);
});
