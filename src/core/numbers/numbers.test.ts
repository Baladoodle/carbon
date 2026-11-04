import { describe, expect, it } from 'vitest';
import { applyCommand, applyCommands } from '../commands/apply';
import { applyPatch } from '../commands/patch';
import { cmd, type Command } from '../commands/registry';
import { filesForPatch, worldFromFiles, worldToFiles } from '../files/world-files';
import type { Curve } from '../model/curves';
import type { World } from '../model/world';
import { resolvePlacement } from '../placement';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import { buildGraph, downstream } from './graph';
import {
  allFormulas,
  analyzeNumbers,
  axisTicks,
  bandOrder,
  compileExpression,
  deviation,
  entityOf,
  resolvedPlacement,
  formatNumber,
  formatType,
  formatValue,
  formulaErrors,
  initialIntent,
  intentAt,
  intentDeviations,
  intentPoints,
  lineCol,
  lineStarts,
  listOf,
  niceTicks,
  NUMBER,
  NumbersEngine,
  relevantFormulas,
  roundNice,
  sampleCurve,
  storedIntentX,
  summarize,
  toPlain,
  typeOfValue,
  valueEquals,
  entityRef,
} from './index';
import { closest, editDistance } from './span';
import { Unifier, formatScheme, annotationType, BOOL, STRING } from './types';
import { listValue } from './values';

const ctx = { now: SAMPLE_TIME };
function run(w: World, ...commands: Command[]): World {
  const r = applyCommands(w, commands, ctx);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value.world;
}
const withFormulas = (source: string, w = sampleWorld()): World =>
  run(w, cmd('numbers.setFormulas', { source }));

describe('evaluation details', () => {
  it('numbers follow the variables', () => {
    const w = withFormulas('taken(raw, def) = raw * k / (k + def)\nhit = taken(20, 100)\n');
    expect(analyzeNumbers(w).value('hit')).toBe(10);
    const w2 = run(w, cmd('numbers.setVariable', { name: 'k', value: 300 }));
    expect(analyzeNumbers(w2).value('hit')).toBe(15);
  });

  it('attributes use their default and respect `when`', () => {
    let w = run(
      sampleWorld(),
      cmd('schema.setAttributeDef', { kind: 'item', def: { key: 'weight', default: 2 } }),
    );
    w = withFormulas('w = sum(items, .weight)\nd = sum(items, .defense)\n', w);
    const a = analyzeNumbers(w);
    expect(a.value('w')).toBe(8); // four live items, each the default 2
    expect(a.byName.get('d')?.result).toMatchObject({
      ok: false,
      error: { code: 'eval.attribute_when' },
    });
  });

  it('reads fields of every form', () => {
    const w = withFormulas(
      [
        'lantern = items where id == "spore-lantern"',
        'subkind_of = sum(lantern, if(.subkind == "tool", 1, 0))',
        'slot_empty = count(items where slot == "")',
        'tags_n = sum(items, count(.tags))',
        'props_n = sum(materials, count(.properties))',
        'grazers = count(creatures where menace < 0)',
        'tops = count(bands where y_top > 0)',
        'biome_bands = count(biomes where band != none)',
        'reef = biomes where band.name == "Low Sky"',
        'dmin = sum(bands where id == "hollows", .danger_min)',
        'states = count(entities where state == "decided")',
      ].join('\n'),
    );
    const a = analyzeNumbers(w);
    expect(a.diagnostics).toEqual([]);
    expect(a.value('subkind_of')).toBe(1);
    expect(a.value('slot_empty')).toBe(4);
    expect(a.value('tags_n')).toBe(0);
    expect(a.value('props_n')).toBe(4);
    expect(a.value('grazers')).toBe(1);
    expect(a.value('tops')).toBe(3); // groundline, low-sky, high-drift (+inf)
    expect(a.value('biome_bands')).toBe(4);
    expect(formatValue(a.value('reef') ?? 0, { name: (id) => w.entities[id]?.name })).toBe(
      '[Cloud Reef]',
    );
    expect(a.value('dmin')).toBe(3);
    expect(a.value('states')).toBe(4); // cinder-sting is exported, not decided
  });

  it('stops at the step limit', () => {
    const w = withFormulas('n = sum(entities, count(entities, count(entities) > 0))\n');
    const a = analyzeNumbers(w, { stepLimit: 500 });
    expect(a.byName.get('n')?.result).toMatchObject({ ok: false, error: { code: 'eval.steps' } });
    expect(analyzeNumbers(w).value('n')).toBe(23 * 23);
  });

  it('short-circuits and/or, and if evaluates one branch', () => {
    const w = withFormulas(
      'a = false and 1 / 0 > 1\nb = true or 1 / 0 > 1\nc = if(true, 1, 1 / 0)\n',
    );
    const a = analyzeNumbers(w);
    expect([a.value('a'), a.value('b'), a.value('c')]).toEqual([false, true, 1]);
  });

  it('graveyard entities are left out of collections', () => {
    const w = withFormulas('n = count(creatures)\n');
    expect(analyzeNumbers(w).value('n')).toBe(2); // reef-ray is in the graveyard
  });

  it('a function error appears at the function body', () => {
    const src = 'f(x) = 1 / x\ny = f(0)\n';
    const a = analyzeNumbers(withFormulas(src));
    const d = a.diagnostics.find((x) => x.code === 'eval.div_zero');
    expect(src.slice(d?.span.start, d?.span.end)).toBe('1 / x');
  });

  it('lists, strings and entities compare structurally', () => {
    const a = analyzeNumbers(
      withFormulas('a = [1, 2] == [1, 2]\nb = "x" != "y"\nc = none == none\nd = [1] == [1, 2]\n'),
    );
    expect([a.value('a'), a.value('b'), a.value('c'), a.value('d')]).toEqual([
      true,
      true,
      true,
      false,
    ]);
  });
});

