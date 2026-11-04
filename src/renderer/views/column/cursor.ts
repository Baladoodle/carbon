/**
 * Keyboard navigation on the Column (docs/EXPERIENCE.md §2), pure.
 *
 * The cursor is a row (a band, an unwritten gap, or the Inbox), a lane (−1 is
 * the band column on the ruler) and optionally an entity in that cell.
 * `j`/`k` walk down and up through what's in the current lane: each entity of
 * a cell in turn, or the empty cell itself, then on to the next row. `h`/`l`
 * change lane in the same row, keeping the position within the cell where
 * they can.
 */
export interface Cursor {
  row: string;
  /** Index into the visible lanes; −1 is the band column. */
  lane: number;
  entity: string | null;
}

export interface NavContext {
  /** Row keys top to bottom (bands and gaps, then `inbox` when it's shown). */
  rows: readonly string[];
  laneCount: number;
  /** Entities in a cell, in display order. Lane −1: the row's band (if any). */
  entitiesAt: (row: string, lane: number) => readonly string[];
}

interface Stop {
  row: string;
  entity: string | null;
}

/** Every stop in a lane, top to bottom. */
export function stopsOf(ctx: NavContext, lane: number): Stop[] {
  const out: Stop[] = [];
  for (const row of ctx.rows) {
    const es = ctx.entitiesAt(row, lane);
    if (es.length === 0) out.push({ row, entity: null });
    else for (const entity of es) out.push({ row, entity });
  }
  return out;
}

const clampLane = (ctx: NavContext, lane: number): number =>
  Math.max(-1, Math.min(ctx.laneCount - 1, lane));

/** A valid cursor near `c` (after the world, the lanes or the zoom changed). */
export function normalize(ctx: NavContext, c: Cursor, fallbackRow?: string): Cursor {
  const lane = clampLane(ctx, c.lane);
  const row = ctx.rows.includes(c.row)
    ? c.row
    : fallbackRow !== undefined && ctx.rows.includes(fallbackRow)
      ? fallbackRow
      : (ctx.rows[0] ?? '');
  const es = ctx.entitiesAt(row, lane);
  const entity = c.entity !== null && es.includes(c.entity) ? c.entity : (es[0] ?? null);
  return { row, lane, entity };
}

/** One step down (`+1`, j) or up (`−1`, k) in the current lane. */
export function step(ctx: NavContext, c: Cursor, dir: 1 | -1): Cursor {
  const stops = stopsOf(ctx, c.lane);
  let i = stops.findIndex((s) => s.row === c.row && s.entity === c.entity);
  if (i < 0) i = stops.findIndex((s) => s.row === c.row);
  if (i < 0) return normalize(ctx, c);
  const next = stops[Math.max(0, Math.min(stops.length - 1, i + dir))];
  return next ? { row: next.row, lane: c.lane, entity: next.entity } : c;
}

/** One lane left (`−1`, h) or right (`+1`, l), keeping the row and the position in the cell. */
export function side(ctx: NavContext, c: Cursor, dir: 1 | -1): Cursor {
  const lane = clampLane(ctx, c.lane + dir);
  if (lane === c.lane) return c;
  const here = ctx.entitiesAt(c.row, c.lane);
  const at = c.entity === null ? 0 : Math.max(0, here.indexOf(c.entity));
  const there = ctx.entitiesAt(c.row, lane);
  return { row: c.row, lane, entity: there[Math.min(at, there.length - 1)] ?? null };
}

/** The cursor on a row and lane, at the cell's first entity. */
export function at(ctx: NavContext, row: string, lane: number): Cursor {
  return normalize(ctx, { row, lane, entity: null });
}
