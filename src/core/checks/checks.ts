import type { Entity } from '../model/entity';
import { LANE_OF_KIND, type Lane, LANES } from '../model/kinds';
import { missingFor } from '../model/lifecycle';
import type { Note } from '../model/notes';
import type { WorldSchema } from '../model/schema';
import { cycleProblems, referenceProblems } from '../model/validate';
import { getEntity, schemaOf, type World } from '../model/world';
import { hashValue } from '../util/hash';
import type { CurveDeviation, FormulaProblem } from './numbers';
import { heightOf, type BandSpan, type Place } from './placement';

/**
 * The mechanical checks (docs/SYSTEM.md §7), each a pure function of the world
 * (plus placement and the numbers engine's answers). Every note has a stable id
 * built from what it is about, and an `inputsHash` of what it says, so a
 * dismissal holds exactly until the inputs change.
 */

/** Check ids, as `Note.kind`. */
export const CHECK_KINDS = [
  'lane-empty',
  'lane-imbalance',
  'material-nowhere',
  'creature-nowhere',
  'item-unreachable',
  'relation',
  'cycle',
  'required-missing',
  'duplicate-name',
  'near-duplicate-name',
  'band-overlap',
  'formula-error',
  'off-curve',
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];

export const live = (e: Entity | undefined): e is Entity => !!e && e.state !== 'graveyard';

export function note(
  kind: CheckKind,
  key: string,
  severity: Note['severity'],
  text: string,
  entities: string[],
  y: number | undefined,
  inputs: unknown,
): Note {
  return {
    id: `check:${kind}:${key}`,
    source: 'check',
    kind,
    severity,
    text,
    entities,
    ...(y !== undefined && Number.isFinite(y) ? { y } : {}),
    inputsHash: hashValue(inputs),
  };
}

const LANE_LABEL: Record<Lane, [string, string]> = {
  biomes: ['biome', 'biomes'],
  materials: ['material', 'materials'],
  creatures: ['creature', 'creatures'],
  structures: ['structure', 'structures'],
  capabilities: ['capability', 'capabilities'],
  items: ['item', 'items'],
  feats: ['feat', 'feats'],
};

const listNames = (names: string[]): string =>
  names.length <= 2
    ? names.join(' and ')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;

/** Per lane, how many live entities sit in each band. */
export function laneCounts(
  world: World,
  places: ReadonlyMap<string, Place>,
): Map<Lane, Map<string, number>> {
  const out = new Map<Lane, Map<string, number>>(LANES.map((l) => [l, new Map()]));
  for (const e of Object.values(world.entities)) {
    const lane = LANE_OF_KIND[e.kind];
    if (!lane || !live(e)) continue;
    const m = out.get(lane) as Map<string, number>;
    for (const b of places.get(e.id)?.bands ?? []) m.set(b, (m.get(b) ?? 0) + 1);
  }
  return out;
}

/**
 * Empty lane over a run of bands: in a lane you've started (it has something
 * somewhere), two or more neighbouring bands with nothing in it.
 */
export function laneEmptyNotes(
  counts: Map<Lane, Map<string, number>>,
  spans: readonly BandSpan[],
  minRun = 2,
): Note[] {
  const notes: Note[] = [];
  if (spans.length < minRun) return notes;
  for (const lane of LANES) {
    const m = counts.get(lane) ?? new Map<string, number>();
    if (![...m.values()].some((n) => n > 0)) continue;
    let run: BandSpan[] = [];
    const flush = (): void => {
      if (run.length >= minRun) {
        const ids = run.map((s) => s.id);
        const first = run[0] as BandSpan;
        const last = run.at(-1) as BandSpan;
        notes.push(
          note(
            'lane-empty',
            `${lane}:${first.id}..${last.id}`,
            'info',
            `No ${LANE_LABEL[lane][1]} in ${listNames(run.map((s) => s.name))}`,
            ids,
            heightOf(ids, spans),
            { lane, ids },
          ),
        );
      }
      run = [];
    };
    for (const s of spans) {
      if ((m.get(s.id) ?? 0) === 0) run.push(s);
      else flush();
    }
    flush();
  }
  return notes;
}

