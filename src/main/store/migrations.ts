import { PATHS, type FileMap } from '@core/files/world-files';
import { WORLD_FORMAT } from '@core/model/world';

/**
 * Versioned migrations of the world directory's files (docs/SYSTEM.md §4).
 *
 * A migration is a pure function from the files of format `from` to the files
 * of format `from + 1` (path → content; a path missing from the result is
 * removed). `down` is its inverse where one exists; the tests prove
 * `down(up(files))` gives the files back. The store makes a backup, writes a
 * marker, applies the chain and writes `carbon.json` last (see migrate.ts).
 *
 * Format 1 is the first format, so the shipped list is empty: the next format
 * change adds `{ from: 1, to: 2, … }` here and bumps `WORLD_FORMAT`.
 */
export interface Migration {
  from: number;
  to: number;
  /** One line for the backup folder's manifest and the build notes. */
  describe: string;
  up: (files: FileMap) => FileMap;
  down?: (files: FileMap) => FileMap;
}

export const MIGRATIONS: readonly Migration[] = [];

/** The format a world's files are in: `carbon.json` → `format`, or 1 when absent or unreadable. */
export function formatOf(files: FileMap): number {
  const text = files.get(PATHS.settings);
  if (text === undefined) return 1;
  try {
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === 'object' && 'format' in raw) {
      const f = raw.format;
      if (typeof f === 'number' && Number.isInteger(f) && f > 0) return f;
    }
  } catch {
    // an unreadable carbon.json is quarantined by the loader; treat it as format 1
  }
  return 1;
}

/** Rewrites `carbon.json`'s `format`, keeping every other key and their order. */
export function withFormat(files: FileMap, format: number): FileMap {
  const out = new Map(files);
  const text = files.get(PATHS.settings);
  let raw: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        raw = parsed as Record<string, unknown>;
    } catch {
      // keep {} and let the loader report the file
    }
  }
  out.set(PATHS.settings, `${JSON.stringify({ ...raw, format }, null, 2)}\n`);
  return out;
}

export type Plan = { ok: true; steps: Migration[] } | { ok: false; message: string };

/** The chain of migrations from one format to another, in either direction. */
export function planMigrations(
  from: number,
  to: number,
  list: readonly Migration[] = MIGRATIONS,
): Plan {
  const steps: Migration[] = [];
  if (from <= to) {
    for (let f = from; f < to; f++) {
      const m = list.find((x) => x.from === f && x.to === f + 1);
      if (!m) return { ok: false, message: `no migration from format ${f} to ${f + 1}` };
      steps.push(m);
    }
  } else {
    for (let f = from; f > to; f--) {
      const m = list.find((x) => x.from === f - 1 && x.to === f);
      if (!m?.down) return { ok: false, message: `format ${f} can't be migrated down to ${f - 1}` };
      steps.push(m);
    }
  }
  return { ok: true, steps };
}

/** Applies a plan to files. Pure; the result's `carbon.json` carries the target format. */
export function migrateFiles(
  files: FileMap,
  from: number,
  to: number,
  list: readonly Migration[] = MIGRATIONS,
): { ok: true; files: FileMap } | { ok: false; message: string } {
  const plan = planMigrations(from, to, list);
  if (!plan.ok) return plan;
  let out: FileMap = new Map(files);
  for (const m of plan.steps) {
    out = from <= to ? m.up(out) : (m.down as (f: FileMap) => FileMap)(out);
    out = withFormat(out, from <= to ? m.to : m.from);
  }
  return { ok: true, files: from === to ? out : withFormat(out, to) };
}

/** Whether a world in this format can be opened and written by this carbon. */
export const formatStatus = (format: number): 'current' | 'older' | 'newer' =>
  format === WORLD_FORMAT ? 'current' : format < WORLD_FORMAT ? 'older' : 'newer';
