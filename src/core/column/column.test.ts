import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import { LANES } from '../model/kinds';
import { validateWorld } from '../model/validate';
import type { World } from '../model/world';
import { sampleWorld } from '../testing/sample';
import { columnModel, type ColumnModel } from './model';
import { at, normalize, side, step, stopsOf, type NavContext } from './cursor';
import {
  clampEdge,
  createBandCommand,
  drawnBandSpan,
  edgeLimits,
  edgesOf,
  moveEdgeCommands,
  newBandSpan,
  nudge,
} from './edges';
import {
  applyLayout,
  columnSettings,
  currentLayout,
  deleteLayout,
  moveLane,
  saveLayout,
  setGraveyard,
  toggleLane,
} from './lanes';
import {
  bandSpan,
  bandSpans,
  cellIndex,
  cellKey,
  CELL_PAD,
  CHIP_H,
  fitText,
  frameOf,
  INBOX_ROW,
  layoutCell,
  pxOfY,
  rowsOf,
  stackMargin,
  type BandSpan,
  type CellEntity,
} from './layout';
import { placementOf, placementsOf } from './placement';
import { formatY, fromU, LINEAR, snapY, ticks, toU } from './scale';
import { stressWorld } from '../testing/stress';

const ctx = { now: '2026-11-02T00:00:00.000Z' };
const measure = (s: string): number => s.length * 6.5;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('scale', () => {
  it('is symmetric, monotonic and invertible', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e9, max: 1e9, noNaN: true }), (y) => {
        expect(toU(-y)).toBeCloseTo(-toU(y), 9);
        expect(fromU(toU(y))).toBeCloseTo(y, Math.abs(y) > 1e6 ? 0 : 6);
      }),
    );
    fc.assert(
      fc.property(
        fc.double({ min: -1e9, max: 1e9, noNaN: true }),
        fc.double({ min: -1e9, max: 1e9, noNaN: true }),
        (a, b) => {
          if (a < b) expect(toU(a)).toBeLessThanOrEqual(toU(b));
          if (Math.round(a) < Math.round(b))
            expect(toU(Math.round(a))).toBeLessThan(toU(Math.round(b)));
        },
      ),
    );
  });

  it('is linear near 0 and a decade per unit far away', () => {
    expect(toU(0)).toBe(0);
    expect(toU(LINEAR * 9)).toBeCloseTo(1, 9);
    expect(toU(LINEAR * 99) - toU(LINEAR * 9)).toBeCloseTo(1, 9);
    expect(toU(Infinity)).toBe(Infinity);
    expect(fromU(-Infinity)).toBe(-Infinity);
  });

  it('formats heights in mono-friendly form', () => {
    expect(formatY(0)).toBe('0');
    expect(formatY(-512)).toBe('−512');
    expect(formatY(1200)).toBe('1.2k');
    expect(formatY(40000)).toBe('40k');
    expect(formatY(3_000_000)).toBe('3M');
    expect(formatY(Infinity)).toBe('+∞');
    expect(formatY(-Infinity)).toBe('−∞');
  });

  it('labels only decade boundaries, keeps ticks apart, and skips 0', () => {
    const ts = ticks(-4, 4, 200);
    expect(ts.some((t) => t.y === 0)).toBe(false);
    for (const t of ts) if (t.label) expect(t.major).toBe(true);
    for (const t of ts) if (t.major) expect(Math.log10(Math.abs(t.y)) % 1).toBeCloseTo(0, 9);
    expect(ts.filter((t) => t.label).map((t) => t.label)).toContain('1k');
    expect(ts.filter((t) => t.label).map((t) => t.label)).toContain('−100');
    // Sorted top to bottom, within the range.
    for (let i = 1; i < ts.length; i++) expect(ts[i - 1]!.u).toBeGreaterThan(ts[i]!.u);
    for (const t of ts) expect(Math.abs(t.u)).toBeLessThanOrEqual(4);
  });

  it('snaps to two significant digits and integers near 0', () => {
    expect(snapY(96.4)).toBe(96);
    expect(snapY(1234)).toBe(1200);
    expect(snapY(-517)).toBe(-520);
    expect(snapY(3.4)).toBe(3);
    fc.assert(
      fc.property(fc.double({ min: -1e7, max: 1e7, noNaN: true }), (y) => {
        const s = snapY(y);
        expect(Math.abs(s - y)).toBeLessThanOrEqual(Math.max(0.5, Math.abs(y) * 0.06));
        expect(snapY(s)).toBe(s);
      }),
    );
  });
});

