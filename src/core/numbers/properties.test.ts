import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import type { World } from '../model/world';
import { commandArb } from '../testing/arbitraries';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import {
  stripDef,
  stripSpans,
  walk,
  type BinaryOp,
  type Def,
  type Expr,
  type Program,
} from './ast';
import { KEYWORDS } from './lexer';
import { analyzeNumbers, NumbersEngine, type NumbersAnalysis } from './engine';
import { parseExpression, parseProgram } from './parser';
import { printExpr, printProgram } from './printer';
import { toPlain } from './values';

/** Property tests for the language and the engine (fast-check). */

const S = { start: 0, end: 0 };
const ident = fc
  .stringMatching(/^[a-z_][a-z0-9_]{0,5}$/)
  .filter((s) => !KEYWORDS.has(s) && s !== 'it');
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

const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => ({
  e: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc
      .oneof(fc.nat(10_000), fc.double({ min: 0, max: 1e9, noNaN: true, noDefaultInfinity: true }))
      .map((value): Expr => ({ type: 'num', value: Object.is(value, -0) ? 0 : value, span: S })),
    fc.string({ maxLength: 6 }).map((value): Expr => ({ type: 'str', value, span: S })),
    fc.boolean().map((value): Expr => ({ type: 'bool', value, span: S })),
    fc.constant<Expr>({ type: 'none', span: S }),
    ident.map((name): Expr => ({ type: 'name', name, span: S })),
    ident.map((name): Expr => ({ type: 'accessor', name, span: S, nameSpan: S })),
    fc
      .tuple(fc.constantFrom<'-' | 'not'>('-', 'not'), tie('e'))
      .map(([op, operand]): Expr => ({ type: 'unary', op, operand, span: S })),
    fc
      .tuple(fc.constantFrom(...OPS), tie('e'), tie('e'))
      .map(([op, left, right]): Expr => ({ type: 'binary', op, left, right, span: S, opSpan: S })),
    fc
      .tuple(tie('e'), ident)
      .map(([object, name]): Expr => ({ type: 'member', object, name, span: S, nameSpan: S })),
    fc
      .tuple(ident, fc.array(tie('e'), { maxLength: 3 }))
      .map(([callee, args]): Expr => ({ type: 'call', callee, calleeSpan: S, args, span: S })),
    fc
      .tuple(tie('e'), tie('e'))
      .map(([source, cond]): Expr => ({ type: 'where', source, cond, span: S, opSpan: S })),
    fc.array(tie('e'), { maxLength: 3 }).map((items): Expr => ({ type: 'list', items, span: S })),
  ),
})).e;

const defArb: fc.Arbitrary<Def> = fc.oneof(
  fc
    .tuple(ident, exprArb)
    .map(([name, body]): Def => ({ type: 'const', name, nameSpan: S, body, span: S })),
  fc
    .tuple(
      ident,
      fc.array(
        fc.tuple(
          ident,
          fc.option(fc.constantFrom('number', 'band', 'item', 'list'), { nil: undefined }),
        ),
        { maxLength: 3 },
      ),
      exprArb,
    )
    .map(([name, ps, body]): Def => ({
      type: 'func',
      name,
      nameSpan: S,
      params: ps.map(([n, a]) =>
        a ? { name: n, span: S, annotation: { name: a, span: S } } : { name: n, span: S },
      ),
      body,
      span: S,
    })),
);

/** Characters and fragments the language uses, for fuzzing the parser. */
const fragment = fc.constantFrom(
  'k',
  'x',
  'items',
  'where',
  'and',
  'or',
  'not',
  'sum',
  '(',
  ')',
  '[',
  ']',
  ',',
  '.',
  ':',
  '=',
  '==',
  '<',
  '+',
  '-',
  '*',
  '/',
  '^',
  '"',
  '"a"',
  '\\',
  '1',
  '2.5',
  '1e3',
  '_',
  '#',
  '\n',
  '\n  ',
  ' ',
  '\t',
  'true',
  'none',
  '&',
  '!',
  'é',
  '\r',
);
const junk = fc.array(fragment, { maxLength: 40 }).map((xs) => xs.join(''));

const RUNS = { numRuns: 300 };

