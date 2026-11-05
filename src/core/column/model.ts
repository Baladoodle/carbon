import { LANE_OF_KIND, ENTITY_KINDS, type Lane } from '../model/kinds';
import type { Entity } from '../model/entity';
import { schemaOf, type World } from '../model/world';
import type { NavContext } from './cursor';
import { columnSettings, type ColumnSettings } from './lanes';
import {
  bandSpans,
  chipWidth,
  compareCellEntities,
  laneWidths,
  groupOf,
  CELL_PAD,
  CHIP_GAP,
  CHIP_H,
  cellIndex,
  cellKey,
  frameOf,
  INBOX_ROW,
  layoutCell,
  pxOfY,
  rowsOf,
  type BandSpan,
  type CellEntity,
  type CellIndex,
  type CellLayout,
  type Frame,
  type Glyph,
  type Measure,
  type Rect,
  type Row,
} from './layout';
import { placementsOf, type Placement } from './placement';
import { samePlacingInputs } from '../placement/resolve';

/**
 * Everything the Column draws, computed from the world (zoom-independent) and
 * then from the zoom and width (geometry). Pure: no DOM, no React.
 */
export interface ColumnModel {
  settings: ColumnSettings;
  lanes: Lane[];
  laneLabels: Record<Lane, string>;
  bands: BandSpan[];
  rows: Row[];
  placements: Map<string, Placement>;
  index: CellIndex;
}

/** What of an entity the Column depends on (placement, its cell, its chip). */
function drawn(e: Entity): unknown[] {
  return [
    e.kind,
    e.name,
    e.state,
    e.relations,
    e.fields.band,
    e.fields.subkind,
    e.fields.y_bottom,
    e.fields.y_top,
    e.fields.danger,
    e.fields.route,
  ];
}

const same = (x: unknown[], y: unknown[]): boolean =>
  x.every((v, i) => v === y[i] || JSON.stringify(v) === JSON.stringify(y[i]));
const sameDrawn = (a: Entity, b: Entity): boolean => same(drawn(a), drawn(b));

/**
 * Whether every placement in `prev` still holds in `next`: nothing the
 * resolver reads changed (`samePlacingInputs` in src/core/placement).
 */
export const samePlacementInputs = (prev: World, next: World): boolean =>
  samePlacingInputs(prev.entities, next.entities);

/**
 * Whether the Column model of `prev` holds for `next`: same settings and
 * schema, same entities, and every changed entity changed only in what the
 * Column doesn't draw (an identity, a description, an attribute…). Then a
 * patch costs the Column nothing, which keeps command round trips short.
 */
export function sameColumnInputs(prev: World, next: World): boolean {
  if (prev === next) return true;
  if (prev.settings !== next.settings || prev.schema !== next.schema) return false;
  const a = prev.entities;
  const b = next.entities;
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (!x || !y || !sameDrawn(x, y)) return false;
  }
  return true;
}

/**
 * The Column model of a world. Placements come from the resolver, which
 * reuses its result when no placing input changed (a rename, a state change).
 *
 * With the model of the previous world, an edit that moves nothing (a rename,
 * a state change, a subkind) re-indexes only the cells of the entities it
 * changed: every other cell keeps its list, so its layout is reused too.
 * A property test holds the result equal to a fresh build.
 */
export function columnModel(
  world: World,
  prev?: { world: World; model: ColumnModel },
): ColumnModel {
  if (prev) {
    const next = reindex(prev.world, prev.model, world);
    if (next) return next;
  }
  const settings = columnSettings(world);
  const schema = schemaOf(world);
  const laneLabels = {} as Record<Lane, string>;
  for (const k of ENTITY_KINDS) {
    const lane = LANE_OF_KIND[k];
    if (lane) laneLabels[lane] = schema.kinds[k].plural;
  }
  const bands = bandSpans(world);
  // The resolver reuses its result when no placing input changed (a rename, a
  // state change), and placementsOf keeps one reshaped map per result.
  const placements = placementsOf(world);
  return {
    settings,
    lanes: settings.lanes,
    laneLabels,
    bands,
    rows: rowsOf(bands),
    placements,
    index: cellIndex(world, placements, { graveyard: settings.graveyard }),
  };
}