describe('graph', () => {
  it('orders dependencies first and finds every cycle', () => {
    const edges = new Map([
      ['a', new Set(['b'])],
      ['b', new Set(['c'])],
      ['c', new Set<string>()],
      ['x', new Set(['y'])],
      ['y', new Set(['x'])],
      ['s', new Set(['s'])],
    ]);
    const g = buildGraph(['a', 'b', 'c', 'x', 'y', 's'], edges, () => ({ start: 0, end: 1 }));
    expect(g.order.indexOf('c')).toBeLessThan(g.order.indexOf('b'));
    expect(g.order.indexOf('b')).toBeLessThan(g.order.indexOf('a'));
    expect([...g.cyclic].sort()).toEqual(['s', 'x', 'y']);
    expect(g.diagnostics.map((d) => d.message)).toEqual(
      expect.arrayContaining(['x depends on itself: x → y → x', 's depends on itself']),
    );
    expect([...downstream(['c'], g.dependents)].sort()).toEqual(['a', 'b', 'c']);
  });

  it('handles long chains without recursion', () => {
    const names = Array.from({ length: 5000 }, (_, i) => `d${i}`);
    const edges = new Map(names.map((n, i) => [n, new Set(i > 0 ? [`d${i - 1}`] : [])]));
    const g = buildGraph(names, edges, () => undefined);
    expect(g.order[0]).toBe('d0');
    expect(g.cyclic.size).toBe(0);
  });
});

describe('types', () => {
  it('unifies, generalises and formats', () => {
    const u = new Unifier();
    const a = u.fresh();
    expect(u.unify(listOf(a), listOf(NUMBER))).toBeNull();
    expect(u.format(a)).toBe('number');
    expect(u.unify(NUMBER, STRING)).toBe('expected string, found number');
    const b = u.fresh();
    expect(u.unify(b, listOf(b))).toMatch(/itself/);
    expect(u.unify(entityOf('band'), entityOf('item'))).toBe('expected a item, found a band');
    expect(u.unify(entityOf(null), entityOf('item'))).toBeNull();
    const k = { t: 'entity' as const, kind: u.freshKind() };
    expect(u.unify(k, entityOf('creature'))).toBeNull();
    expect(u.format(k)).toBe('creature');
    const v = u.fresh();
    const s = u.generalize([v], v);
    expect(formatScheme(s)).toBe('(any) → any');
    const i = u.instantiate(s);
    expect(u.unify(i.result, BOOL)).toBeNull();
    expect(formatType(listOf(entityOf('item')))).toBe('list of item');
    expect(annotationType('thing', u)).toBeNull();
    expect(annotationType('list', u)?.t).toBe('list');
    expect(annotationType('entity', u)?.t).toBe('entity');
  });
});

