import type { Command } from '@core/commands/registry';
import { cmd } from '@core/commands/registry';
import type { Entity } from '@core/model/entity';
import { HeightSchema, type FieldDef } from '@core/model/fields';
import type { EntityKind, EntityState } from '@core/model/kinds';
import { canTransition, missingFor } from '@core/model/lifecycle';
import type { WorldSchema } from '@core/model/schema';
import type { World } from '@core/model/world';
import type { Placement, Placements } from '@core/placement';
import { err, ok, type Result } from '@core/util/result';

/**
 * The Codex's columns, driven by `schemaOf(world)`: which columns a tab has,
 * how a cell reads, how it sorts and how an inline edit turns into a command.
 * Pure, so it's tested without a DOM.
 */

export type CellEdit =
  | { type: 'text'; key: string }
  | { type: 'number'; key: string; min?: number; max?: number }
  | { type: 'range'; key: string }
  | { type: 'height'; key: string }
  | { type: 'list'; key: string }
  | { type: 'enum'; key: string; options: string[] }
  | { type: 'ref'; key: string; refKinds: EntityKind[] }
  | { type: 'boolean'; key: string }
  | { type: 'attribute'; key: string };

export interface CellCtx {
  world: World;
  placements: Placements;
}

export interface Column {
  id: string;
  label: string;
  /** Mono, tabular, right-aligned. */
  numeric: boolean;
  mono: boolean;
  /** Pixel width (the table is fixed-layout so virtualised rows don't jitter). */
  width: number;
  /** What the cell shows. */
  text: (e: Entity, ctx: CellCtx) => string;
  /** De-emphasised (e.g. an inferred placement, VISUAL.md §2 `--text-3`). */
  dim?: (e: Entity, ctx: CellCtx) => boolean;
  /** Sort key: numbers sort numerically, strings case-insensitively, null last. */
  sort: (e: Entity, ctx: CellCtx) => number | string | null;
  /** How an inline edit works here (null: edit on the Bench). */
  edit: CellEdit | null;
}

const fmtNum = (n: number): string =>
  n === Infinity
    ? '+∞'
    : n === -Infinity
      ? '−∞'
      : Number.isInteger(n)
        ? String(n)
        : String(Math.round(n * 100) / 100);

const fmtHeight = (v: unknown): string => {
  const h = HeightSchema.safeParse(v);
  if (!h.success) return '';
  return h.data === '-inf' ? '−∞' : h.data === '+inf' ? '+∞' : fmtNum(h.data);
};
const heightNum = (v: unknown): number | null => {
  const h = HeightSchema.safeParse(v);
  if (!h.success) return null;
  return h.data === '-inf' ? -Infinity : h.data === '+inf' ? Infinity : h.data;
};

const firstLine = (s: string): string => s.split('\n').find((l) => l.trim() !== '') ?? '';

const isRange = (v: unknown): v is { min: number; max: number } =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as { min?: unknown }).min === 'number' &&
  typeof (v as { max?: unknown }).max === 'number';

/** How a field's value reads in a cell. */
export function formatField(def: FieldDef, v: unknown, world: World): string {
  if (v === undefined || v === null) return '';
  switch (def.type) {
    case 'text':
      return typeof v === 'string' ? v : '';
    case 'longtext':
      return typeof v === 'string' ? firstLine(v) : '';
    case 'number':
      return typeof v === 'number' ? fmtNum(v) : '';
    case 'range':
      return isRange(v) ? `${fmtNum(v.min)}–${fmtNum(v.max)}` : '';
    case 'enum':
      return typeof v === 'string' ? v : '';
    case 'list':
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '';
    case 'height':
      return fmtHeight(v);
    case 'ref':
      return typeof v === 'string' ? (world.entities[v]?.name ?? v) : '';
    case 'climate': {
      const c = v as { temperature?: unknown; moisture?: unknown };
      if (!isRange(c.temperature) || !isRange(c.moisture)) return '';
      const f = (r: { min: number; max: number }): string =>
        `${r.min.toFixed(2)}–${r.max.toFixed(2)}`;
      return `${f(c.temperature)} × ${f(c.moisture)}`;
    }
    case 'steps':
      return Array.isArray(v)
        ? v.map((s: { text?: unknown }) => (typeof s.text === 'string' ? s.text : '')).join(' → ')
        : '';
    case 'boolean':
      return v === true ? '✓' : '';
  }
}

