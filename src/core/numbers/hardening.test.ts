import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import { emptyWorld, type World } from '../model/world';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import { analyzeNumbers, compileExpression } from './engine';
import { MAX_DEPTH, parseExpression, parseProgram } from './parser';
import { NUMBER } from './types';
import type { Diagnostic } from './span';

/**
 * Hardening (review-b): inputs that must never crash, hang or produce a
 * span that the editor can't draw. Each block here was a real defect.
 */

const withFormulas = (source: string, base: World = emptyWorld()): World => ({
  ...base,
  numbers: { ...base.numbers, formulas: source },
});

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

/** A span the editor can underline: inside the source, ordered, and never splitting a surrogate pair. */
function expectValidSpan(d: Diagnostic, src: string): void {
  const { start, end } = d.span;
  expect(Number.isInteger(start) && Number.isInteger(end), d.message).toBe(true);
  expect(start, d.message).toBeGreaterThanOrEqual(0);
  expect(end, d.message).toBeLessThanOrEqual(src.length);
  expect(start, d.message).toBeLessThanOrEqual(end);
  for (const at of [start, end])
    if (at > 0 && at < src.length)
      expect(
        isHigh(src.charCodeAt(at - 1)) && isLow(src.charCodeAt(at)),
        `${d.code} at ${at} splits a surrogate pair`,
      ).toBe(false);
  expect(d.message.length).toBeGreaterThan(0);
  // A message never carries half a character.
  expect(d.message).not.toMatch(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/,
  );
}

const codes = (src: string, base?: World): string[] =>
  analyzeNumbers(withFormulas(src, base)).diagnostics.map((d) => d.code);

describe('deep nesting never overflows the stack', () => {
  const N = 20_000;
  const cases: [string, string][] = [
    ['parentheses', `x = ${'('.repeat(N)}1${')'.repeat(N)}`],
    ['unary minus', `x = ${'-'.repeat(N)}1`],
    ['not', `x = ${'not '.repeat(N)}true`],
    ['lists', `x = ${'['.repeat(N)}1${']'.repeat(N)}`],
    ['calls', `x = ${'abs('.repeat(N)}1${')'.repeat(N)}`],
    ['a long left-associative sum', `x = ${Array(N).fill('1').join(' + ')}`],
    ['a long right-associative power', `x = ${Array(N).fill('1').join(' ^ ')}`],
    ['a long member chain', `x = it${'.a'.repeat(N)}`],
  ];
  for (const [what, src] of cases)
    it(`${what}: a precise parse error, no crash`, () => {
      const p = parseProgram(src);
      expect(p.diagnostics.map((d) => d.code)).toEqual(['parse.depth']);
      for (const d of p.diagnostics) expectValidSpan(d, src);
      expect(codes(src)).toContain('parse.depth');
      // and standalone expressions (curves) too
      const expr = src.slice(4);
      expect(parseExpression(expr).diagnostics.map((d) => d.code)).toEqual(['parse.depth']);
    });

  it('nesting up to the limit still parses and evaluates', () => {
    const d = MAX_DEPTH - 2;
    const src = `x = ${'('.repeat(d)}1${')'.repeat(d)} + ${'-'.repeat(d)}1`;
    const a = analyzeNumbers(withFormulas(src));
    expect(a.diagnostics).toEqual([]);
    expect(a.value('x')).toBe(1 + (d % 2 === 0 ? 1 : -1));
  });

  it('a long chain of function calls stops with an error, not a crash', () => {
    const n = 20_000;
    const lines = ['f0(x) = x + 1'];
    for (let i = 1; i < n; i++) lines.push(`f${i}(x) = f${i - 1}(x) + 1`);
    lines.push(`r = f${n - 1}(0)`, 'ok = f10(0)');
    const a = analyzeNumbers(withFormulas(lines.join('\n')));
    const r = a.byName.get('r')?.result;
    expect(r?.ok).toBe(false);
    if (r && !r.ok) {
      expect(r.error.code).toBe('eval.depth');
      expectValidSpan(r.error, lines.join('\n'));
    }
    expect(a.value('ok')).toBe(11);
  });

  it('a long chain of constants defined in reverse order checks and evaluates', () => {
    const n = 20_000;
    const lines: string[] = [];
    for (let i = n - 1; i >= 1; i--) lines.push(`c${i} = c${i - 1} + 1`);
    lines.push('c0 = 0');
    const a = analyzeNumbers(withFormulas(lines.join('\n')));
    expect(a.diagnostics).toEqual([]);
    expect(a.value(`c${n - 1}`)).toBe(n - 1);
  });

  it('a long chain of functions defined in reverse order type-checks', () => {
    const n = 20_000;
    const lines: string[] = ['r = f50(0)'];
    for (let i = n - 1; i >= 1; i--) lines.push(`f${i}(x) = f${i - 1}(x) + 1`);
    lines.push('f0(x) = x');
    const a = analyzeNumbers(withFormulas(lines.join('\n')));
    expect(a.diagnostics).toEqual([]);
    expect(a.byName.get(`f${n - 1}`)?.type).toBe('(number) → number');
    expect(a.value('r')).toBe(50);
  });
});

