import type { Entity } from '../model/entity';
import { heightValue, HeightSchema } from '../model/fields';
import { ITEM_SUBKINDS, LANE_OF_KIND, type EntityState, type Lane } from '../model/kinds';
import type { World } from '../model/world';
import type { Placement } from './placement';
import { toU } from './scale';

/**
 * The Column's geometry, pure and deterministic (no DOM): which rows exist
 * (bands, and the unwritten gaps between them), where they are in content
 * pixels at a zoom, which entities sit in which cell, and where each glyph
 * goes. The view renders this; tests check it.
 */

// ── Bands and rows ──────────────────────────────────────────────────────────

export interface BandSpan {
  id: string;
  name: string;
  state: EntityState;
  /** Y of the lower edge; −Infinity for the endless depths. */
  bottom: number;
  /** Y of the upper edge; +Infinity for the endless sky. */
  top: number;
}

/** A band's span, or null when its edges are missing or invalid (it then waits in the Inbox). */
export function bandSpan(e: Entity): BandSpan | null {
  if (e.kind !== 'band') return null;
  const b = HeightSchema.safeParse(e.fields.y_bottom);
  const t = HeightSchema.safeParse(e.fields.y_top);
  if (!b.success || !t.success) return null;
  let bottom = heightValue(b.data);
  let top = heightValue(t.data);
  if (bottom > top) [bottom, top] = [top, bottom];
  if (bottom === top) return null;
  return { id: e.id, name: e.name, state: e.state, bottom, top };
}

export function bandSpans(world: World): BandSpan[] {
  return Object.values(world.entities)
    .map(bandSpan)
    .filter((b): b is BandSpan => b !== null)
    .sort((a, b) => b.top - a.top || b.bottom - a.bottom || a.id.localeCompare(b.id));
}

export type Row =
  | { kind: 'band'; key: string; band: BandSpan; top: number; bottom: number }
  | { kind: 'gap'; key: string; top: number; bottom: number };

/**
 * Bands top to bottom, with an unwritten gap wherever no band covers a height
 * (including the endless ends when the outermost bands are finite). Rows
 * never overlap except where bands themselves overlap; gaps cover exactly the
 * heights no band covers.
 */
export function rowsOf(bands: readonly BandSpan[]): Row[] {
  const rows: Row[] = [];
  let reach = Infinity; // the lowest height covered so far, coming down from +∞
  let gaps = 0;
  const gap = (top: number, bottom: number): void => {
    rows.push({ kind: 'gap', key: `gap:${gaps++}`, top, bottom });
  };
  for (const b of bands) {
    if (b.top < reach) gap(reach, b.top);
    rows.push({ kind: 'band', key: b.id, band: b, top: b.top, bottom: b.bottom });
    reach = Math.min(reach, b.bottom);
  }
  if (reach > -Infinity) gap(reach, -Infinity);
  return rows;
}

// ── The frame: content pixels at a zoom ─────────────────────────────────────

/** How far past the outermost finite edge the endless ends are drawn, in scale units. */
export const END_PAD_U = 1.1;

export interface Frame {
  /** Scale units at the top and bottom of the content. */
  uHi: number;
  uLo: number;
  pxPerU: number;
  /** Total content height in px. */
  height: number;
}

export function frameOf(bands: readonly BandSpan[], pxPerU: number): Frame {
  const finite = bands
    .flatMap((b) => [b.top, b.bottom])
    .filter(Number.isFinite)
    .map(toU);
  const hi = Math.max(1, ...finite);
  const lo = Math.min(-1, ...finite);
  const uHi = hi + END_PAD_U;
  const uLo = lo - END_PAD_U;
  return { uHi, uLo, pxPerU, height: Math.ceil((uHi - uLo) * pxPerU) };
}

/** Content px of a height (clamped to the frame, so ±∞ map to its ends). */
export function pxOfY(frame: Frame, y: number): number {
  const u = Math.max(frame.uLo, Math.min(frame.uHi, toU(y)));
  return (frame.uHi - u) * frame.pxPerU;
}

/** Content px of a scale unit. */
export const pxOfU = (frame: Frame, u: number): number => (frame.uHi - u) * frame.pxPerU;

/** The scale unit at a content px. */
export const uOfPx = (frame: Frame, px: number): number => frame.uHi - px / frame.pxPerU;

// ── Cells ───────────────────────────────────────────────────────────────────

const STATE_RANK: Record<EntityState, number> = {
  exported: 0,
  decided: 1,
  shaped: 2,
  idea: 3,
  graveyard: 4,
};

export interface CellEntity {
  id: string;
  name: string;
  state: EntityState;
  inferred: boolean;
  /** Group within the cell: an item's subkind, else ''. */
  group: string;
}

export const cellKey = (row: string, lane: Lane): string => `${row}|${lane}`;
export const INBOX_ROW = 'inbox';