describe('placement (local adapter)', () => {
  const w = sampleWorld();
  it('places explicit bands and biomes without marking them inferred', () => {
    expect(placementOf(w, 'glowmoss-caverns')).toEqual({
      places: [{ band: 'hollows', biome: 'glowmoss-caverns' }],
      inferred: false,
    });
    expect(placementOf(w, 'glide')).toEqual({ places: [{ band: 'low-sky' }], inferred: false });
    expect(placementOf(w, 'spore-shrine')).toEqual({
      places: [{ band: 'hollows', biome: 'glowmoss-caverns' }],
      inferred: false,
    });
    expect(placementOf(w, 'hollows')).toEqual({ places: [{ band: 'hollows' }], inferred: false });
  });
  it('infers through found_in, lives_in, made_from, requires and unlocks', () => {
    expect(placementOf(w, 'lumen-spore')).toMatchObject({
      inferred: true,
      places: [{ band: 'hollows' }],
    });
    expect(placementOf(w, 'cinder-wasp')).toMatchObject({
      inferred: true,
      places: [{ band: 'hollows', biome: 'ash-vents' }],
    });
    expect(placementOf(w, 'vent-glass-visor')).toMatchObject({ inferred: true, via: 'vent-glass' });
    expect(placementOf(w, 'fourth-accessory-slot')).toMatchObject({
      inferred: true,
      via: 'first-descent',
      places: [{ band: 'hollows' }],
    });
  });
  it('leaves the rest for the Inbox', () => {
    expect(placementOf(w, 'sky-coral')).toEqual({ places: [], inferred: false });
    expect(placementOf(w, 'nope')).toEqual({ places: [], inferred: false });
  });
  it('agrees with placementsOf and is deterministic', () => {
    const all = placementsOf(w);
    for (const id of Object.keys(w.entities)) expect(all.get(id)).toEqual(placementOf(w, id));
    expect(placementsOf(sampleWorld())).toEqual(all);
  });
  it('survives cycles of inference', () => {
    const r = applyCommands(
      w,
      [
        cmd('entity.create', { kind: 'item', id: 'a1', name: 'A', fields: { subkind: 'tool' } }),
        cmd('entity.create', {
          kind: 'item',
          id: 'b1',
          name: 'B',
          fields: { subkind: 'tool' },
          relations: [{ type: 'requires', target: 'a1' }],
        }),
        cmd('relation.add', { from: 'a1', type: 'requires', to: 'b1' }),
      ],
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(placementOf(r.value.world, 'a1').places).toEqual([]);
  });
});

const span = (id: string, bottom: number, top: number): BandSpan => ({
  id,
  name: id,
  state: 'idea',
  bottom,
  top,
});

describe('rows', () => {
  it('reads the sample bands top to bottom with no gaps', () => {
    const rows = rowsOf(bandSpans(sampleWorld()));
    expect(rows.map((r) => r.key)).toEqual([
      'high-drift',
      'low-sky',
      'groundline',
      'hollows',
      'undercroft',
    ]);
  });

  it('hatches every height no band covers, including the endless ends', () => {
    const rows = rowsOf([span('a', 100, 200), span('b', -50, 0)]);
    expect(rows.map((r) => [r.kind, r.top, r.bottom])).toEqual([
      ['gap', Infinity, 200],
      ['band', 200, 100],
      ['gap', 100, 0],
      ['band', 0, -50],
      ['gap', -50, -Infinity],
    ]);
    expect(rowsOf([]).map((r) => [r.kind, r.top, r.bottom])).toEqual([
      ['gap', Infinity, -Infinity],
    ]);
  });

  it('covers the whole axis: gaps exactly fill what bands leave (property)', () => {
    const bandsArb = fc
      .array(fc.tuple(fc.integer({ min: -5000, max: 5000 }), fc.integer({ min: 1, max: 3000 })), {
        maxLength: 8,
      })
      .map((xs) => xs.map(([b, h], i) => span(`b${i}`, b, b + h)));
    fc.assert(
      fc.property(bandsArb, fc.integer({ min: -9000, max: 9000 }), (bands, y) => {
        const sorted = [...bands].sort((a, b) => b.top - a.top || b.bottom - a.bottom);
        const rows = rowsOf(sorted);
        const inBand = bands.some((b) => y >= b.bottom && y <= b.top);
        const inGap = rows.some((r) => r.kind === 'gap' && y > r.bottom && y < r.top);
        if (!inBand) expect(inGap).toBe(true);
        for (const g of rows.filter((r) => r.kind === 'gap'))
          for (const b of bands) expect(g.bottom >= b.top || g.top <= b.bottom).toBe(true);
        for (let i = 1; i < rows.length; i++)
          expect(rows[i - 1]!.top).toBeGreaterThanOrEqual(rows[i]!.top);
      }),
    );
  });

  it('skips bands without usable edges', () => {
    const w = sampleWorld();
    const e = { ...w.entities['high-drift']!, fields: {} };
    expect(bandSpan(e)).toBeNull();
    expect(bandSpan({ ...e, fields: { y_bottom: 5, y_top: 5 } })).toBeNull();
    expect(bandSpan({ ...e, fields: { y_bottom: 9, y_top: 5 } })).toMatchObject({
      bottom: 5,
      top: 9,
    });
    expect(bandSpan(w.entities['glide']!)).toBeNull();
  });
});

describe('frame', () => {
  it('maps heights to content px, top down, clamping the endless ends', () => {
    const f = frameOf(bandSpans(sampleWorld()), 200);
    expect(pxOfY(f, Infinity)).toBe(0);
    expect(pxOfY(f, -Infinity)).toBeLessThanOrEqual(f.height);
    expect(pxOfY(f, -Infinity)).toBeGreaterThan(f.height - 1);
    expect(pxOfY(f, 640)).toBeLessThan(pxOfY(f, 0));
    expect(pxOfY(f, 0)).toBeLessThan(pxOfY(f, -512));
    const empty = frameOf([], 100);
    expect(empty.uHi).toBeGreaterThan(1);
    expect(empty.uLo).toBeLessThan(-1);
  });
});

describe('cells', () => {
  const w = sampleWorld();
  it('puts entities in their band and lane, unplaced ones in the Inbox', () => {
    const idx = cellIndex(w, placementsOf(w), { graveyard: true });
    expect(idx.cells.get(cellKey('hollows', 'materials'))?.map((c) => c.id)).toEqual([
      'lumen-spore',
      'vent-glass',
    ]);
    expect(idx.cells.get(cellKey('hollows', 'materials'))?.every((c) => c.inferred)).toBe(true);
    expect(idx.cells.get(cellKey(INBOX_ROW, 'materials'))?.map((c) => c.id)).toEqual(['sky-coral']);
    expect(idx.cells.get(cellKey('low-sky', 'capabilities'))?.map((c) => c.id)).toEqual(['glide']);
    expect(idx.cells.get(cellKey('low-sky', 'creatures'))?.map((c) => c.id)).toEqual(['reef-ray']);
    expect(idx.unplacedBands).toEqual([]);
  });
  it('hides the graveyard when asked', () => {
    const idx = cellIndex(w, placementsOf(w), { graveyard: false });
    expect(idx.cells.get(cellKey('low-sky', 'creatures'))).toBeUndefined();
  });
  it('groups items by subkind, then orders by state and name', () => {
    const idx = cellIndex(w, placementsOf(w), { graveyard: true });
    const items = idx.cells.get(cellKey('hollows', 'items'))!;
    const groups = items.map((c) => c.group);
    const order = ['armor', 'accessory', 'tool', 'weapon', 'consumable'];
    for (let i = 1; i < groups.length; i++)
      expect(order.indexOf(groups[i]!)).toBeGreaterThanOrEqual(order.indexOf(groups[i - 1]!));
  });
});

const ce = (id: string, name = id, group = ''): CellEntity => ({
  id,
  name,
  state: 'idea',
  inferred: false,
  group,
});

describe('layoutCell', () => {
  it('packs chips in lines inside the cell', () => {
    const rect = { x: 10, y: 100, w: 200, h: 200 };
    const l = layoutCell(
      rect,
      [ce('a', 'Alpha'), ce('b', 'Beta'), ce('c', 'A rather long name indeed')],
      measure,
    );
    expect(l.hidden).toEqual([]);
    expect(l.more).toBeNull();
    for (const g of l.glyphs) {
      expect(g.x).toBeGreaterThanOrEqual(rect.x);
      expect(g.x + g.w).toBeLessThanOrEqual(rect.x + rect.w);
      expect(g.y).toBeGreaterThanOrEqual(rect.y);
      expect(g.y + g.h).toBeLessThanOrEqual(rect.y + rect.h);
    }
  });

  it('starts a new line for each item subkind', () => {
    const l = layoutCell(
      { x: 0, y: 0, w: 400, h: 200 },
      [ce('a', 'A', 'armor'), ce('b', 'B', 'tool')],
      measure,
    );
    expect(l.glyphs[1]!.y).toBeGreaterThan(l.glyphs[0]!.y);
  });

  it('counts what does not fit on a +N chip', () => {
    const many = Array.from({ length: 30 }, (_, i) => ce(`e${i}`, `Entity ${i}`));
    const l = layoutCell({ x: 0, y: 0, w: 220, h: 60 }, many, measure);
    expect(l.more).not.toBeNull();
    expect(l.more!.count).toBe(l.hidden.length);
    expect(l.glyphs.length + l.hidden.length).toBe(30);
    expect(l.more!.x + l.more!.w).toBeLessThanOrEqual(220);
  });

  it('never overlaps glyphs and accounts for every entity (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 40 }),
        fc.integer({ min: 20, max: 500 }),
        fc.integer({ min: 0, max: 400 }),
        fc.boolean(),
        (names, w, h, bottom) => {
          const es = names.map((n, i) => ce(`e${i}`, n, i % 3 === 0 ? 'armor' : 'tool'));
          const rect = { x: 0, y: 0, w, h };
          const l = layoutCell(rect, es, measure, bottom);
          expect(l.glyphs.length + l.hidden.length).toBe(es.length);
          const boxes = [...l.glyphs, ...(l.more ? [l.more] : [])];
          for (const g of boxes) {
            expect(g.x + g.w).toBeLessThanOrEqual(rect.x + rect.w + 0.001);
            expect(g.y + g.h).toBeLessThanOrEqual(Math.max(rect.y + rect.h, CHIP_H + 12) + 0.001);
          }
          for (let i = 0; i < boxes.length; i++)
            for (let j = i + 1; j < boxes.length; j++) {
              const a = boxes[i]!;
              const b = boxes[j]!;
              const apart =
                a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
              expect(apart).toBe(true);
            }
        },
      ),
    );
  });

  it('keeps a name beside the +N chip in a one-line cell, shrinking it', () => {
    const many = Array.from({ length: 8 }, (_, i) => ce(`e${i}`, `A long entity name ${i}`));
    const l = layoutCell({ x: 0, y: 0, w: 100, h: 30 }, many, measure);
    expect(l.glyphs.length).toBe(1);
    expect(l.glyphs[0]!.text.endsWith('…')).toBe(true);
    expect(l.more?.count).toBe(7);
  });

  it('aligns to the bottom for endless-sky bands', () => {
    const l = layoutCell({ x: 0, y: 0, w: 200, h: 300 }, [ce('a')], measure, true);
    expect(l.glyphs[0]!.y + CHIP_H).toBeCloseTo(300 - CELL_PAD, 5);
  });

  it('truncates names with an ellipsis to fit', () => {
    expect(fitText('Short', 100, measure)).toBe('Short');
    const t = fitText('A very long entity name', 60, measure);
    expect(t.endsWith('…')).toBe(true);
    expect(measure(t)).toBeLessThanOrEqual(60);
    expect(fitText('Anything', 2, measure)).toBe('');
  });

  it('never cuts a character or a grapheme in half (property)', () => {
    // Astral characters (two UTF-16 units), combining marks and ZWJ sequences.
    const pieces = ['a', 'é', 'e\u0301', '🜂', '𝔄', '👩‍🚀', '🇯🇵', '漢', ' '];
    const graphemes = (s: string): string[] =>
      [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(s)].map((x) => x.segment);
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...pieces), { minLength: 1, maxLength: 30 }),
        fc.integer({ min: 0, max: 200 }),
        (parts, max) => {
          const name = parts.join('');
          const t = fitText(name, max, measure);
          expect(t).not.toMatch(LONE_SURROGATE);
          const kept = t.endsWith('…') ? t.slice(0, -1) : t;
          // What's kept is a run of whole graphemes from the start of the name.
          const g = graphemes(name);
          const prefixes = g.map((_, k) =>
            g
              .slice(0, k + 1)
              .join('')
              .trimEnd(),
          );
          expect(t === name || kept === '' || prefixes.includes(kept)).toBe(true);
        },
      ),
    );
    expect(fitText('👩‍🚀👩‍🚀👩‍🚀👩‍🚀👩‍🚀', 40, measure)).not.toMatch(/\u200d…$/);
  });
});