/**
 * Depth/sky imbalance per lane: entities per band below Y 0 against above it
 * (bands that straddle 0 count for neither; an entity counts once per side).
 * Flags a lane with at least `minTotal` such entities when one side is
 * `ratio` times denser than the other.
 */
export function laneImbalanceNotes(
  world: World,
  places: ReadonlyMap<string, Place>,
  spans: readonly BandSpan[],
  ratio = 3,
  minTotal = 4,
): Note[] {
  const depth = spans.filter((s) => s.top <= 0);
  const sky = spans.filter((s) => s.bottom >= 0);
  if (depth.length === 0 || sky.length === 0) return [];
  const depthIds = new Set(depth.map((s) => s.id));
  const skyIds = new Set(sky.map((s) => s.id));
  const notes: Note[] = [];
  // One pass: per lane, entities with a place in the depths and in the sky.
  const sides = new Map<Lane, { d: number; k: number }>(LANES.map((l) => [l, { d: 0, k: 0 }]));
  for (const e of Object.values(world.entities)) {
    const lane = LANE_OF_KIND[e.kind];
    if (!lane || !live(e)) continue;
    const bands = places.get(e.id)?.bands;
    if (!bands || bands.length === 0) continue;
    const side = sides.get(lane) as { d: number; k: number };
    if (bands.some((b) => depthIds.has(b))) side.d++;
    if (bands.some((b) => skyIds.has(b))) side.k++;
  }
  for (const lane of LANES) {
    const { d, k } = sides.get(lane) as { d: number; k: number };
    if (d + k < minTotal) continue;
    const dd = d / depth.length;
    const kd = k / sky.length;
    const [hi, lo, where] = dd > kd ? [dd, kd, 'the depths'] : [kd, dd, 'the sky'];
    if (hi < ratio * lo || hi === lo) continue;
    const heavy = dd > kd ? depth : sky;
    const label = LANE_LABEL[lane][1];
    notes.push(
      note(
        'lane-imbalance',
        lane,
        'info',
        `${label.charAt(0).toUpperCase()}${label.slice(1)} lean to ${where}: ${d} below 0, ${k} above`,
        [],
        heightOf(
          heavy.map((s) => s.id),
          spans,
        ),
        { lane, d, k, depth: depth.length, sky: sky.length },
      ),
    );
  }
  return notes;
}

/** A material found nowhere, a creature living nowhere. */
export function nowhereNotes(
  world: World,
  places: ReadonlyMap<string, Place>,
  droppedBy: ReadonlyMap<string, string[]>,
): Note[] {
  const notes: Note[] = [];
  for (const e of Object.values(world.entities)) {
    if (!live(e)) continue;
    if (e.kind === 'material' && !places.has(e.id) && (droppedBy.get(e.id) ?? []).length === 0)
      notes.push(
        note(
          'material-nowhere',
          e.id,
          'warn',
          'Found nowhere: no biome or band yields it, and nothing drops it',
          [e.id],
          undefined,
          { id: e.id },
        ),
      );
    if (
      e.kind === 'creature' &&
      !e.relations.some(
        (r) =>
          ['lives_in', 'in_band', 'in_biome'].includes(r.type) && live(getEntity(world, r.target)),
      )
    )
      notes.push(
        note(
          'creature-nowhere',
          e.id,
          'warn',
          'Lives nowhere: no biome or band',
          [e.id],
          undefined,
          { id: e.id },
        ),
      );
  }
  return notes;
}