/** The cells (or the Inbox cell) an entity shows in, for its lane. */
function cellsOf(
  e: Entity,
  placements: ReadonlyMap<string, Placement>,
  graveyard: boolean,
): string[] {
  const lane = LANE_OF_KIND[e.kind];
  if (lane === null || (!graveyard && e.state === 'graveyard')) return [];
  const p = placements.get(e.id);
  if (!p || p.places.length === 0) return [cellKey(INBOX_ROW, lane)];
  return [...new Set(p.places.map((x) => cellKey(x.band, lane)))];
}

/**
 * The model of `next`, patched from `prev`'s, when the edit between them
 * moves nothing: same settings and schema, the same placements (the resolver
 * reused them) and no band changed. Otherwise null (rebuild).
 */
function reindex(prevWorld: World, prev: ColumnModel, next: World): ColumnModel | null {
  if (prevWorld.settings !== next.settings || prevWorld.schema !== next.schema) return null;
  const placements = placementsOf(next);
  if (placements !== prev.placements) return null;
  const a = prevWorld.entities;
  const b = next.entities;
  const changed: [Entity, Entity][] = [];
  for (const id in b) {
    const x = a[id];
    const y = b[id];
    if (x === y) continue;
    if (!x || !y || x.kind === 'band' || y.kind === 'band') return null;
    changed.push([x, y]);
  }
  if (changed.length === 0) return prev;
  const graveyard = prev.settings.graveyard;
  const cells = new Map(prev.index.cells);
  const touched = new Set<string>();
  const list = (key: string): CellEntity[] => {
    if (!touched.has(key)) {
      touched.add(key);
      cells.set(key, [...(cells.get(key) ?? [])]);
    }
    return cells.get(key) as CellEntity[];
  };
  for (const [x, y] of changed) {
    for (const key of cellsOf(x, placements, graveyard)) {
      const l = list(key);
      const i = l.findIndex((c) => c.id === x.id);
      if (i >= 0) l.splice(i, 1);
    }
    const p = placements.get(y.id);
    for (const key of cellsOf(y, placements, graveyard))
      list(key).push({
        id: y.id,
        name: y.name,
        state: y.state,
        group: groupOf(y),
        inferred: !!p && p.places.length > 0 && p.inferred,
      });
  }
  for (const key of touched) {
    const l = cells.get(key) as CellEntity[];
    if (l.length === 0) cells.delete(key);
    else l.sort(compareCellEntities);
  }
  return { ...prev, index: { cells, unplacedBands: prev.index.unplacedBands } };
}

// ── Geometry ────────────────────────────────────────────────────────────────

export const RULER_W = 42;
export const LABEL_W = 100;
export const MARGIN_W = 184;
/** The narrowest a lane gets (an empty lane with a short label). */
export const LANE_MIN_W = 64;
/** Room around a lane's header label. */
const HEAD_PAD = 16;
/** Lane demands are rounded up to this, so a small rename doesn't shift every lane. */
const DEMAND_STEP = 8;
export const HEAD_H = 30;
const INBOX_MAX_LINES = 3;

export interface RowBox {
  row: Row;
  top: number;
  bottom: number;
}

export interface CellBox extends CellLayout {
  key: string;
  row: string;
  lane: Lane;
  rect: Rect;
}

export interface Geometry {
  frame: Frame;
  /** Content width (at least the viewport's). */
  width: number;
  /** Each shown lane's left edge and width (lanes are as wide as their names need, fairly). */
  laneX: number[];
  laneW: number[];
  marginX: number;
  rows: RowBox[];
  /** Band row cells with something in them. */
  cells: Map<string, CellBox>;
  /** Every glyph of an entity (it can sit in several bands). */
  glyphsOf: Map<string, Glyph[]>;
  /** The Inbox strip, when it has anything in it. */
  inbox: { height: number; cells: Map<string, CellBox>; bands: CellBox | null } | null;
}

export interface GeometryOptions {
  pxPerU: number;
  /** The viewport width. */
  width: number;
  measure: Measure;
  /** Bands with a live edge drag applied (the frame stays that of `model.bands`). */
  bands?: BandSpan[];
  /** Cell layouts are cached by content; bump this when `measure` changes (fonts loaded). */
  version?: number;
  /** Measures a lane's header label (default: `measure`). */
  measureHead?: Measure;
}

const demandCache = new WeakMap<
  CellIndex,
  { measure: Measure; version: number; byLane: Map<Lane, number> }
>();

/**
 * How wide each lane wants to be: its widest chip with the whole name (in any
 * band or the Inbox), or its header label, whichever is wider. Cached per
 * index, so panning and zooming don't measure again.
 */