describe('placement adapter', () => {
  it('orders bands by y_bottom, gives tiers from Y 0, and places through the resolver', () => {
    const w = sampleWorld();
    expect(bandOrder(w).map((b) => b.id)).toEqual([
      'undercroft',
      'hollows',
      'groundline',
      'low-sky',
      'high-drift',
    ]);
    const p = resolvedPlacement(w);
    expect(p.get('groundline')).toMatchObject({ band: 'groundline', tier: 0 });
    expect(p.get('undercroft')?.tier).toBe(-2);
    expect(p.get('glowmoss-caverns')).toMatchObject({ band: 'hollows', tier: -1 });
    expect(p.get('spore-shrine')).toMatchObject({ band: 'hollows', inferred: false }); // pinned to its biome
    expect(p.get('glide')).toMatchObject({ band: 'low-sky', tier: 1, inferred: false });
    // Inferred by the resolver: an item made from a material found in Low Sky.
    const anklet = resolvePlacement(w)['cloud-anklet']!;
    expect(p.get('cloud-anklet')).toMatchObject({
      band: anklet.bands[0] ?? null,
      inferred: anklet.mode === 'inferred',
    });
  });
});

const CURVE: Curve = {
  id: 'defense',
  y: 'band_defense(x)',
  over: { axis: 'band' },
  dots: { query: 'items where subkind == "armor"', value: '.defense' },
};

describe('curves', () => {
  const world = (): World => {
    let w = withFormulas(
      'band_defense(b: band) = sum(items where subkind == "armor" and band == b, .defense)\n',
    );
    w = run(
      w,
      cmd('relation.add', { from: 'vent-glass-visor', type: 'in_band', to: 'hollows' }),
      cmd('numbers.putCurve', { curve: CURVE }),
    );
    return w;
  };

  it('samples a formula over the bands, with entities as dots', () => {
    const w = world();
    const s = sampleCurve(analyzeNumbers(w), w, CURVE);
    expect(s.problems).toEqual([]);
    expect(s.ticks.map((t) => t.label)).toEqual([
      'Undercroft',
      'Hollows',
      'Groundline',
      'Low Sky',
      'High Drift',
    ]);
    expect(s.line.map((p) => p.y)).toEqual([0, 4, 0, 0, 0]);
    expect(s.dots).toEqual([{ entity: 'vent-glass-visor', name: 'Vent Glass Visor', x: 1, y: 4 }]);
  });

  it('compares dots with the intent curve', () => {
    let w = world();
    w = run(
      w,
      cmd('numbers.setIntent', {
        id: 'defense',
        points: [
          { x: 'undercroft', y: 2 },
          { x: 'high-drift', y: 30 },
        ],
      }),
    );
    const curve = w.numbers.curves?.[0] as Curve;
    const a = analyzeNumbers(w);
    const s = sampleCurve(a, w, curve);
    expect(s.intent).toEqual([
      { x: 0, y: 2 },
      { x: 4, y: 30 },
    ]);
    expect(s.dots[0]).toMatchObject({ intent: 9, off: true });
    expect(s.dots[0]?.deviation).toBeCloseTo(-5 / 9);
    expect(intentDeviations(a, w)).toEqual([
      {
        curve: 'defense',
        entity: 'vent-glass-visor',
        value: 4,
        intent: 9,
        deviation: s.dots[0]?.deviation,
        tolerance: 0.25,
      },
    ]);
  });

  it('works over tiers and attribute ranges', () => {
    const w = withFormulas('taken(raw, def) = raw * k / (k + def)\n');
    const a = analyzeNumbers(w);
    const tier: Curve = { id: 't', y: 'x * 10', over: { axis: 'tier' }, dots: { query: 'bands' } };
    const st = sampleCurve(a, w, tier);
    expect(st.ticks.map((t) => t.x)).toEqual([-2, -1, 0, 1, 2]);
    expect(st.dots.map((d) => [d.entity, d.y])).toContainEqual(['low-sky', 10]);
    const attr: Curve = {
      id: 'a',
      y: 'taken(20, x)',
      over: { axis: 'attribute', kind: 'item', key: 'defense', min: 0, max: 100 },
      dots: { query: 'items where subkind == "armor"' },
    };
    const sa = sampleCurve(a, w, attr);
    expect(sa.line[0]).toEqual({ x: 0, y: 20 });
    expect(sa.line[sa.line.length - 1]).toEqual({ x: 100, y: 10 });
    expect(sa.dots[0]).toMatchObject({ entity: 'vent-glass-visor', x: 4 });
    expect(initialIntent(sa, attr.over).length).toBe(5);
    expect(storedIntentX(1, st.ticks, tier.over)).toBe(1);
  });

  it('reports problems per part', () => {
    const w = sampleWorld();
    const a = analyzeNumbers(w);
    const s = sampleCurve(a, w, {
      id: 'x',
      y: 'x.name',
      over: { axis: 'band' },
      dots: { query: '1', value: '"a"' },
    });
    expect(s.problems.map((p) => [p.part, p.diagnostic.code])).toEqual([
      ['y', 'curve.type'],
      ['query', 'curve.query'],
      ['value', 'curve.value'],
    ]);
    const r = sampleCurve(a, w, {
      id: 'r',
      y: '1 / (x - x)',
      over: { axis: 'tier' },
      dots: { query: 'items where tier > 5' },
    });
    expect(r.problems.map((p) => p.diagnostic.code)).toEqual(['eval.div_zero', 'eval.unplaced']);
  });

  it('intent helpers', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 10, y: 100 },
    ];
    expect([intentAt(pts, -5), intentAt(pts, 5), intentAt(pts, 50), intentAt([], 1)]).toEqual([
      0,
      50,
      100,
      null,
    ]);
    expect(deviation(5, 0)).toBe(5);
    expect(niceTicks(0, 100, 5)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(niceTicks(3, 3, 5)).toEqual([3]);
    expect([roundNice(12.3456), roundNice(0), roundNice(Infinity)]).toEqual([12.3, 0, 0]);
    expect(
      axisTicks(sampleWorld(), { axis: 'attribute', kind: 'item', key: 'defense', min: 0, max: 0 })
        .domain,
    ).toEqual([0, 1]);
    expect(
      intentPoints(
        [
          { x: 'gone', y: 1 },
          { x: 3, y: 1 },
        ],
        [],
        { axis: 'band' },
      ),
    ).toEqual([]);
  });
});