describe('the step limit bounds time, not only nodes', () => {
  const big = (): World => {
    const commands: Command[] = [];
    for (let i = 0; i < 2000; i++)
      commands.push(
        cmd('entity.create', {
          kind: 'item',
          name: `Armor ${i}`,
          fields: { subkind: 'armor' },
          attributes: { defense: i % 40 },
        }),
      );
    const r = applyCommands(sampleWorld(), commands, { now: SAMPLE_TIME });
    if (!r.ok) throw new Error(r.error.message);
    return r.value.world;
  };
  const w = big();

  it('a nested query over 2,000 entities stops at the limit quickly', () => {
    const t = performance.now();
    const c = codes('x = count(entities where count(entities where count(entities) > 0) > 0)', w);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(c).toEqual(['eval.steps']);
  });

  it('contains over a large list inside a query stops at the limit quickly', () => {
    const t = performance.now();
    const c = codes('x = count(entities where contains(entities, it))', w);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(c).toEqual(['eval.steps']);
  });

  it('list equality inside a query stops at the limit quickly', () => {
    const t = performance.now();
    const c = codes('x = count(entities where entities == items)', w);
    expect(performance.now() - t).toBeLessThan(1500);
    expect(c).toEqual(['eval.steps']);
  });

  it('a query over a collection per element is cheap when it stays under the limit', () => {
    // `count(items)` inside the condition reads the collection once per element.
    const a = analyzeNumbers(withFormulas('x = count(bands where count(items) > 0)', w));
    expect(a.diagnostics).toEqual([]);
    expect(a.value('x')).toBe(5);
  });

  it('min and max over a long list do not overflow the argument stack', () => {
    const items = Array.from({ length: 200_000 }, (_, i) => String(i % 7)).join(', ');
    const a = analyzeNumbers(withFormulas(`x = max([${items}])`), { stepLimit: 1_000_000 });
    expect(a.diagnostics).toEqual([]);
    expect(a.value('x')).toBe(6);
  });

  it('exponential function blow-up stops at the limit', () => {
    const lines = ['f0(x) = x + x'];
    for (let i = 1; i <= 40; i++) lines.push(`f${i}(x) = f${i - 1}(x) + f${i - 1}(x)`);
    lines.push('r = f40(1)');
    const t = performance.now();
    expect(codes(lines.join('\n'))).toEqual(['eval.steps']);
    expect(performance.now() - t).toBeLessThan(1500);
  });
});

describe('unicode and odd characters', () => {
  it('an emoji is one error over the whole character, and the line reports nothing else', () => {
    const src = 'x = 😀';
    const p = parseProgram(src);
    expect(p.diagnostics.map((d) => [d.code, d.span])).toEqual([
      ['lex.char', { start: 4, end: 6 }],
    ]);
    for (const d of p.diagnostics) expectValidSpan(d, src);
  });

  it('a run of unknown characters is one error', () => {
    const src = 'x = 1 + ¿¿¿';
    const p = parseProgram(src);
    expect(p.diagnostics.map((d) => [d.code, d.span])).toEqual([
      ['lex.char', { start: 8, end: 11 }],
    ]);
  });

  it('a non-ASCII letter in a name says how names are written', () => {
    const src = 'café = 1';
    const p = parseProgram(src);
    expect(p.diagnostics).toHaveLength(1);
    const d = p.diagnostics[0] as Diagnostic;
    expect(d.code).toBe('lex.char');
    expect(d.span).toEqual({ start: 3, end: 4 });
    expect(d.hint).toMatch(/a–z/);
  });

  it('an escape of an astral character covers the whole character', () => {
    const src = 'x = "\\😀"';
    const p = parseProgram(src);
    expect(p.diagnostics.map((d) => [d.code, d.span])).toEqual([
      ['lex.escape', { start: 5, end: 8 }],
    ]);
    for (const d of p.diagnostics) expectValidSpan(d, src);
  });

  it('strings keep any unicode, and evaluate to it', () => {
    const a = analyzeNumbers(withFormulas('x = "héllo 😀 \\"q\\""'));
    expect(a.diagnostics).toEqual([]);
    expect(a.value('x')).toBe('héllo 😀 "q"');
  });

  it('every diagnostic span is drawable, for any string at all', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 80 }), (src) => {
        for (const d of parseProgram(src).diagnostics) expectValidSpan(d, src);
        for (const d of analyzeNumbers(withFormulas(src, sampleWorld())).diagnostics)
          expectValidSpan(d, src);
      }),
      { numRuns: 400 },
    );
  });
});