describe('stackMargin', () => {
  it('keeps notes at their heights and pushes overlaps down, in input order (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 2000 }), fc.integer({ min: 10, max: 80 })), {
          maxLength: 20,
        }),
        (xs) => {
          const items = xs.map(([want, height], i) => ({ id: `n${i}`, want, height }));
          const tops = stackMargin(items, 6);
          items.forEach((it, i) => expect(tops[i]).toBeGreaterThanOrEqual(it.want));
          const sorted = items
            .map((it, i) => ({ top: tops[i]!, h: it.height }))
            .sort((a, b) => a.top - b.top);
          for (let i = 1; i < sorted.length; i++)
            expect(sorted[i]!.top).toBeGreaterThanOrEqual(
              sorted[i - 1]!.top + sorted[i - 1]!.h + 6,
            );
        },
      ),
    );
  });
});

describe('cursor', () => {
  const cells: Record<string, string[]> = {
    'a|0': ['x', 'y'],
    'b|0': [],
    'c|0': ['z'],
    'a|1': ['p'],
    'c|1': ['q', 'r', 's'],
    'a|-1': ['a'],
    'c|-1': ['c'],
  };
  const nav: NavContext = {
    rows: ['a', 'b', 'c'],
    laneCount: 2,
    entitiesAt: (r, l) => cells[`${r}|${l}`] ?? [],
  };

  it('walks down and up through entities and empty cells', () => {
    let c = at(nav, 'a', 0);
    expect(c).toEqual({ row: 'a', lane: 0, entity: 'x' });
    const seen = [c.entity ?? c.row];
    for (let i = 0; i < 5; i++) {
      c = step(nav, c, 1);
      seen.push(c.entity ?? c.row);
    }
    expect(seen).toEqual(['x', 'y', 'b', 'z', 'z', 'z']);
    c = step(nav, c, -1);
    expect(c).toEqual({ row: 'b', lane: 0, entity: null });
  });

  it('changes lane keeping the row and the position within the cell', () => {
    const c = side(nav, { row: 'c', lane: 1, entity: 'r' }, -1);
    expect(c).toEqual({ row: 'c', lane: 0, entity: 'z' });
    expect(side(nav, c, -1)).toEqual({ row: 'c', lane: -1, entity: 'c' });
    expect(side(nav, { row: 'c', lane: -1, entity: 'c' }, -1)).toEqual({
      row: 'c',
      lane: -1,
      entity: 'c',
    });
    expect(side(nav, { row: 'b', lane: 0, entity: null }, 1)).toEqual({
      row: 'b',
      lane: 1,
      entity: null,
    });
  });

  it('normalizes a stale cursor', () => {
    expect(normalize(nav, { row: 'gone', lane: 9, entity: 'gone' }, 'c')).toEqual({
      row: 'c',
      lane: 1,
      entity: 'q',
    });
    expect(normalize(nav, { row: 'a', lane: 0, entity: 'nope' })).toEqual({
      row: 'a',
      lane: 0,
      entity: 'x',
    });
  });

  it('visits every stop exactly once going down (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.constantFrom('e1', 'e2', 'e3'), { maxLength: 3 }), {
          minLength: 1,
          maxLength: 6,
        }),
        (rowsCells) => {
          const rows = rowsCells.map((_, i) => `r${i}`);
          const ids = rowsCells.map((es, i) => [...new Set(es)].map((e) => `${e}-${i}`));
          const n: NavContext = {
            rows,
            laneCount: 1,
            entitiesAt: (r) => ids[rows.indexOf(r)] ?? [],
          };
          const stops = stopsOf(n, 0);
          let c = at(n, rows[0]!, 0);
          const visited = [c];
          for (let i = 1; i < stops.length; i++) visited.push((c = step(n, c, 1)));
          expect(visited.map((v) => `${v.row}/${v.entity}`)).toEqual(
            stops.map((s) => `${s.row}/${s.entity}`),
          );
        },
      ),
    );
  });
});

