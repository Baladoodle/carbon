import { z } from 'zod';
import { ENTITY_KINDS, type EntityKind } from '@core/model/kinds';

/**
 * What the Codex remembers for its viewer, across views and restarts: the
 * tab, the filter, and per tab the sort and the column widths. These are the
 * viewer's settings, not the world's: sorting or widening a column is not a
 * change to the world, so it never becomes an undo step or a file write.
 * Read leniently: a bad entry is dropped, never the rest.
 */
export type Tab = EntityKind | 'all';
export const TABS: Tab[] = ['all', ...ENTITY_KINDS];

export interface Sort {
  col: string;
  dir: 'asc' | 'desc';
}

export interface Prefs {
  tab: Tab;
  query: string;
  sort: Partial<Record<Tab, Sort>>;
  widths: Partial<Record<Tab, Record<string, number>>>;
}

export const MIN_COL_W = 48;
export const MAX_COL_W = 800;
export const clampWidth = (w: number): number =>
  Math.round(Math.max(MIN_COL_W, Math.min(MAX_COL_W, w)));

const SortSchema = z.object({ col: z.string().min(1), dir: z.enum(['asc', 'desc']) });
const isTab = (t: unknown): t is Tab => TABS.includes(t as Tab);

/** Keeps the entries of a record that parse; drops the rest. */
function lenient<T>(
  raw: unknown,
  each: (k: string, v: unknown) => T | undefined,
): Record<string, T> {
  const out: Record<string, T> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    const x = each(k, v);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

export const EMPTY_PREFS: Prefs = { tab: 'all', query: '', sort: {}, widths: {} };

/** Prefs from their stored text (anything unreadable falls back to the defaults). */
export function parsePrefs(text: string | null): Prefs {
  let raw: unknown;
  try {
    raw = JSON.parse(text ?? 'null');
  } catch {
    return EMPTY_PREFS;
  }
  if (!raw || typeof raw !== 'object') return EMPTY_PREFS;
  const p = raw as Record<string, unknown>;
  return {
    tab: isTab(p.tab) ? p.tab : 'all',
    query: typeof p.query === 'string' ? p.query : '',
    sort: lenient(p.sort, (k, v) => {
      const s = SortSchema.safeParse(v);
      return isTab(k) && s.success ? s.data : undefined;
    }),
    widths: lenient(p.widths, (k, v) =>
      isTab(k)
        ? lenient(v, (_, w) =>
            typeof w === 'number' && Number.isFinite(w) ? clampWidth(w) : undefined,
          )
        : undefined,
    ),
  };
}

/** The next sort of a tab when its column `col` is chosen: ascending, descending, off. */
export function cycleSort(prefs: Prefs, tab: Tab, col: string): Prefs {
  const cur = prefs.sort[tab];
  const sort = { ...prefs.sort };
  if (cur?.col !== col) sort[tab] = { col, dir: 'asc' };
  else if (cur.dir === 'asc') sort[tab] = { col, dir: 'desc' };
  else delete sort[tab];
  return { ...prefs, sort };
}

/** A column's width on a tab; `null` goes back to the default. */
export function withWidth(prefs: Prefs, tab: Tab, col: string, w: number | null): Prefs {
  const forTab = { ...(prefs.widths[tab] ?? {}) };
  if (w === null) delete forTab[col];
  else forTab[col] = clampWidth(w);
  return { ...prefs, widths: { ...prefs.widths, [tab]: forTab } };
}
