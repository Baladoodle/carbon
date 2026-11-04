import { LANE_OF_KIND, ENTITY_KINDS, type Lane } from '@core/model/kinds';
import type { Entity } from '@core/model/entity';
import { schemaOf, type World } from '@core/model/world';
import type { NavContext } from './cursor';
import { columnSettings, type ColumnSettings } from './lanes';
import {
  bandSpans,
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
  type CellIndex,
  type CellLayout,
  type Frame,
  type Glyph,
  type Measure,
  type Rect,
  type Row,
} from './layout';
import { placementsOf, type Placement } from './placement';
import { samePlacingInputs } from '@core/placement/resolve';

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
 */
export function columnModel(world: World): ColumnModel {
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

// ── Geometry ────────────────────────────────────────────────────────────────

export const RULER_W = 42;
export const LABEL_W = 100;
export const MARGIN_W = 184;
export const LANE_MIN_W = 92;
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
  laneX: number[];
  laneW: number;
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
}

/**
 * Cell layouts by cell, reused while the cell's rect and entities are the
 * same: an edit re-lays only the cells it touched, which keeps a command's
 * round trip short with 2,000 entities.
 */
const cellCache = new Map<string, { sig: string; box: CellBox }>();
const CACHE_MAX = 20000;

function cachedCell(
  key: string,
  row: string,
  lane: Lane,
  rect: Rect,
  es: Parameters<typeof layoutCell>[1],
  measure: Measure,
  alignBottom: boolean,
  version: number,
): CellBox {
  let sig = `${version}|${rect.x},${rect.y},${rect.w},${rect.h}|${alignBottom ? 1 : 0}`;
  for (const e of es)
    sig += `|${e.id}\u0001${e.name}\u0001${e.state}\u0001${e.inferred ? 1 : 0}\u0001${e.group}`;
  const hit = cellCache.get(key);
  if (hit && hit.sig === sig) return hit.box;
  const box: CellBox = { ...layoutCell(rect, es, measure, alignBottom), key, row, lane, rect };
  if (cellCache.size > CACHE_MAX) cellCache.clear();
  cellCache.set(key, { sig, box });
  return box;
}

export function geometry(model: ColumnModel, opts: GeometryOptions): Geometry {
  const frame = frameOf(model.bands, opts.pxPerU);
  const rows = opts.bands ? rowsOf(opts.bands) : model.rows;
  const n = Math.max(1, model.lanes.length);
  const left = RULER_W + LABEL_W;
  const laneW = Math.max(LANE_MIN_W, Math.floor((opts.width - left - MARGIN_W) / n));
  const laneX = model.lanes.map((_, i) => left + i * laneW);
  const marginX = left + model.lanes.length * laneW;
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
      const rect = { x: laneX[i] ?? 0, y: box.top, w: laneW, h: box.bottom - box.top };
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
    es: Parameters<typeof layoutCell>[1],
  ): CellBox => {
    const rect = { x, y: 0, w, h: tall };
    const l = layoutCell(rect, es, opts.measure);
    for (const g of [...l.glyphs, ...(l.more ? [l.more] : [])]) used = Math.max(used, g.y + g.h);
    return { ...l, key, row: INBOX_ROW, lane: lane ?? 'biomes', rect };
  };
  model.lanes.forEach((lane, i) => {
    const key = cellKey(INBOX_ROW, lane);
    const es = model.index.cells.get(key);
    if (es && es.length > 0) inboxCells.set(key, lay(key, lane, laneX[i] ?? 0, laneW, es));
  });
  const bandsBox =
    model.index.unplacedBands.length > 0
      ? lay('inbox|bands', null, RULER_W, LABEL_W, model.index.unplacedBands)
      : null;
  let inbox: Geometry['inbox'] = null;
  if (inboxCells.size > 0 || bandsBox) {
    const height = Math.max(CHIP_H + 2 * CELL_PAD, used + CELL_PAD);
    for (const c of [...inboxCells.values(), ...(bandsBox ? [bandsBox] : [])])
      c.rect = { ...c.rect, h: height };
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