describe('edges', () => {
  const bands = bandSpans(sampleWorld());
  it('shares an edge between touching bands', () => {
    const es = edgesOf(bands);
    expect(es.map((e) => [e.y, e.above, e.below])).toEqual([
      [640, 'high-drift', 'low-sky'],
      [96, 'low-sky', 'groundline'],
      [-64, 'groundline', 'hollows'],
      [-512, 'hollows', 'undercroft'],
    ]);
  });

  it('keeps a moved edge inside its bands and snaps it', () => {
    const e = edgesOf(bands).find((x) => x.y === 96)!;
    const lim = edgeLimits(bands, e);
    expect(lim).toEqual({ lo: -64, hi: 640 });
    expect(clampEdge(lim, 133)).toBe(130);
    expect(clampEdge(lim, 5000)).toBeLessThan(640);
    expect(clampEdge(lim, -5000)).toBeGreaterThan(-64);
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (y) => {
        const v = clampEdge(lim, y);
        expect(v).toBeGreaterThan(lim.lo);
        expect(v).toBeLessThan(lim.hi);
      }),
    );
  });

  it('stops a one-sided edge at the next band', () => {
    const bs = [span('a', 100, 200), span('b', -50, 0)];
    const top = edgesOf(bs).find((e) => e.below === 'b')!;
    expect(edgeLimits(bs, top)).toEqual({ lo: -50, hi: 100 });
    const outer = edgesOf(bs).find((e) => e.below === 'a')!;
    expect(edgeLimits(bs, outer)).toEqual({ lo: 100, hi: Infinity });
  });

  it('moves both bands of a shared edge in one valid transaction', () => {
    const w = sampleWorld();
    const e = edgesOf(bands).find((x) => x.y === 96)!;
    const r = applyCommands(w, moveEdgeCommands(e, 120), ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.world.entities['low-sky']!.fields.y_bottom).toBe(120);
    expect(r.value.world.entities['groundline']!.fields.y_top).toBe(120);
    expect(validateWorld(r.value.world).filter((p) => p.severity === 'error')).toEqual([]);
  });

  it('nudges in the asked direction', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -100000, max: 100000 }),
        fc.constantFrom(1 as const, -1 as const),
        (y, d) => {
          expect(Math.sign(nudge(y, d) - y)).toBe(d);
        },
      ),
    );
  });

  it('fits new bands in their gap', () => {
    expect(newBandSpan({ top: 200, bottom: 100 })).toEqual({ bottom: 100, top: 200 });
    const up = newBandSpan({ top: Infinity, bottom: 640 });
    expect(up.bottom).toBe(640);
    expect(up.top).toBeGreaterThan(640);
    const down = newBandSpan({ top: -512, bottom: -Infinity });
    expect(down.top).toBe(-512);
    expect(down.bottom).toBeLessThan(-512);
    expect(newBandSpan({ top: Infinity, bottom: -Infinity })).toEqual({ bottom: -64, top: 64 });
    expect(drawnBandSpan({ top: 1000, bottom: 100 }, 150, 4000)).toEqual({
      bottom: 150,
      top: 1000,
    });
    expect(drawnBandSpan({ top: 1000, bottom: 100 }, 300, 301)).toEqual({ bottom: 100, top: 1000 });
    expect(drawnBandSpan({ top: 1000, bottom: 100 }, 102, 500)).toEqual({ bottom: 100, top: 500 });
    fc.assert(
      fc.property(
        fc.integer({ min: -9000, max: 9000 }),
        fc.integer({ min: -9000, max: 9000 }),
        (a, b) => {
          const s = drawnBandSpan({ top: 2000, bottom: -300 }, a, b);
          expect(s.bottom).toBeGreaterThanOrEqual(-300);
          expect(s.top).toBeLessThanOrEqual(2000);
          expect(s.top).toBeGreaterThan(s.bottom);
        },
      ),
    );
  });

  it('creates a band that the commands accept', () => {
    const r = applyCommands(sampleWorld(), [createBandCommand({ bottom: 640, top: 2000 })], ctx);
    expect(r.ok).toBe(true);
  });
});