/** Ids an item's route needs, in order. */
export function routeNeeds(e: Entity): string[] {
  const route = e.fields.route;
  if (!Array.isArray(route)) return [];
  const out: string[] = [];
  for (const step of route as unknown[]) {
    if (!step || typeof step !== 'object') continue;
    const needs = (step as { needs?: unknown }).needs;
    if (!Array.isArray(needs)) continue;
    for (const id of needs as unknown[])
      if (typeof id === 'string' && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Unreachable items: a route that needs something that doesn't exist, is in
 * the graveyard, or is itself an unreachable item (route cycles included).
 */
export function unreachableNotes(world: World, ys: (id: string) => number | undefined): Note[] {
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();
  const reachable = (id: string): boolean => {
    const e = getEntity(world, id);
    if (!live(e)) return false;
    if (e.kind !== 'item') return true;
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const ok = routeNeeds(e).every(reachable);
    visiting.delete(id);
    memo.set(id, ok);
    return ok;
  };
  const notes: Note[] = [];
  for (const e of Object.values(world.entities).sort((a, b) => a.id.localeCompare(b.id))) {
    if (e.kind !== 'item' || !live(e)) continue;
    const needs = routeNeeds(e);
    if (needs.length === 0) continue;
    const why: string[] = [];
    const blockers: string[] = [];
    for (const id of needs) {
      const t = getEntity(world, id);
      if (!t) why.push(`"${id}" (doesn't exist)`);
      else if (t.state === 'graveyard') why.push(`${t.name} (in the graveyard)`);
      else if (t.kind === 'item' && !reachable(id)) why.push(`${t.name} (unreachable)`);
      else continue;
      blockers.push(id);
    }
    if (why.length === 0) continue;
    notes.push(
      note(
        'item-unreachable',
        e.id,
        'warn',
        `Unreachable: its route needs ${listNames(why)}`,
        [e.id, ...blockers.filter((b) => getEntity(world, b))],
        ys(e.id),
        { why },
      ),
    );
  }
  return notes;
}

/** Dangling or invalid relations and `ref` fields of one entity. */
export function relationNotes(world: World, e: Entity, y: number | undefined): Note[] {
  return referenceProblems(world, e).map((p) => {
    const idx = Number(p.path[1]);
    const r = p.path[0] === 'relations' ? e.relations[idx] : undefined;
    const about = r ? `${r.type}:${r.target}` : p.path.join('.');
    const target =
      r?.target ??
      (typeof e.fields[p.path[1] ?? ''] === 'string'
        ? (e.fields[p.path[1] ?? ''] as string)
        : undefined);
    return note(
      'relation',
      `${e.id}:${p.code}:${about}`,
      p.severity === 'error' ? 'error' : 'warn',
      p.message.charAt(0).toUpperCase() + p.message.slice(1),
      [e.id, ...(target && target !== e.id && getEntity(world, target) ? [target] : [])],
      y,
      { code: p.code, about, message: p.message },
    );
  });
}

/** Cycles in acyclic relation types (`supersedes`), one note per cycle. */
export function cycleNotes(world: World, ys: (id: string) => number | undefined): Note[] {
  const seen = new Map<string, Note>();
  for (const e of Object.values(world.entities).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!e.relations.some((r) => schemaOf(world).relations[r.type]?.acyclic)) continue;
    for (const p of cycleProblems(world, e)) {
      const m = /^(.+) forms a cycle: (.+)$/.exec(p.message);
      const ids = (m?.[2] ?? '').split(' → ').slice(0, -1);
      const label = m?.[1] ?? 'relation';
      const key = `${label}:${[...ids].sort().join(',')}`;
      if (seen.has(key)) continue;
      // Start the cycle at its smallest id, so the text is the same from every member.
      const start = ids.indexOf([...ids].sort()[0] ?? '');
      const ordered = [...ids.slice(start), ...ids.slice(0, start)];
      const names = ordered.map((id) => getEntity(world, id)?.name ?? id);
      seen.set(
        key,
        note(
          'cycle',
          key.replace(/\s+/g, '_'),
          'error',
          `${label.charAt(0).toUpperCase()}${label.slice(1)} goes in a circle: ${[...names, names[0]].join(' → ')}`,
          ordered,
          ys(ordered[0] ?? ''),
          { ordered },
        ),
      );
    }
  }
  return [...seen.values()];
}

const fieldLabel = (schema: WorldSchema, e: Entity, key: string): string =>
  schema.kinds[e.kind].fields.find((f) => f.key === key)?.label.toLowerCase() ??
  (key === 'why' ? 'why' : key);

/** Required fields missing for the entity's state. */
export function requiredNotes(schema: WorldSchema, e: Entity, y: number | undefined): Note[] {
  if (e.state === 'graveyard') return [];
  const missing = missingFor(schema, e, e.state);
  if (missing.length === 0) return [];
  const labels = missing.map((k) => fieldLabel(schema, e, k));
  const state = e.state.charAt(0).toUpperCase() + e.state.slice(1);
  return [
    note('required-missing', e.id, 'warn', `${state} needs ${listNames(labels)}`, [e.id], y, {
      state: e.state,
      missing,
    }),
  ];
}

/** Formula problems from the numbers engine. */
export function formulaNotes(problems: readonly FormulaProblem[]): Note[] {
  return problems.map((p) =>
    note(
      'formula-error',
      hashValue([p.name ?? '', p.message, p.span ?? null]),
      'error',
      p.name ? `${p.name}: ${p.message}` : p.message,
      [],
      undefined,
      p,
    ),
  );
}

/** Attributes far off their intent curve. */
export function curveNotes(
  world: World,
  ds: readonly CurveDeviation[],
  ys: (id: string) => number | undefined,
): Note[] {
  return ds
    .filter((d) => live(getEntity(world, d.entity)) && Math.abs(d.value - d.expected) > d.tolerance)
    .map((d) =>
      note(
        'off-curve',
        `${d.entity}:${d.attribute}`,
        'warn',
        // Name the entity (a margin note floats) and the curve; the numbers say how far.
        `${getEntity(world, d.entity)?.name ?? d.entity} is far off ${d.attribute}: ${fmt(d.value)}, intent ${fmt(d.expected)} ± ${fmt(d.tolerance)}`,
        [d.entity],
        ys(d.entity),
        d,
      ),
    );
}

const fmt = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(2));

const edge = (v: number): string => String(v);

/**
 * Bands that share heights (EXPERIENCE §2: bands are strips of the Y axis;
 * two over the same heights draw on top of each other on the Column). Bands
 * that only touch are fine. One note per overlapping pair, at the middle of
 * the overlap (clamped at the endless ends, like every height).
 */
export function bandOverlapNotes(spans: readonly BandSpan[]): Note[] {
  const out: Note[] = [];
  for (let i = 0; i < spans.length; i++) {
    const a = spans[i] as BandSpan;
    for (let j = i + 1; j < spans.length; j++) {
      const b = spans[j] as BandSpan;
      if (b.bottom >= a.top) break; // sorted by bottom: nothing later reaches into a
      const lo = Math.max(a.bottom, b.bottom);
      const hi = Math.min(a.top, b.top);
      if (!(hi > lo)) continue;
      const [x, y] = a.id < b.id ? [a, b] : [b, a];
      const where =
        hi === Infinity && lo === -Infinity
          ? 'everywhere'
          : hi === Infinity
            ? `above ${edge(lo)}`
            : lo === -Infinity
              ? `below ${edge(hi)}`
              : `from ${edge(lo)} to ${edge(hi)}`;
      const mid =
        Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : Number.isFinite(lo) ? lo : hi;
      out.push(
        note(
          'band-overlap',
          `${x.id}:${y.id}`,
          'warn',
          `${x.name} and ${y.name} overlap ${where}`,
          [x.id, y.id],
          mid,
          { lo, hi, a: x.name, b: y.name },
        ),
      );
    }
  }
  return out;
}