export interface CellIndex {
  /** `cellKey(bandId | 'inbox', lane)` → entities in display order. */
  cells: Map<string, CellEntity[]>;
  /** Bands without usable edges (shown in the Inbox, in the ruler column). */
  unplacedBands: CellEntity[];
}

/** An entity's group within its cell: an item's subkind, else ''. */
export function groupOf(e: Entity): string {
  if (e.kind !== 'item') return '';
  return typeof e.fields.subkind === 'string' ? e.fields.subkind : '';
}

const GROUP_ORDER = ['', ...ITEM_SUBKINDS];
const groupRank = (g: string): number => {
  const i = GROUP_ORDER.indexOf(g);
  return i < 0 ? GROUP_ORDER.length : i;
};

export function compareCellEntities(a: CellEntity, b: CellEntity): number {
  return (
    groupRank(a.group) - groupRank(b.group) ||
    a.group.localeCompare(b.group) ||
    STATE_RANK[a.state] - STATE_RANK[b.state] ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Which entities sit in which cell. An entity with places in several bands
 * shows in each; with none, in the Inbox row of its lane.
 */
export function cellIndex(
  world: World,
  placements: ReadonlyMap<string, Placement>,
  opts: { graveyard: boolean },
): CellIndex {
  const cells = new Map<string, CellEntity[]>();
  const unplacedBands: CellEntity[] = [];
  const push = (key: string, c: CellEntity): void => {
    const list = cells.get(key);
    if (list) list.push(c);
    else cells.set(key, [c]);
  };
  for (const e of Object.values(world.entities)) {
    if (!opts.graveyard && e.state === 'graveyard') continue;
    const lane = LANE_OF_KIND[e.kind];
    const p = placements.get(e.id);
    const base = { id: e.id, name: e.name, state: e.state, group: groupOf(e) };
    if (lane === null) {
      if (bandSpan(e) === null) unplacedBands.push({ ...base, inferred: false });
      continue;
    }
    if (!p || p.places.length === 0) {
      push(cellKey(INBOX_ROW, lane), { ...base, inferred: false });
      continue;
    }
    for (const band of new Set(p.places.map((x) => x.band)))
      push(cellKey(band, lane), { ...base, inferred: p.inferred });
  }
  for (const list of cells.values()) list.sort(compareCellEntities);
  unplacedBands.sort(compareCellEntities);
  return { cells, unplacedBands };
}

// ── Glyphs inside a cell ────────────────────────────────────────────────────

export const CHIP_H = 20;
export const CHIP_GAP = 4;
export const CELL_PAD = 5;
/** Chip padding left (before the state glyph) and right, and the glyph's width plus gap. */
const CHIP_PAD_L = 6;
const CHIP_PAD_R = 7;
const CHIP_GLYPH = 14;
/** The "+N" chip's minimum width. */
const MORE_MIN_W = 28;
/** The narrowest a chip may shrink to beside a "+N" chip. */
const SHRINK_MIN_W = 44;

/** Measures text width in px at the chip font. Injected so layout stays pure. */
export type Measure = (text: string) => number;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Glyph extends Rect {
  id: string;
  /** The name as shown (possibly truncated with an ellipsis). */
  text: string;
  state: EntityState;
  inferred: boolean;
}

export interface CellLayout {
  /** Glyphs that fit, in navigation order. */
  glyphs: Glyph[];
  /** Ids that didn't fit (counted on the "+N" chip). */
  hidden: string[];
  /** The "+N" chip, when something is hidden. */
  more: (Rect & { count: number }) | null;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Where each grapheme (a character as a person sees it) ends, in UTF-16 units. */
export function graphemeEnds(text: string): number[] {
  const ends: number[] = [];
  for (const g of segmenter.segment(text)) ends.push(g.index + g.segment.length);
  return ends;
}

/**
 * Truncates `text` with an ellipsis so it measures at most `max` px. It cuts
 * only between graphemes, so an emoji, an accented letter or a ZWJ sequence
 * is never split into broken halves.
 */
export function fitText(text: string, max: number, measure: Measure): string {
  if (measure(text) <= max) return text;
  if (max <= measure('…')) return '';
  const ends = graphemeEnds(text);
  const cut = (k: number): string => `${text.slice(0, ends[k - 1] ?? 0).trimEnd()}…`;
  let lo = 0;
  let hi = ends.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(cut(mid)) <= max) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '…' : cut(lo);
}

/**
 * Packs a cell's entities as chips, left to right in lines, a new line for
 * each item subkind group. Lines align to the top of the cell, or to the
 * bottom when `alignBottom` (an endless-sky band, whose finite edge is at its
 * bottom). Whatever doesn't fit is counted on a final "+N" chip.
 */
export function layoutCell(
  rect: Rect,
  entities: readonly CellEntity[],
  measure: Measure,
  alignBottom = false,
): CellLayout {
  const innerW = Math.max(0, rect.w - 2 * CELL_PAD);
  const maxLines = Math.max(
    0,
    Math.floor((rect.h - 2 * CELL_PAD + CHIP_GAP) / (CHIP_H + CHIP_GAP)),
  );
  if (entities.length === 0 || innerW < MORE_MIN_W)
    return { glyphs: [], hidden: entities.map((e) => e.id), more: null };
  const maxTextW = Math.max(0, innerW - CHIP_PAD_L - CHIP_GLYPH - CHIP_PAD_R);

  // Lines of chips (x and widths); y comes once we know how many lines show.
  interface Placed {
    e: CellEntity;
    x: number;
    w: number;
    text: string;
    line: number;
  }
  const placed: Placed[] = [];
  let line = 0;
  let x = 0;
  let group: string | null = null;
  for (const e of entities) {
    const text = fitText(e.name, maxTextW, measure);
    const w = Math.min(innerW, Math.ceil(CHIP_PAD_L + CHIP_GLYPH + measure(text) + CHIP_PAD_R));
    const newGroup = group !== null && e.group !== group;
    if (x > 0 && (newGroup || x + w > innerW)) {
      line++;
      x = 0;
    }
    group = e.group;
    placed.push({ e, x, w, text, line });
    x += w + CHIP_GAP;
  }
  const lines = line + 1;

  let shown = placed;
  let more: CellLayout['more'] = null;
  if (lines > maxLines) {
    // Keep what fits in maxLines, leaving room for the "+N" chip on the last line.
    if (maxLines === 0) {
      shown = [];
    } else {
      shown = placed.filter((p) => p.line < maxLines);
      const last = maxLines - 1;
      const moreW = (n: number): number =>
        Math.max(MORE_MIN_W, Math.ceil(CHIP_PAD_L + measure(`+${n}`) + CHIP_PAD_R));
      for (;;) {
        const onLast = shown.filter((p) => p.line === last);
        const tail = onLast[onLast.length - 1];
        const end = tail ? tail.x + tail.w + CHIP_GAP : 0;
        const n = placed.length - shown.length;
        if (end + moreW(n) <= innerW || !tail) {
          more = { x: end, y: 0, w: Math.min(innerW, moreW(n)), h: CHIP_H, count: n };
          break;
        }
        // Rather than drop the tail chip, shrink it (shorter name) when it can still say something.
        const room = innerW - tail.x - CHIP_GAP - moreW(n);
        if (room >= SHRINK_MIN_W && room < tail.w) {
          const text = fitText(tail.e.name, room - CHIP_PAD_L - CHIP_GLYPH - CHIP_PAD_R, measure);
          if (text !== '' && text !== '…') {
            const w = Math.ceil(CHIP_PAD_L + CHIP_GLYPH + measure(text) + CHIP_PAD_R);
            shown = [...shown.slice(0, -1), { ...tail, w, text }];
            continue;
          }
        }
        shown = shown.slice(0, -1);
      }
    }
  }

  const usedLines = more ? maxLines : Math.min(lines, maxLines);
  const blockH = usedLines * CHIP_H + Math.max(0, usedLines - 1) * CHIP_GAP;
  const y0 = alignBottom
    ? rect.y + Math.max(CELL_PAD, rect.h - CELL_PAD - blockH)
    : rect.y + CELL_PAD;
  const yOf = (l: number): number => y0 + l * (CHIP_H + CHIP_GAP);
  const glyphs: Glyph[] = shown.map((p) => ({
    id: p.e.id,
    text: p.text,
    state: p.e.state,
    inferred: p.e.inferred,
    x: rect.x + CELL_PAD + p.x,
    y: yOf(p.line),
    w: p.w,
    h: CHIP_H,
  }));
  if (more) more = { ...more, x: rect.x + CELL_PAD + more.x, y: yOf(maxLines - 1) };
  const shownIds = new Set(shown.map((p) => p.e.id));
  return { glyphs, hidden: entities.filter((e) => !shownIds.has(e.id)).map((e) => e.id), more };
}

// ── Notes in the margin ─────────────────────────────────────────────────────

export interface MarginItem {
  id: string;
  /** Where it wants to be (content px, the top of the note). */
  want: number;
  height: number;
}

/**
 * Stacks margin notes near their heights without overlapping: in order of
 * `want`, each goes at its height or just below the previous one. Returns
 * tops in the same order as the input.
 */
export function stackMargin(items: readonly MarginItem[], gap = 6): number[] {
  const order = items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => a.it.want - b.it.want || a.i - b.i);
  const tops = new Array<number>(items.length).fill(0);
  let floor = -Infinity;
  for (const { it, i } of order) {
    const top = Math.max(it.want, floor);
    tops[i] = top;
    floor = top + it.height + gap;
  }
  return tops;
}