function sortField(def: FieldDef, v: unknown, world: World): number | string | null {
  if (v === undefined || v === null) return null;
  switch (def.type) {
    case 'number':
      return typeof v === 'number' ? v : null;
    case 'range':
      return isRange(v) ? v.max * 1e6 + v.min : null;
    case 'height':
      return heightNum(v);
    case 'boolean':
      return v === true ? 1 : 0;
    case 'steps':
      return Array.isArray(v) ? v.length : null;
    case 'enum':
      // Options are ordered (e.g. rarity common → legendary): sort by position.
      return typeof v === 'string' && def.options ? def.options.indexOf(v) : null;
    default: {
      const s = formatField(def, v, world);
      return s === '' ? null : s;
    }
  }
}

function editOf(def: FieldDef): CellEdit | null {
  switch (def.type) {
    case 'text':
    case 'longtext':
      return { type: 'text', key: def.key };
    case 'number':
      return {
        type: 'number',
        key: def.key,
        ...(def.min !== undefined ? { min: def.min } : {}),
        ...(def.max !== undefined ? { max: def.max } : {}),
      };
    case 'range':
      return { type: 'range', key: def.key };
    case 'height':
      return { type: 'height', key: def.key };
    case 'list':
      return { type: 'list', key: def.key };
    case 'enum':
      return def.options && def.options.length > 0
        ? { type: 'enum', key: def.key, options: def.options }
        : { type: 'text', key: def.key };
    case 'ref':
      return { type: 'ref', key: def.key, refKinds: def.refKinds ?? [] };
    case 'boolean':
      return { type: 'boolean', key: def.key };
    case 'climate':
    case 'steps':
      return null;
  }
}

const placeText = (p: Placement | undefined, world: World): string =>
  p ? p.bands.map((b) => world.entities[b]?.name ?? b).join(', ') : '';

const NUMERIC_TYPES = new Set(['number', 'range', 'height']);