describe('lanes and layouts', () => {
  const w = sampleWorld();
  const apply = (c: ReturnType<typeof toggleLane> | null, world = w): typeof w => {
    expect(c).not.toBeNull();
    const r = applyCommands(world, [c!], ctx);
    expect(r.ok).toBe(true);
    return r.ok ? r.value.world : world;
  };

  it('defaults to every lane, graveyard shown, and survives junk', () => {
    expect(columnSettings(w)).toEqual({ lanes: [...LANES], layouts: [], graveyard: true });
    const junk = {
      ...w,
      settings: { ...w.settings, column: { lanes: ['items', 'bogus', 'items'] } },
    };
    expect(columnSettings(junk).lanes).toEqual(['items']);
    expect(columnSettings({ settings: { ...w.settings, column: 42 } }).lanes).toEqual([...LANES]);
  });

  it('hides, shows (in default position), and moves lanes', () => {
    let world = apply(toggleLane(columnSettings(w), 'creatures'));
    expect(columnSettings(world).lanes).not.toContain('creatures');
    world = apply(toggleLane(columnSettings(world), 'creatures'), world);
    expect(columnSettings(world).lanes).toEqual([...LANES]);
    world = apply(moveLane(columnSettings(world), 'items', -1), world);
    expect(columnSettings(world).lanes.indexOf('items')).toBe(LANES.indexOf('items') - 1);
    expect(moveLane(columnSettings(world), 'biomes', -1)).toBeNull();
  });

  it('saves, applies and deletes layouts', () => {
    let world = apply(toggleLane(columnSettings(w), 'feats'));
    world = apply(saveLayout(columnSettings(world), ' No feats '), world);
    expect(currentLayout(columnSettings(world))).toBe('No feats');
    world = apply(toggleLane(columnSettings(world), 'feats'), world);
    expect(currentLayout(columnSettings(world))).toBeUndefined();
    world = apply(applyLayout(columnSettings(world), 'No feats'), world);
    expect(columnSettings(world).lanes).not.toContain('feats');
    world = apply(deleteLayout(columnSettings(world), 'No feats'), world);
    expect(columnSettings(world).layouts).toEqual([]);
    expect(applyLayout(columnSettings(world), 'No feats')).toBeNull();
    world = apply(setGraveyard(columnSettings(world), false), world);
    expect(columnSettings(world).graveyard).toBe(false);
  });
});

