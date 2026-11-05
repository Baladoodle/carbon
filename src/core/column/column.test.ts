import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import { LANES } from '../model/kinds';
import { validateWorld } from '../model/validate';
import type { World } from '../model/world';
import { resolvePlacement } from '../placement';
import { sampleWorld } from '../testing/sample';
import {
  columnModel,
  geometry,
  inboxHasEntities,
  laneAtX,
  laneDemands,
  locate,
  navContext,
  type ColumnModel,
} from './model';
import { at, normalize, side, step, stopsOf, type NavContext } from './cursor';
import {
  clampEdge,
  createBandCommand,
  drawnBandSpan,
  edgeKey,
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
  CHIP_ICON,
  chipWidth,
  fitText,
  iconOf,
  frameOf,
  INBOX_ROW,
  laneWidths,
  layoutCell,
  pxOfU,
  pxOfY,
  uOfPx,
  rowsOf,
  stackMargin,
  wrappedLines,
  type BandSpan,
  type CellEntity,
  type Measure,
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
    // Inverted edges are no edges (the resolver's band.no_edges): not flipped into a band.
    expect(bandSpan({ ...e, fields: { y_bottom: 9, y_top: 5 } })).toBeNull();
    expect(bandSpan({ ...e, fields: { y_bottom: 5, y_top: 9 } })).toMatchObject({
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

describe('icons on chips (docs/IMAGES.md §6)', () => {
  const ICON = '01JC0000000000000000000000';
  const withIcon = (w: World, id: string): World => ({
    ...w,
    images: {
      [id]: {
        icon: ICON,
        all: [
          {
            id: ICON,
            entity: id,
            kind: 'icon',
            origin: { by: 'fake', prompt: 'p', size: '1024x1024' },
            created: '2026-11-05T00:00:00.000Z',
            hashes: { output: 'a'.repeat(64) },
          },
        ],
      },
    },
  });

  it('makes room for the icon before the name', () => {
    expect(chipWidth('Lantern', measure, true)).toBe(chipWidth('Lantern', measure) + CHIP_ICON);
    const l = layoutCell(
      { x: 0, y: 0, w: 400, h: 60 },
      [ce('a', 'Alpha'), { ...ce('b', 'Alpha'), icon: ICON }],
      measure,
    );
    expect(l.glyphs[1]!.w - l.glyphs[0]!.w).toBe(CHIP_ICON);
    expect(l.glyphs[1]!.icon).toBe(ICON);
    expect(l.glyphs[0]!.icon).toBeUndefined();
  });

  it('a chosen icon re-lays out the cell, and the model equals a fresh build', () => {
    const w = sampleWorld();
    const before = columnModel(w);
    const next = withIcon(w, 'spore-lantern');
    expect(iconOf(next, 'spore-lantern')).toBe(ICON);
    const m = columnModel(next, { world: w, model: before });
    expect(m).toEqual(columnModel(next));
    const entry = (mm: typeof m) =>
      [...mm.index.cells.values()].flat().find((c) => c.id === 'spore-lantern');
    expect(entry(before)?.icon).toBeUndefined();
    expect(entry(m)?.icon).toBe(ICON);
    // Taking the icon away again goes back to the plain chip.
    expect(entry(columnModel(w, { world: next, model: m }))?.icon).toBeUndefined();
  });
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

describe('lane widths', () => {
  it('share the room fairly by need, sum exactly, never under the minimum (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 9 }),
        fc.integer({ min: 0, max: 2400 }),
        fc.integer({ min: 20, max: 100 }),
        (demands, available, min) => {
          const w = laneWidths(demands, available, min);
          const n = demands.length;
          const total = Math.max(available, n * min);
          expect(w).toHaveLength(n);
          expect(w.every((x) => Number.isInteger(x) && x >= min)).toBe(true);
          expect(w.reduce((a, b) => a + b, 0)).toBe(total);
          const want = demands.map((d) => Math.max(min, d));
          const fits = want.reduce((a, b) => a + b, 0) <= total;
          if (fits) {
            // Everyone gets what they need, and the rest is shared equally.
            const extra = w.map((x, i) => x - (want[i] as number));
            expect(Math.max(...extra) - Math.min(...extra)).toBeLessThanOrEqual(1);
          } else {
            // A lane that got less than it needs is (within a pixel) the widest there is:
            // no lane got more at its expense.
            for (let i = 0; i < n; i++)
              if ((w[i] as number) < (want[i] as number))
                for (let j = 0; j < n; j++)
                  expect(w[j] as number).toBeLessThanOrEqual((w[i] as number) + 1);
          }
        },
      ),
    );
  });

  it('gives short-name lanes what they need and long-name lanes the rest', () => {
    expect(laneWidths([80, 80, 300, 300], 600, 64)).toEqual([80, 80, 220, 220]);
    expect(laneWidths([80, 80], 300, 64)).toEqual([150, 150]);
    expect(laneWidths([80, 80, 80], 100, 64)).toEqual([64, 64, 64]);
    expect(laneWidths([], 100, 64)).toEqual([]);
  });
});

describe('geometry', () => {
  const w = sampleWorld();
  const model = columnModel(w);
  const geo = (width = 1100) => geometry(model, { pxPerU: 200, width, measure });

  it('sizes lanes by their widest name and keeps them in order, edge to edge', () => {
    const g = geo();
    expect(g.laneW).toHaveLength(model.lanes.length);
    for (let i = 1; i < g.laneX.length; i++)
      expect(g.laneX[i]).toBe((g.laneX[i - 1] as number) + (g.laneW[i - 1] as number));
    expect(g.marginX).toBe((g.laneX.at(-1) as number) + (g.laneW.at(-1) as number));
    const d = laneDemands(model, measure);
    expect(d.every((x) => x % 8 === 0)).toBe(true);
    // The widest chip in a lane fits whole when there's room for every lane's need.
    const roomy = geo(4000);
    for (const c of roomy.cells.values()) for (const gl of c.glyphs) expect(gl.text).toBe(gl.name);
  });

  it('finds the lane at an x, and -1 left of the lanes', () => {
    const g = geo();
    expect(laneAtX(g, 0)).toBe(-1);
    expect(laneAtX(g, (g.laneX[0] as number) - 1)).toBe(-1);
    expect(laneAtX(g, g.laneX[0] as number)).toBe(0);
    expect(laneAtX(g, (g.laneX[2] as number) + 3)).toBe(2);
    expect(laneAtX(g, 1e6)).toBe(model.lanes.length - 1);
    expect(laneAtX({ laneX: [], laneW: [] }, 500)).toBe(-1);
  });

  it('puts every placed glyph in its cell and the Inbox under the Column', () => {
    const g = geo();
    for (const c of g.cells.values())
      for (const gl of c.glyphs) {
        expect(gl.x).toBeGreaterThanOrEqual(c.rect.x);
        expect(gl.x + gl.w).toBeLessThanOrEqual(c.rect.x + c.rect.w);
        expect(g.glyphsOf.get(gl.id)).toContain(gl);
      }
    expect(inboxHasEntities(model)).toBe(true);
    expect(g.inbox?.cells.size).toBeGreaterThan(0);
    for (const c of g.inbox?.cells.values() ?? []) expect(c.rect.h).toBe(g.inbox?.height);
  });

  it('navigates rows and lanes, and locates entities', () => {
    const nav = navContext(model, true);
    expect(nav.rows.at(-1)).toBe(INBOX_ROW);
    expect(nav.laneCount).toBe(model.lanes.length);
    expect(nav.entitiesAt('low-sky', -1)).toEqual(['low-sky']);
    expect(nav.entitiesAt('gap:0', -1)).toEqual([]);
    expect(nav.entitiesAt('low-sky', 99)).toEqual([]);
    expect(locate(model, 'low-sky')).toEqual({ row: 'low-sky', lane: -1 });
    const glide = locate(model, 'glide');
    expect(glide?.row).toBe('low-sky');
    expect(model.lanes[glide?.lane ?? -1]).toBe('capabilities');
    expect(locate(model, 'sky-coral')?.row).toBe(INBOX_ROW);
    expect(locate(model, 'nobody')).toBeNull();
  });

  it('applies a live edge drag to the rows without moving the frame', () => {
    const bands = model.bands.map((b) => (b.id === 'groundline' ? { ...b, top: 200 } : b));
    const g = geometry(model, { pxPerU: 200, width: 1100, measure, bands });
    expect(g.frame).toEqual(geo().frame);
    expect(g.rows.find((r) => r.row.key === 'groundline')?.top).toBeLessThan(
      geo().rows.find((r) => r.row.key === 'groundline')?.top as number,
    );
  });
});

describe('bands agree with the resolver', () => {
  it('draws a band exactly when the resolver places it (property)', () => {
    const height = fc.oneof(
      fc.integer({ min: -2000, max: 2000 }),
      fc.constantFrom('+inf', '-inf', 'x', null),
    );
    fc.assert(
      fc.property(height, height, (bottom, top) => {
        const w = sampleWorld();
        const band = w.entities['groundline']!;
        const fields = { ...band.fields, y_bottom: bottom, y_top: top };
        const next = { ...w, entities: { ...w.entities, groundline: { ...band, fields } } };
        const placed = resolvePlacement(next)['groundline']?.mode !== 'unplaced';
        const span = bandSpan(next.entities['groundline']);
        expect(span !== null).toBe(placed);
        if (span) expect(span.bottom).toBeLessThan(span.top);
        const m = columnModel(next);
        expect(m.bands.some((b) => b.id === 'groundline')).toBe(placed);
        expect(m.index.unplacedBands.some((b) => b.id === 'groundline')).toBe(!placed);
      }),
    );
  });
});

describe('the remaining paths', () => {
  it('steps from an entity no longer in its cell, from the cell itself', () => {
    const ctx2: NavContext = {
      rows: ['a', 'b'],
      laneCount: 1,
      entitiesAt: (row) => (row === 'a' ? ['x', 'y'] : []),
    };
    expect(step(ctx2, { row: 'a', lane: 0, entity: 'gone' }, 1)).toEqual({
      row: 'a',
      lane: 0,
      entity: 'y',
    });
    expect(step(ctx2, { row: 'nowhere', lane: 0, entity: null }, 1).row).toBe('a');
  });

  it('keys edges by their bands, and stops a lone bottom edge at the band below', () => {
    const bands: BandSpan[] = [
      { id: 'top', name: 'Top', state: 'idea', bottom: 100, top: 200 },
      { id: 'low', name: 'Low', state: 'idea', bottom: -50, top: 10 },
    ];
    const edges = edgesOf(bands);
    expect(edges.map(edgeKey)).toEqual(['^top', 'top^', '^low', 'low^']);
    const bottomOfTop = edges.find((e) => e.above === 'top')!;
    expect(edgeLimits(bands, bottomOfTop)).toEqual({ lo: 10, hi: 200 });
    const topOfLow = edges.find((e) => e.below === 'low')!;
    expect(edgeLimits(bands, topOfLow)).toEqual({ lo: -50, hi: 100 });
  });

  it('replaces a layout of the same name and keeps layouts in name order', () => {
    let s = columnSettings({ settings: { format: 1 } as never });
    const apply = (c: Command): void => {
      s = columnSettings({
        settings: { column: (c.payload as { value: unknown }).value } as never,
      });
    };
    apply(saveLayout(s, 'Zeta'));
    apply(saveLayout(s, ' Alpha '));
    apply(toggleLane(s, 'feats'));
    apply(saveLayout(s, 'Zeta'));
    expect(s.layouts.map((l) => l.name)).toEqual(['Alpha', 'Zeta']);
    expect(s.layouts.find((l) => l.name === 'Zeta')?.lanes).not.toContain('feats');
  });

  it('converts between content px and scale units both ways', () => {
    const f = frameOf(bandSpans(sampleWorld()), 200);
    for (const u of [-2, 0, 0.5, 1.3]) expect(uOfPx(f, pxOfU(f, u))).toBeCloseTo(u, 9);
  });

  it('reuses a cell layout for equal entities in a rebuilt list', () => {
    const w = sampleWorld();
    const a = geometry(columnModel(w), { pxPerU: 200, width: 1100, measure });
    // A fresh model: new lists, the same entities.
    const fresh = columnModel({ ...w, entities: { ...w.entities } });
    const b = geometry(fresh, { pxPerU: 200, width: 1100, measure });
    const [key, cell] = [...b.cells.entries()][0]!;
    expect(cell).toBe(a.cells.get(key));
  });

  it('navigates and locates bands that wait in the Inbox', () => {
    const w = sampleWorld();
    const band = w.entities['high-drift']!;
    const world = {
      ...w,
      entities: { ...w.entities, 'high-drift': { ...band, fields: { ...band.fields, y_top: 1 } } },
    };
    const m = columnModel(world);
    expect(navContext(m, true).entitiesAt(INBOX_ROW, -1)).toEqual(['high-drift']);
    expect(locate(m, 'high-drift')).toEqual({ row: INBOX_ROW, lane: -1 });
    expect(inboxHasEntities({ ...m, lanes: [] })).toBe(true);
  });
});

describe('wrappedLines', () => {
  const mono: Measure = (t) => t.length * 10;
  it('wraps at word boundaries, as a browser does', () => {
    expect(wrappedLines('', 100, mono)).toBe(1);
    expect(wrappedLines('aaaa bbbb', 100, mono)).toBe(1); // 90
    expect(wrappedLines('aaaa bbbbb', 100, mono)).toBe(1); // 100 fits exactly
    expect(wrappedLines('aaaa bbbbbb', 100, mono)).toBe(2);
    // The area estimate (ceil(120 / 100) = 2) undercounts: each word takes a line.
    expect(wrappedLines('aaaaaaa bbbbbbb ccccccc', 100, mono)).toBe(3);
    // A word longer than a line breaks over as many as it needs.
    expect(wrappedLines('aaaaaaaaaaaaaaaaaaaaaaaaa', 100, mono)).toBe(3);
  });
  it('never counts fewer lines than its words’ area needs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z]{1,12}$/), { maxLength: 20 }),
        fc.integer({ min: 40, max: 200 }),
        (ws, width) => {
          const text = ws.join(' ');
          const lines = wrappedLines(text, width, mono);
          // Spaces at a line break take no room, so only the words count.
          const words = mono(ws.join(''));
          expect(lines).toBeGreaterThanOrEqual(Math.max(1, Math.ceil(words / width)));
        },
      ),
    );
  });
});