export function laneDemands(
  model: ColumnModel,
  measure: Measure,
  measureHead: Measure = measure,
  version = 0,
): number[] {
  let hit = demandCache.get(model.index);
  if (!hit || hit.measure !== measure || hit.version !== version) {
    const byLane = new Map<Lane, number>();
    for (const [key, es] of model.index.cells) {
      const lane = key.slice(key.lastIndexOf('|') + 1) as Lane;
      let w = byLane.get(lane) ?? 0;
      for (const e of es) w = Math.max(w, chipWidth(e.name, measure) + 2 * CELL_PAD);
      byLane.set(lane, w);
    }
    hit = { measure, version, byLane };
    demandCache.set(model.index, hit);
  }
  const byLane = hit.byLane;
  return model.lanes.map((l) => {
    const want = Math.max(byLane.get(l) ?? 0, measureHead(model.laneLabels[l]) + HEAD_PAD);
    return Math.ceil(want / DEMAND_STEP) * DEMAND_STEP;
  });
}

/** The lane at a content x (−1: the ruler and the band labels), clamped to the last lane. */
export function laneAtX(geo: Pick<Geometry, 'laneX' | 'laneW'>, x: number): number {
  if (geo.laneX.length === 0 || x < (geo.laneX[0] ?? 0)) return -1;
  for (let i = geo.laneX.length - 1; i >= 0; i--) if (x >= (geo.laneX[i] ?? 0)) return i;
  return -1;
}

/**
 * Cell layouts by cell, reused while the cell's rect and entities are the
 * same: an edit re-lays only the cells it touched, which keeps a command's
 * round trip short with 2,000 entities.
 */
interface CachedCell {
  es: readonly CellEntity[];
  rect: Rect;
  alignBottom: boolean;
  version: number;
  measure: Measure;
  box: CellBox;
}
const cellCache = new Map<string, CachedCell>();
const CACHE_MAX = 20000;

const sameRect = (a: Rect, b: Rect): boolean =>
  a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
/** Same entities as drawn: the same list (an untouched cell), or equal element by element. */
const sameCellEntities = (a: readonly CellEntity[], b: readonly CellEntity[]): boolean =>
  a === b ||
  (a.length === b.length &&
    a.every((x, i) => {
      const y = b[i] as CellEntity;
      return (
        x.id === y.id &&
        x.name === y.name &&
        x.state === y.state &&
        x.inferred === y.inferred &&
        x.group === y.group
      );
    }));

function cachedCell(
  key: string,
  row: string,
  lane: Lane,
  rect: Rect,
  es: readonly CellEntity[],
  measure: Measure,
  alignBottom: boolean,
  version: number,
): CellBox {
  const hit = cellCache.get(key);
  if (
    hit &&
    hit.version === version &&
    hit.measure === measure &&
    hit.alignBottom === alignBottom &&
    sameRect(hit.rect, rect) &&
    sameCellEntities(hit.es, es)
  ) {
    hit.es = es;
    return hit.box;
  }
  const box: CellBox = { ...layoutCell(rect, es, measure, alignBottom), key, row, lane, rect };
  if (cellCache.size > CACHE_MAX) cellCache.clear();
  cellCache.set(key, { es, rect, alignBottom, version, measure, box });
  return box;
}