describe('parser properties', () => {
  it('parse(print(e)) gives back e, with no diagnostics', () => {
    fc.assert(
      fc.property(exprArb, (e) => {
        const src = printExpr(e);
        const r = parseExpression(src);
        expect(r.diagnostics).toEqual([]);
        expect(stripSpans(r.expr)).toEqual(stripSpans(e));
        // and printing is a fixed point
        expect(printExpr(r.expr)).toBe(src);
      }),
      { numRuns: 1000 },
    );
  });

  it('programs round-trip through the printer', () => {
    fc.assert(
      fc.property(fc.array(defArb, { maxLength: 6 }), (defs) => {
        const program: Program = { items: defs };
        const src = printProgram(program);
        const r = parseProgram(src);
        expect(r.diagnostics).toEqual([]);
        expect(r.program.items.map((d) => stripDef(d as Def))).toEqual(defs.map(stripDef));
      }),
      RUNS,
    );
  });

  it('spans are exact: inside the source, children inside parents, names at their text', () => {
    fc.assert(
      fc.property(exprArb, (e) => {
        const src = printExpr(e);
        const { expr } = parseExpression(src);
        const check = (n: Expr): void => {
          expect(n.span.start).toBeGreaterThanOrEqual(0);
          expect(n.span.end).toBeLessThanOrEqual(src.length);
          expect(n.span.start).toBeLessThanOrEqual(n.span.end);
          if (n.type === 'name') expect(src.slice(n.span.start, n.span.end)).toBe(n.name);
          if (n.type === 'member' || n.type === 'accessor')
            expect(src.slice(n.nameSpan.start, n.nameSpan.end)).toBe(n.name);
          if (n.type === 'call')
            expect(src.slice(n.calleeSpan.start, n.calleeSpan.end)).toBe(n.callee);
        };
        walk(expr, (n) => {
          check(n);
          const kids: Expr[] =
            n.type === 'binary'
              ? [n.left, n.right]
              : n.type === 'where'
                ? [n.source, n.cond]
                : n.type === 'unary'
                  ? [n.operand]
                  : n.type === 'member'
                    ? [n.object]
                    : n.type === 'call'
                      ? n.args
                      : n.type === 'list'
                        ? n.items
                        : [];
          for (const k of kids) {
            expect(k.span.start).toBeGreaterThanOrEqual(n.span.start);
            expect(k.span.end).toBeLessThanOrEqual(n.span.end);
          }
        });
      }),
      RUNS,
    );
  });

  it('never throws on any input, and every diagnostic span is inside the source', () => {
    fc.assert(
      fc.property(fc.oneof(junk, fc.string({ maxLength: 60 })), (src) => {
        const r = parseProgram(src);
        for (const d of r.diagnostics) {
          expect(d.span.start).toBeGreaterThanOrEqual(0);
          expect(d.span.end).toBeLessThanOrEqual(src.length);
        }
        const w = sampleWorld();
        w.numbers.formulas = src;
        const a = analyzeNumbers(w);
        for (const d of a.diagnostics) {
          expect(d.span.start).toBeGreaterThanOrEqual(0);
          expect(d.span.end).toBeLessThanOrEqual(src.length);
          expect(d.message.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 500 },
    );
  });
});

/** A program that reads every kind of input: variables, entities, collections, placement, functions. */
const PROGRAMS = [
  `taken(raw, def) = raw * k / (k + def)
armor = items where subkind == "armor"
total = sum(armor, .defense)
hit = taken(20, total)
band_defense(b: band) = sum(items where subkind == "armor" and band == b, .defense)
per_band = sum(bands, band_defense(it))
sky = count(entities where band != none and tier > 0)
hp = base_health * (1 + count(bands) / 10)
weapons = max(items where subkind == "weapon", .damage) + k
ratio = hit / hp
`,
  `taken(raw, def) = raw * k / (k + def)
hit = taken(20, 4)
hp = base_health + hit
loop = loop + 1
`,
  `armor = items where subkind == "armor"
total = sum(armor, .defense) + k
twice = total * 2
bad = total / (k - k)
`,
  '',
];

const worldCommandArb = (ids: readonly string[]): fc.Arbitrary<Command> =>
  fc.oneof(
    { weight: 3, arbitrary: commandArb(ids) },
    {
      weight: 2,
      arbitrary: fc
        .record({
          name: fc.constantFrom('k', 'base_health'),
          value: fc.option(fc.integer({ min: -5, max: 300 }), { nil: null }),
        })
        .map((p) => cmd('numbers.setVariable', p)),
    },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom('k', 'base_health')
        .map((name) => cmd('numbers.setVariable', { name, value: 'text' })),
    },
    {
      weight: 2,
      arbitrary: fc
        .constantFrom(...PROGRAMS)
        .map((source) => cmd('numbers.setFormulas', { source })),
    },
    {
      weight: 2,
      arbitrary: fc
        .record({
          id: fc.constantFrom('vent-glass-visor', 'cinder-sting', 'spore-lantern'),
          key: fc.constantFrom('defense', 'damage'),
          value: fc.option(fc.integer({ min: 0, max: 50 }), { nil: null }),
        })
        .map((p) => cmd('entity.setAttribute', p)),
    },
    {
      weight: 1,
      arbitrary: fc
        .record({
          from: fc.constantFrom('vent-glass-visor', 'cinder-sting', 'cloud-anklet'),
          to: fc.constantFrom('hollows', 'low-sky', 'groundline'),
        })
        .map((p) => cmd('relation.add', { from: p.from, type: 'in_band', to: p.to })),
    },
    {
      weight: 1,
      arbitrary: fc
        .integer({ min: -2000, max: 2000 })
        .map((v) => cmd('entity.setField', { id: 'low-sky', field: 'y_top', value: v })),
    },
  );

/** A canonical, comparable form of an analysis. */
function canon(a: NumbersAnalysis): unknown {
  return {
    defs: a.defs.map((d) => ({
      name: d.name,
      type: d.type,
      blocked: d.blocked,
      result: d.result
        ? d.result.ok
          ? { ok: toPlain(d.result.value) }
          : { err: [d.result.error.code, d.result.error.message, d.result.error.span] }
        : null,
    })),
    diagnostics: a.diagnostics.map((d) => [
      d.code,
      d.message,
      d.span.start,
      d.span.end,
      d.severity,
    ]),
    order: a.order,
  };
}

function step(w: World, c: Command): World {
  const r = applyCommand(w, c, { now: SAMPLE_TIME });
  return r.ok ? r.value.world : w;
}

const start = (): World => {
  const w = sampleWorld();
  return step(w, cmd('numbers.setFormulas', { source: PROGRAMS[0] as string }));
};

describe('engine properties', () => {
  const ids = Object.keys(sampleWorld().entities);

  it('incremental re-evaluation gives the same result as evaluating from scratch', () => {
    fc.assert(
      fc.property(fc.array(worldCommandArb(ids), { minLength: 1, maxLength: 12 }), (commands) => {
        let w = start();
        const engine = new NumbersEngine();
        engine.update(w);
        for (const c of commands) {
          w = step(w, c);
          expect(canon(engine.update(w))).toEqual(canon(analyzeNumbers(w)));
        }
      }),
      { numRuns: 150 },
    );
  });

  it('is deterministic: two engines on the same world agree', () => {
    fc.assert(
      fc.property(fc.array(worldCommandArb(ids), { maxLength: 6 }), (commands) => {
        let w = start();
        for (const c of commands) w = step(w, c);
        const copy = structuredClone(w);
        expect(canon(analyzeNumbers(w))).toEqual(canon(analyzeNumbers(copy)));
      }),
      { numRuns: 100 },
    );
  });

  it('is idempotent: updating with an equal world re-evaluates nothing and changes nothing', () => {
    fc.assert(
      fc.property(fc.array(worldCommandArb(ids), { maxLength: 6 }), (commands) => {
        let w = start();
        for (const c of commands) w = step(w, c);
        const engine = new NumbersEngine();
        const first = canon(engine.update(w));
        const again = engine.update(structuredClone(w));
        expect(again.evaluated).toEqual([]);
        expect(canon(again)).toEqual(first);
      }),
      { numRuns: 100 },
    );
  });

  it('re-evaluates only what a change reaches', () => {
    const w0 = start();
    const engine = new NumbersEngine();
    const a0 = engine.update(w0);
    expect(a0.evaluated.length).toBe(
      a0.defs.filter((d) => d.kind === 'const' && !d.blocked).length,
    );
    // base_health only feeds hp and ratio.
    const w1 = step(w0, cmd('numbers.setVariable', { name: 'base_health', value: 120 }));
    expect(engine.update(w1).evaluated.sort()).toEqual(['hp', 'ratio']);
    // A creature is read only by `entities where …` (sky).
    const w2 = step(w1, cmd('entity.update', { id: 'moss-grazer', set: { identity: 'Calmer' } }));
    expect(engine.update(w2).evaluated).toEqual(['sky']);
    // An armor's defense reaches every item query and what depends on it.
    const w3 = step(
      w2,
      cmd('entity.setAttribute', { id: 'vent-glass-visor', key: 'defense', value: 9 }),
    );
    expect(engine.update(w3).evaluated.sort()).toEqual(
      ['armor', 'hit', 'per_band', 'ratio', 'sky', 'total', 'weapons'].sort(),
    );
    // A whitespace-only edit to the source re-evaluates nothing.
    const w4 = step(
      w3,
      cmd('numbers.setFormulas', {
        source: (PROGRAMS[0] as string).replace('raw * k', 'raw  *  k'),
      }),
    );
    expect(engine.update(w4).evaluated).toEqual([]);
  });
});