describe('stress world', () => {
  it('has 2,000 valid entities, deterministically, across bands, inference and the Inbox', () => {
    const w = stressWorld();
    expect(Object.keys(w.entities)).toHaveLength(2000);
    expect(validateWorld(w).filter((p) => p.severity === 'error')).toEqual([]);
    expect(stressWorld()).toEqual(w);
    const p = placementsOf(w);
    const vals = [...p.values()];
    expect(vals.some((x) => x.inferred)).toBe(true);
    expect(vals.some((x) => x.places.length === 0)).toBe(true);
    const rows = rowsOf(bandSpans(w));
    expect(rows.filter((r) => r.kind === 'gap')).toEqual([]);
    expect(rows).toHaveLength(40);
  });
});

describe('sameColumnInputs', () => {
  it('skips rebuilds for edits the Column does not draw, and only those', async () => {
    const { sameColumnInputs } = await import('./model');
    const w = sampleWorld();
    const run = (c: ReturnType<typeof cmd>) => {
      const r = applyCommands(w, [c], ctx);
      if (!r.ok) throw new Error(r.error.message);
      return r.value.world;
    };
    expect(sameColumnInputs(w, w)).toBe(true);
    expect(
      sameColumnInputs(
        w,
        run(cmd('entity.update', { id: 'glide', set: { identity: 'Fall well.' } })),
      ),
    ).toBe(true);
    expect(
      sameColumnInputs(
        w,
        run(cmd('entity.setAttribute', { id: 'vent-glass-visor', key: 'defense', value: 3 })),
      ),
    ).toBe(true);
    // Editing an exported entity sends it back to decided: its glyph changes.
    expect(
      sameColumnInputs(
        w,
        run(cmd('entity.setAttribute', { id: 'cinder-sting', key: 'damage', value: 3 })),
      ),
    ).toBe(false);
    expect(
      sameColumnInputs(w, run(cmd('entity.update', { id: 'glide', set: { name: 'Soar' } }))),
    ).toBe(false);
    expect(
      sameColumnInputs(
        w,
        run(cmd('relation.add', { from: 'sky-coral', type: 'found_in', to: 'cloud-reef' })),
      ),
    ).toBe(false);
    expect(
      sameColumnInputs(
        w,
        run(cmd('entity.setField', { id: 'low-sky', field: 'y_top', value: 700 })),
      ),
    ).toBe(false);
    expect(sameColumnInputs(w, run(cmd('entity.delete', { id: 'reef-ray' })))).toBe(false);
    expect(
      sameColumnInputs(w, run(cmd('settings.set', { key: 'column', value: { lanes: ['items'] } }))),
    ).toBe(false);
  });
});