describe('numeric edges', () => {
  const v = (src: string): unknown => analyzeNumbers(withFormulas(`x = ${src}`)).value('x');
  const c = (src: string): string[] => codes(`x = ${src}`);

  it('overflow to infinity is allowed, NaN never is', () => {
    expect(v('1e308 * 10')).toBe(Infinity);
    expect(v('-1e308 * 10')).toBe(-Infinity);
    expect(c('exp(1000) - exp(1000)')).toEqual(['eval.nan']);
    expect(c('exp(1000) * 0')).toEqual(['eval.nan']);
    expect(c('exp(1000) / exp(1000)')).toEqual(['eval.nan']);
    expect(c('pow(-8, 1 / 3)')).toEqual(['eval.nan']);
    expect(c('lerp(exp(1000), 0, 0)')).toEqual(['eval.nan']);
    expect(c('round(exp(1000) - exp(1000))')).toEqual(['eval.nan']);
  });

  it('a number too large to write is a lex error with a hint', () => {
    expect(c('1e400')).toEqual(['lex.number']);
  });

  it('division and remainder by zero, and by negative zero', () => {
    expect(c('1 / 0')).toEqual(['eval.div_zero']);
    expect(c('1 % 0')).toEqual(['eval.div_zero']);
    expect(c('1 / -0')).toEqual(['eval.div_zero']);
    expect(c('1 / (0 * -1)')).toEqual(['eval.div_zero']);
  });

  it('every built-in turns a NaN into an error, never a value', () => {
    for (const f of ['abs', 'floor', 'ceil', 'round', 'sqrt', 'exp'])
      expect(c(`${f}(exp(1000) - exp(1000))`), f).toEqual(['eval.nan']);
    expect(c('clamp(exp(1000) - exp(1000), 0, 1)')).toEqual(['eval.nan']);
    expect(c('min(1, exp(1000) - exp(1000))')).toEqual(['eval.nan']);
    expect(c('max([1, exp(1000) - exp(1000)])')).toEqual(['eval.nan']);
  });

  it('empty queries: sums are 0, averages and extremes are errors with a hint', () => {
    expect(v('sum(items where false, .defense)')).toBe(0);
    expect(v('count(items where false)')).toBe(0);
    expect(c('avg(items where false, .defense)')).toEqual(['eval.empty']);
    expect(c('min(items where false, .defense)')).toEqual(['eval.empty']);
    expect(c('max([])')).toEqual(['eval.empty']);
  });

  it('an empty standalone expression is one error at its end', () => {
    const a = analyzeNumbers(emptyWorld());
    const r = compileExpression(a, '   ');
    expect(r.ok).toBe(false);
    expect(r.diagnostics.map((d) => [d.code, d.span])).toEqual([
      ['parse.empty', { start: 3, end: 3 }],
    ]);
  });
});

describe('standalone expressions (curves, probes)', () => {
  it('an error inside a function a curve calls is reported at the call, in the curve’s own source', () => {
    const w = withFormulas('taken(raw, def) = raw * k / (k + def)\n', sampleWorld());
    const a = analyzeNumbers(w);
    const src = '1 + taken(x, -k)';
    const c = compileExpression(a, src, { x: NUMBER });
    expect(c.ok).toBe(true);
    const r = c.run({ x: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('eval.div_zero');
      expect(src.slice(r.error.span.start, r.error.span.end)).toBe('taken(x, -k)');
    }
  });
});