export function geometry(model: ColumnModel, opts: GeometryOptions): Geometry {
  const frame = frameOf(model.bands, opts.pxPerU);
  const rows = opts.bands ? rowsOf(opts.bands) : model.rows;
  const left = RULER_W + LABEL_W;
  const laneW = laneWidths(
    laneDemands(model, opts.measure, opts.measureHead, opts.version ?? 0),
    opts.width - left - MARGIN_W,
    LANE_MIN_W,
  );
  const laneX: number[] = [];
  let x = left;
  for (const w of laneW) {
    laneX.push(x);
    x += w;
  }
  const marginX = x;
  const width = Math.max(opts.width, marginX + MARGIN_W);

  const boxes: RowBox[] = rows.map((row) => ({
    row,
    top: pxOfY(frame, row.top),
    bottom: pxOfY(frame, row.bottom),
  }));
  const cells = new Map<string, CellBox>();
  const glyphsOf = new Map<string, Glyph[]>();
  const addGlyphs = (gs: Glyph[]): void => {
    for (const g of gs) {
      const list = glyphsOf.get(g.id);
      if (list) list.push(g);
      else glyphsOf.set(g.id, [g]);
    }
  };
  for (const box of boxes) {
    if (box.row.kind !== 'band') continue;
    const band = box.row.band;
    const alignBottom = band.top === Infinity && Number.isFinite(band.bottom);
    model.lanes.forEach((lane, i) => {
      const key = cellKey(band.id, lane);
      const es = model.index.cells.get(key);
      if (!es || es.length === 0) return;
      const rect = { x: laneX[i] ?? 0, y: box.top, w: laneW[i] ?? 0, h: box.bottom - box.top };
      const cell = cachedCell(
        key,
        band.id,
        lane,
        rect,
        es,
        opts.measure,
        alignBottom,
        opts.version ?? 0,
      );
      cells.set(key, cell);
      addGlyphs(cell.glyphs);
    });
  }

  // The Inbox: one strip, as tall as its fullest lane (up to a few lines).
  const inboxCells = new Map<string, CellBox>();
  const tall = CELL_PAD * 2 + INBOX_MAX_LINES * CHIP_H + (INBOX_MAX_LINES - 1) * CHIP_GAP;
  let used = 0;
  const lay = (
    key: string,
    lane: Lane | null,
    x: number,
    w: number,
    es: readonly CellEntity[],
  ): CellBox => {
    const rect = { x, y: 0, w, h: tall };
    const l = cachedCell(
      key,
      INBOX_ROW,
      lane ?? 'biomes',
      rect,
      es,
      opts.measure,
      false,
      opts.version ?? 0,
    );
    for (const g of [...l.glyphs, ...(l.more ? [l.more] : [])]) used = Math.max(used, g.y + g.h);
    return l;
  };
  model.lanes.forEach((lane, i) => {
    const key = cellKey(INBOX_ROW, lane);
    const es = model.index.cells.get(key);
    if (es && es.length > 0) inboxCells.set(key, lay(key, lane, laneX[i] ?? 0, laneW[i] ?? 0, es));
  });
  let bandsBox =
    model.index.unplacedBands.length > 0
      ? lay('inbox|bands', null, RULER_W, LABEL_W, model.index.unplacedBands)
      : null;
  let inbox: Geometry['inbox'] = null;
  if (inboxCells.size > 0 || bandsBox) {
    const height = Math.max(CHIP_H + 2 * CELL_PAD, used + CELL_PAD);
    // The strip is as tall as its fullest cell (copies: the cached boxes stay as laid out).
    const fit = (c: CellBox): CellBox => ({ ...c, rect: { ...c.rect, h: height } });
    for (const [k, c] of inboxCells) inboxCells.set(k, fit(c));
    if (bandsBox) bandsBox = fit(bandsBox);
    inbox = { height, cells: inboxCells, bands: bandsBox };
  }
  return { frame, width, laneX, laneW, marginX, rows: boxes, cells, glyphsOf, inbox };
}

// ── Navigation context ──────────────────────────────────────────────────────

export function navContext(model: ColumnModel, withInbox: boolean): NavContext {
  const rows = model.rows.map((r) => r.key);
  if (withInbox) rows.push(INBOX_ROW);
  const bandRows = new Set(model.rows.filter((r) => r.kind === 'band').map((r) => r.key));
  return {
    rows,
    laneCount: model.lanes.length,
    entitiesAt(row, lane) {
      if (lane < 0) {
        if (row === INBOX_ROW) return model.index.unplacedBands.map((e) => e.id);
        return bandRows.has(row) ? [row] : [];
      }
      const l = model.lanes[lane];
      if (!l) return [];
      return (model.index.cells.get(cellKey(row, l)) ?? []).map((e) => e.id);
    },
  };
}

/** Whether the Inbox has anything in it (for the lanes shown). */
export function inboxHasEntities(model: ColumnModel): boolean {
  if (model.index.unplacedBands.length > 0) return true;
  return model.lanes.some((l) => (model.index.cells.get(cellKey(INBOX_ROW, l))?.length ?? 0) > 0);
}

/** The first row and lane where an entity shows (for following focus set elsewhere). */
export function locate(model: ColumnModel, id: string): { row: string; lane: number } | null {
  if (model.rows.some((r) => r.key === id && r.kind === 'band')) return { row: id, lane: -1 };
  if (model.index.unplacedBands.some((e) => e.id === id)) return { row: INBOX_ROW, lane: -1 };
  for (const row of [...model.rows.map((r) => r.key), INBOX_ROW])
    for (const [i, lane] of model.lanes.entries())
      if (model.index.cells.get(cellKey(row, lane))?.some((e) => e.id === id))
        return { row, lane: i };
  return null;
}