describe('commands', () => {
  it('curves: put, replace, intent, remove; persisted in numbers/curves.json', () => {
    let w = run(sampleWorld(), cmd('numbers.putCurve', { curve: CURVE }));
    expect(w.numbers.curves).toEqual([CURVE]);
    const next = { ...CURVE, y: 'band_defense(x) * 2' };
    const r = applyCommand(w, cmd('numbers.putCurve', { curve: next }), ctx);
    expect(r.ok && r.value.world.numbers.curves).toEqual([next]);
    w = run(w, cmd('numbers.setIntent', { id: 'defense', points: [{ x: 'hollows', y: 5 }] }));
    expect(w.numbers.curves?.[0]?.intent).toEqual([{ x: 'hollows', y: 5 }]);
    const files = worldToFiles(w);
    expect(JSON.parse(files.get('numbers/curves.json') ?? '[]')).toEqual(w.numbers.curves);
    expect(worldFromFiles(files).world.numbers.curves).toEqual(w.numbers.curves);
    const removed = applyCommand(w, cmd('numbers.removeCurve', { id: 'defense' }), ctx);
    expect(removed.ok && removed.value.world.numbers.curves).toEqual([]);
    if (removed.ok) {
      const ch = filesForPatch(w, removed.value.world, removed.value.patch);
      expect(ch.write.get('numbers/curves.json')).toBe('[]\n');
      // and the inverse restores exactly
      expect(applyPatch(removed.value.world, removed.value.inverse)).toEqual(w);
    }
    const unset = applyCommand(w, cmd('numbers.setIntent', { id: 'defense', points: null }), ctx);
    expect(unset.ok && unset.value.world.numbers.curves?.[0]?.intent).toBeUndefined();
    for (const c of [
      cmd('numbers.removeCurve', { id: 'nope' }),
      cmd('numbers.setIntent', { id: 'nope', points: [] }),
      cmd('numbers.putCurve', {
        curve: {
          id: 'z',
          y: 'x',
          over: { axis: 'attribute', kind: 'item', key: 'defense', min: 5, max: 5 },
        },
      }),
      cmd('numbers.putCurve', { curve: { id: 'Bad Id', y: 'x', over: { axis: 'tier' } } }),
    ])
      expect(applyCommand(w, c, ctx).ok).toBe(false);
  });

  it('a world without curves writes no curves file, and removing the last key removes it', () => {
    const w = sampleWorld();
    expect(worldToFiles(w).has('numbers/curves.json')).toBe(false);
    const after: World = { ...w, numbers: { ...w.numbers, curves: [CURVE] } };
    const back = {
      ...after,
      numbers: { variables: after.numbers.variables, formulas: after.numbers.formulas },
    };
    expect(
      filesForPatch(after, back, [{ op: 'remove', path: ['numbers', 'curves'] }]).remove,
    ).toEqual(['numbers/curves.json']);
    const bad = worldFromFiles(new Map([['numbers/curves.json', '[{"id": 1}]']]));
    expect(bad.issues[0]?.path).toBe('numbers/curves.json');
  });

  it('removes attribute definitions from schema.json', () => {
    let w = run(
      sampleWorld(),
      cmd('schema.setAttributeDef', { kind: 'creature', def: { key: 'health', min: 0 } }),
    );
    expect(w.schema.kinds.creature?.attributes?.map((a) => a.key)).toEqual(['health']);
    w = run(w, cmd('numbers.removeAttributeDef', { kind: 'creature', key: 'health' }));
    expect(w.schema.kinds.creature).toBeUndefined();
    let w2 = run(
      sampleWorld(),
      cmd('schema.setKind', { kind: 'item', override: { label: 'Thing' } }),
    );
    w2 = run(
      w2,
      cmd('schema.setAttributeDef', { kind: 'item', def: { key: 'weight' } }),
      cmd('schema.setAttributeDef', { kind: 'item', def: { key: 'bulk' } }),
    );
    w2 = run(w2, cmd('numbers.removeAttributeDef', { kind: 'item', key: 'weight' }));
    expect(w2.schema.kinds.item).toEqual({ label: 'Thing', attributes: [{ key: 'bulk' }] });
    w2 = run(w2, cmd('numbers.removeAttributeDef', { kind: 'item', key: 'bulk' }));
    expect(w2.schema.kinds.item).toEqual({ label: 'Thing' });
    expect(
      applyCommand(w2, cmd('numbers.removeAttributeDef', { kind: 'item', key: 'nope' }), ctx).ok,
    ).toBe(false);
  });

  it('renames a variable and only the references that resolve to it', () => {
    let w = withFormulas(
      'a = k + 1\nf(k) = k * 2\ng(x) = count(items where x > k)\n# k stays in comments\n',
    );
    w = run(
      w,
      cmd('numbers.putCurve', {
        curve: {
          id: 'c',
          y: 'x * k',
          over: { axis: 'tier' },
          dots: { query: 'bands where tier < k', value: 'k' },
        },
      }),
    );
    w = run(w, cmd('numbers.renameVariable', { from: 'k', to: 'scale' }));
    expect(w.numbers.variables).toEqual({ scale: 100, base_health: 100 });
    expect(w.numbers.formulas).toBe(
      'a = scale + 1\nf(k) = k * 2\ng(x) = count(items where x > scale)\n# k stays in comments\n',
    );
    expect(w.numbers.curves?.[0]).toMatchObject({
      y: 'x * scale',
      dots: { query: 'bands where tier < scale', value: 'scale' },
    });
    expect(Object.keys(w.numbers.variables)).toEqual(['scale', 'base_health']); // order kept
    expect(analyzeNumbers(w).value('a')).toBe(101);
  });

  it('refuses renames that collide or would be captured', () => {
    const w = withFormulas('a = k + 1\nf(scale) = scale + k\nbase = 1\n');
    const r = (from: string, to: string): string | undefined => {
      const x = applyCommand(w, cmd('numbers.renameVariable', { from, to }), ctx);
      return x.ok ? undefined : x.error.code;
    };
    expect(r('k', 'scale')).toBe('variable.capture');
    expect(r('k', 'base_health')).toBe('variable.exists');
    expect(r('k', 'base')).toBe('variable.exists');
    expect(r('k', 'sum')).toBe('variable.name');
    expect(r('nope', 'x')).toBe('variable.not_found');
    expect(r('k', 'k')).toBeUndefined();
  });
});