/** The columns of a tab: a kind, or `all` (every kind, common columns only). */
export function columnsFor(tab: EntityKind | 'all', schema: WorldSchema): Column[] {
  const cols: Column[] = [
    {
      id: 'name',
      label: 'Name',
      numeric: false,
      mono: false,
      width: 200,
      text: (e) => e.name,
      sort: (e) => e.name,
      edit: { type: 'text', key: 'name' },
    },
  ];
  if (tab === 'all')
    cols.push({
      id: 'kind',
      label: 'Kind',
      numeric: false,
      mono: false,
      width: 96,
      text: (e) => schema.kinds[e.kind].label,
      sort: (e) => schema.kinds[e.kind].label,
      edit: null,
    });
  cols.push({
    id: 'identity',
    label: 'Identity',
    numeric: false,
    mono: false,
    width: 260,
    text: (e) => e.identity,
    sort: (e) => (e.identity === '' ? null : e.identity),
    edit: { type: 'text', key: 'identity' },
  });
  if (tab !== 'band')
    cols.push({
      id: 'band',
      label: 'Band',
      numeric: false,
      mono: false,
      width: 140,
      text: (e, c) => placeText(c.placements[e.id], c.world),
      dim: (e, c) => c.placements[e.id]?.mode === 'inferred',
      // Bottom of the placement, so sorting by band reads depth → sky.
      sort: (e, c) => c.placements[e.id]?.y?.min ?? null,
      edit: null,
    });
  if (tab === 'all') return cols;
  const kind = schema.kinds[tab];
  for (const f of kind.fields) {
    // A biome's band field is the Band column already.
    if (tab === 'biome' && f.key === 'band') continue;
    const numeric = NUMERIC_TYPES.has(f.type);
    cols.push({
      id: `f:${f.key}`,
      label: f.label,
      numeric,
      mono: numeric || f.type === 'climate',
      width:
        f.type === 'longtext' || f.type === 'steps'
          ? 240
          : f.type === 'climate'
            ? 170
            : numeric
              ? 88
              : f.type === 'boolean'
                ? 64
                : 140,
      text: (e, c) => formatField(f, e.fields[f.key], c.world),
      sort: (e, c) => sortField(f, e.fields[f.key], c.world),
      edit: editOf(f),
    });
  }
  for (const a of kind.attributes)
    cols.push({
      id: `a:${a.key}`,
      label: a.label ?? a.key,
      numeric: true,
      mono: true,
      width: 88,
      text: (e) => {
        const v = e.attributes[a.key];
        return v === undefined ? '' : fmtNum(v);
      },
      sort: (e) => e.attributes[a.key] ?? null,
      edit: { type: 'attribute', key: a.key },
    });
  return cols;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** Sorts rows by a column (stable; empty values last in both directions; ties by name, then id). */
export function sortEntities(
  rows: readonly Entity[],
  col: Column | undefined,
  dir: 'asc' | 'desc',
  ctx: CellCtx,
): Entity[] {
  const tie = (a: Entity, b: Entity): number =>
    collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (!col) return [...rows].sort(tie);
  const keyed = rows.map((e) => ({ e, k: col.sort(e, ctx) }));
  const sign = dir === 'asc' ? 1 : -1;
  keyed.sort((a, b) => {
    if (a.k === null || b.k === null) return a.k === b.k ? tie(a.e, b.e) : a.k === null ? 1 : -1;
    const c =
      typeof a.k === 'number' && typeof b.k === 'number'
        ? a.k - b.k
        : collator.compare(String(a.k), String(b.k));
    return c !== 0 ? sign * c : tie(a.e, b.e);
  });
  return keyed.map((x) => x.e);
}

/** The text an inline edit starts from. */
export function draftOf(edit: CellEdit, e: Entity): string {
  const v =
    edit.type === 'attribute'
      ? e.attributes[edit.key]
      : edit.key === 'name' || edit.key === 'identity'
        ? e[edit.key]
        : e.fields[edit.key];
  if (v === undefined || v === null) return '';
  switch (edit.type) {
    case 'range':
      return isRange(v) ? `${v.min}..${v.max}` : '';
    case 'list':
      return Array.isArray(v) ? v.join(', ') : '';
    case 'height':
      return typeof v === 'number' || typeof v === 'string' ? String(v) : '';
    case 'number':
    case 'attribute':
      return typeof v === 'number' ? String(v) : '';
    default:
      return typeof v === 'string' ? v : '';
  }
}

const num = (s: string): number | null => {
  const t = s.trim().replace('−', '-');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * Turns an inline edit's text into a command for the entity, or an error to
 * show under the cell. An empty draft clears the value (except the name).
 */
export function commandForEdit(edit: CellEdit, e: Entity, draft: string): Result<Command> {
  const t = draft.trim();
  const set = (value: unknown): Result<Command> =>
    edit.key === 'name' || edit.key === 'identity'
      ? ok(cmd('entity.update', { id: e.id, set: { [edit.key]: value } }))
      : ok(cmd('entity.setField', { id: e.id, field: edit.key, value }));
  switch (edit.type) {
    case 'text':
      if (edit.key === 'name' && t === '') return err('edit.empty', 'a name is needed');
      return set(t === '' ? null : edit.key === 'name' ? t : draft);
    case 'attribute': {
      if (t === '') return ok(cmd('entity.setAttribute', { id: e.id, key: edit.key, value: null }));
      const n = num(t);
      if (n === null) return err('edit.number', 'a number');
      return ok(cmd('entity.setAttribute', { id: e.id, key: edit.key, value: n }));
    }
    case 'number': {
      if (t === '') return set(null);
      const n = num(t);
      if (n === null) return err('edit.number', 'a number');
      if (edit.min !== undefined && n < edit.min) return err('edit.min', `at least ${edit.min}`);
      if (edit.max !== undefined && n > edit.max) return err('edit.max', `at most ${edit.max}`);
      return set(n);
    }
    case 'range': {
      if (t === '') return set(null);
      const m = /^(-?[\d.]+)\s*(?:\.\.|–|—|-|to)\s*(-?[\d.]+)$/.exec(t.replace('−', '-'));
      const single = num(t);
      const lo = m ? num(m[1] ?? '') : single;
      const hi = m ? num(m[2] ?? '') : single;
      if (lo === null || hi === null) return err('edit.range', 'a range like 2..5');
      if (lo > hi) return err('edit.range', 'the low end comes first');
      return set({ min: lo, max: hi });
    }
    case 'height': {
      if (t === '') return set(null);
      const l = t.toLowerCase().replace('−', '-');
      if (l === '-inf' || l === '-∞') return set('-inf');
      if (l === '+inf' || l === 'inf' || l === '+∞' || l === '∞') return set('+inf');
      const n = num(t);
      if (n === null) return err('edit.height', 'a height, or -inf / +inf');
      return set(n);
    }
    case 'list': {
      const items = t
        .split(',')
        .map((x) => x.trim())
        .filter((x) => x !== '');
      return set(items.length === 0 ? null : items);
    }
    case 'enum':
      if (t === '') return set(null);
      if (!edit.options.includes(t)) return err('edit.option', `one of ${edit.options.join(', ')}`);
      return set(t);
    case 'ref':
      return set(t === '' ? null : t);
    case 'boolean':
      return set(e.fields[edit.key] === true ? null : true);
  }
}

// ── Bulk state changes ───────────────────────────────────────────────────────

export interface BulkPlan {
  commands: Command[];
  /** Entities left out, with why (shown after the change). */
  skipped: { id: string; reason: string }[];
}

/**
 * Plans one state change over many entities, as one transaction. Entities that
 * can't make the move (wrong transition, missing fields) are left out with a
 * reason, so the rest still change. `why` fills in a missing Why when deciding;
 * `killed` is the reason when sending to the graveyard.
 */
export function planBulkState(
  world: World,
  schema: WorldSchema,
  ids: readonly string[],
  state: EntityState,
  opts: { why?: string; killed?: { reason: string; note?: string }; reasonKey?: string } = {},
): BulkPlan {
  const commands: Command[] = [];
  const skipped: BulkPlan['skipped'] = [];
  for (const id of ids) {
    const e = world.entities[id];
    if (!e) {
      skipped.push({ id, reason: 'no longer exists' });
      continue;
    }
    if (e.state === state) {
      skipped.push({ id, reason: `already ${state}` });
      continue;
    }
    // An idea is decided by way of shaped, in the same step (as on the Bench).
    const via = viaOf(e.state, state);
    if (!canTransition(e.state, state) && via === null) {
      skipped.push({ id, reason: `can't go from ${e.state} to ${state}` });
      continue;
    }
    const why = e.why.trim() === '' && opts.why?.trim() ? opts.why.trim() : undefined;
    const next: Entity = { ...e, state, why: why ?? e.why };
    const missing = [
      ...(via ? missingFor(schema, { ...e, state: via }, via) : []),
      ...missingFor(schema, next, state),
    ].filter((k, i, all) => all.indexOf(k) === i);
    if (missing.length > 0) {
      skipped.push({ id, reason: `needs ${missing.join(', ')}` });
      continue;
    }
    if (state === 'graveyard' && !opts.killed) {
      skipped.push({ id, reason: 'needs a kill reason' });
      continue;
    }
    if (via) commands.push(cmd('entity.setState', { id, state: via }));
    commands.push(
      cmd('entity.setState', {
        id,
        state,
        ...(why !== undefined ? { why } : {}),
        ...(state === 'graveyard' && opts.killed ? { killed: opts.killed } : {}),
      }),
    );
  }
  // Each kill counts its reason in Taste (EXPERIENCE §6), in the same undo step.
  if (state === 'graveyard' && opts.reasonKey && commands.length > 0)
    commands.push(cmd('taste.countReason', { key: opts.reasonKey, by: commands.length }));
  return { commands, skipped };
}

/** The state a move passes through when there's no direct transition (idea → decided). */
export const viaOf = (from: EntityState, to: EntityState): EntityState | null =>
  from === 'idea' && to === 'decided' ? 'shaped' : null;

/** Whether an entity in `from` can be moved to `to` by a bulk change. */
export const canMove = (from: EntityState, to: EntityState): boolean =>
  canTransition(from, to) || viaOf(from, to) !== null;

/** Whether any of these entities would need a Why to become decided. */
export const needsWhy = (world: World, ids: readonly string[]): boolean =>
  ids.some((id) => {
    const e = world.entities[id];
    return !!e && e.why.trim() === '' && canMove(e.state, 'decided');
  });