describe('columnModel reuse', () => {
  it('reuses placements across renames and agrees with a rebuild', async () => {
    const { columnModel, samePlacementInputs } = await import('./model');
    const w = sampleWorld();
    const m = columnModel(w);
    const r = applyCommands(
      w,
      [cmd('entity.update', { id: 'lumen-spore', set: { name: 'Lumen Dust' } })],
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(samePlacementInputs(w, r.value.world)).toBe(true);
    const reused = columnModel(r.value.world);
    expect(reused.placements).toBe(m.placements);
    expect(reused).toEqual(columnModel(r.value.world));
    const moved = applyCommands(
      w,
      [cmd('relation.add', { from: 'sky-coral', type: 'found_in', to: 'cloud-reef' })],
      ctx,
    );
    if (!moved.ok) throw new Error(moved.error.message);
    expect(samePlacementInputs(w, moved.value.world)).toBe(false);
    expect(columnModel(moved.value.world).placements.get('sky-coral')?.places).toEqual([
      { band: 'low-sky', biome: 'cloud-reef' },
    ]);
  });
});

describe('incremental cell indexing', () => {
  const plain = (m: ColumnModel) => ({
    lanes: m.lanes,
    bands: m.bands,
    rows: m.rows,
    unplaced: m.index.unplacedBands,
    cells: [...m.index.cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  });
  const ids = Object.keys(sampleWorld().entities).sort();
  const edit = fc.oneof(
    fc.record({
      t: fc.constant('name' as const),
      id: fc.constantFrom(...ids),
      name: fc.constantFrom('Aa', 'Zz', 'Moss', '🜂 Ember', 'Mm'),
    }),
    fc.record({
      t: fc.constant('state' as const),
      id: fc.constantFrom(...ids),
      state: fc.constantFrom('shaped', 'graveyard', 'idea', 'decided'),
    }),
    fc.record({
      t: fc.constant('subkind' as const),
      id: fc.constantFrom(...ids),
      sub: fc.constantFrom('armor', 'tool', 'weapon'),
    }),
    fc.record({ t: fc.constant('identity' as const), id: fc.constantFrom(...ids) }),
    fc.record({ t: fc.constant('relation' as const), id: fc.constantFrom(...ids) }),
    fc.record({ t: fc.constant('graveyard' as const), show: fc.boolean() }),
  );
  type Edit = typeof edit extends fc.Arbitrary<infer T> ? T : never;
  const commandFor = (w: World, e: Edit): Command | null => {
    if (e.t === 'graveyard') return setGraveyard(columnSettings(w), e.show);
    const ent = w.entities[e.id];
    if (!ent) return null;
    switch (e.t) {
      case 'name':
        return cmd('entity.update', { id: e.id, set: { name: e.name } });
      case 'state':
        return cmd('entity.setState', {
          id: e.id,
          state: e.state,
          ...(e.state === 'graveyard' ? { killed: { reason: 'seen it' } } : {}),
          ...(e.state === 'decided' ? { why: 'Because.' } : {}),
        });
      case 'subkind':
        return ent.kind === 'item'
          ? cmd('entity.setField', { id: e.id, field: 'subkind', value: e.sub })
          : null;
      case 'identity':
        return cmd('entity.update', { id: e.id, set: { identity: `${ent.identity}!` } });
      case 'relation':
        return ent.kind === 'material'
          ? cmd('relation.add', { from: e.id, type: 'found_in', to: 'cloud-reef' })
          : null;
    }
    return null;
  };

  it('patches only touched cells and always equals a fresh build (property)', () => {
    fc.assert(
      fc.property(fc.array(edit, { maxLength: 12 }), (edits) => {
        let w = sampleWorld();
        let m = columnModel(w);
        for (const e of edits) {
          const c = commandFor(w, e);
          if (!c) continue;
          const r = applyCommands(w, [c], ctx);
          if (!r.ok) continue; // a refused transition changes nothing
          const next = r.value.world;
          const patched = columnModel(next, { world: w, model: m });
          expect(plain(patched)).toEqual(plain(columnModel(next)));
          w = next;
          m = patched;
        }
      }),
      { numRuns: 150 },
    );
  });

  it('keeps the list of every cell a rename did not touch', () => {
    const w = stressWorld();
    const m = columnModel(w);
    const r = applyCommands(
      w,
      [cmd('entity.update', { id: 'e-500', set: { name: 'Renamed' } })],
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    const next = columnModel(r.value.world, { world: w, model: m });
    let kept = 0;
    let changed = 0;
    for (const [k, list] of next.index.cells)
      if (m.index.cells.get(k) === list) kept++;
      else changed++;
    expect(changed).toBeGreaterThan(0);
    expect(changed).toBeLessThanOrEqual(2);
    expect(kept).toBeGreaterThan(100);
    // An edit that moves something rebuilds.
    const moved = applyCommands(
      w,
      [
        cmd('entity.setField', {
          id: w.entities['e-500']!.kind === 'band' ? 'e-501' : 'e-500',
          field: 'y_top',
          value: 1,
        }),
      ],
      ctx,
    );
    if (moved.ok)
      expect(columnModel(moved.value.world, { world: w, model: m }).index).not.toBe(m.index);
  });
});