describe('API for other packages', () => {
  const src =
    'taken(raw, def) = raw * k / (k + def)\nhit = taken(20, sum(items where subkind == "armor", .defense))\nhp = base_health\nbroken = 1 / 0\nunrelated = 2\n';

  it('relevantFormulas: what reads an entity, what uses that, and what it uses', () => {
    const w = withFormulas(src);
    const a = analyzeNumbers(w);
    expect(relevantFormulas(a, w, 'vent-glass-visor').map((f) => f.name)).toEqual(['taken', 'hit']);
    expect(relevantFormulas(a, w, 'nope')).toEqual([]);
    expect(summarize(a, w, 'hit')).toEqual({
      name: 'hit',
      text: 'hit = taken(20, sum(items where subkind == "armor", .defense))',
      type: 'number',
      value: '19.2308',
      plain: (100 * 20) / 104,
      line: 2,
    });
    expect(summarize(a, w, 'broken')?.error).toBe('Division by zero');
    expect(summarize(a, w, 'nope')).toBeUndefined();
    expect(allFormulas(a, w).map((f) => f.name)).toEqual([
      'taken',
      'hit',
      'hp',
      'broken',
      'unrelated',
    ]);
  });

  it('formulaErrors: stable ids with lines and columns', () => {
    const a = analyzeNumbers(withFormulas(src + 'oops = nope\n'));
    expect(formulaErrors(a)).toEqual([
      {
        id: 'numbers:eval.div_zero:broken:4',
        code: 'eval.div_zero',
        message: 'Division by zero',
        hint: 'Guard it, like  if(d == 0, 0, n / d)',
        def: 'broken',
        line: 4,
        col: 10,
        severity: 'error',
      },
      expect.objectContaining({ id: 'numbers:name.unknown:oops:6', line: 6, col: 8 }),
    ]);
  });

  it('compileExpression evaluates against the program, with bindings and an element', () => {
    const w = withFormulas(src);
    const a = analyzeNumbers(w);
    const c = compileExpression(a, 'taken(x, 0) + hit', { x: NUMBER });
    expect(c.ok).toBe(true);
    expect(c.type).toBe('number');
    expect(c.run({ x: 3 })).toEqual({ ok: true, value: 3 + (100 * 20) / 104 });
    const el = compileExpression(a, '.name', {}, entityOf('band'));
    expect(el.run({}, entityRef('hollows'))).toEqual({ ok: true, value: 'Hollows' });
    const bad = compileExpression(a, 'broken + 1');
    expect(bad.ok).toBe(false);
    expect(bad.run().ok).toBe(false);
    expect(compileExpression(a, '').diagnostics[0]?.code).toBe('parse.empty');
  });

  it('values: formatting, plain forms and types', () => {
    const w = sampleWorld();
    expect([
      formatNumber(0.1 + 0.2),
      formatNumber(-3),
      formatNumber(Infinity),
      formatNumber(-Infinity),
      formatNumber(NaN),
    ]).toEqual(['0.3', '−3', '∞', '−∞', 'NaN']);
    expect(formatValue(listValue([1, 2, 3, 4]), { maxItems: 2 })).toBe('[1, 2, … 2 more]');
    expect(formatValue(entityRef(null))).toBe('none');
    expect(formatValue(true)).toBe('true');
    expect(toPlain(listValue([entityRef('a'), Infinity, 'x']))).toEqual([
      { entity: 'a' },
      'Infinity',
      'x',
    ]);
    expect(valueEquals(listValue([1]), entityRef('a'))).toBe(false);
    expect(formatType(typeOfValue(listValue([entityRef('hollows')]), w))).toBe('list of band');
    expect(formatType(typeOfValue(listValue([]), w))).toBe('list of number');
    expect([typeOfValue('a', w), typeOfValue(true, w)]).toEqual([STRING, BOOL]);
  });

  it('spans helpers', () => {
    expect(lineCol('ab\ncd', 4)).toEqual({ line: 2, col: 2 });
    expect(lineStarts('a\nb\n')).toEqual([0, 2, 4]);
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(closest('defence', ['defense', 'damage'])).toBe('defense');
    expect(closest('zzz', ['defense'])).toBeUndefined();
  });

  it('the engine reuses its analysis for the same world object', () => {
    const w = withFormulas(src);
    const e = new NumbersEngine();
    const a = e.update(w);
    expect(e.update(w)).toBe(a);
    expect(e.analysis).toBe(a);
  });
});
