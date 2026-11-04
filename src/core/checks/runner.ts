import type { Entity } from '../model/entity';
import type { Note } from '../model/notes';
import type { WorldSchema } from '../model/schema';
import { getEntity, schemaOf, type World } from '../model/world';
import {
  curveNotes,
  cycleNotes,
  formulaNotes,
  laneCounts,
  laneEmptyNotes,
  laneImbalanceNotes,
  live,
  note,
  nowhereNotes,
  relationNotes,
  requiredNotes,
  unreachableNotes,
} from './checks';
import { compareNames, nameSignature, normaliseName } from './names';
import { createNumbersAdapter, type NumbersAdapter } from './numbers';
import { bandSpans, heightOf, resolvedPlaces, type PlacementFn } from './placement';

/**
 * Runs every mechanical check, incrementally. Worlds are immutable (patches
 * share unchanged objects), so the runner reuses work by identity:
 *
 * - per-entity checks (required fields, relations) are cached per entity and
 *   recomputed only when the entity, the schema or one of its targets changes
 * - names are an index: a renamed entity is compared against the others once,
 *   O(n), instead of every pair again, O(n²)
 * - cycles are recomputed only when an acyclic relation changes
 * - placement, lanes and reachability are O(n) passes, rerun when entities change
 * - numbers are asked again only when the numbers or the entities change
 *
 * A property test proves the incremental result always equals a fresh run.
 */
export interface CheckAdapters {
  placement?: PlacementFn;
  numbers?: NumbersAdapter;
}

export interface CheckRunner {
  run(world: World): Note[];
}

interface EntityCache {
  entity: Entity;
  schema: WorldSchema;
  targets: (Entity | undefined)[];
  y: number | undefined;
  notes: Note[];
}

export function createCheckRunner(adapters: CheckAdapters = {}): CheckRunner {
  const placement = adapters.placement ?? resolvedPlaces;
  const numbers = adapters.numbers ?? createNumbersAdapter();

  let lastEntities: World['entities'] | null = null;
  let lastNumbers: World['numbers'] | null = null;
  let placeNotes: Note[] = [];
  let numberNotes: Note[] = [];
  let ysCache: (id: string) => number | undefined = () => undefined;
  let cycleKey = '';
  let cycleCache: Note[] = [];
  const perEntity = new Map<string, EntityCache>();
  // Names: normalised name per live entity, the matching pairs, and an index from id to its pairs.
  const names = new Map<string, string>();
  const sigs = new Map<string, Uint8Array>();
  const pairs = new Map<string, Note>();
  const pairsOf = new Map<string, Set<string>>();

  const dropPairs = (id: string): void => {
    for (const k of pairsOf.get(id) ?? []) {
      pairs.delete(k);
      for (const other of k.split('|')) if (other !== id) pairsOf.get(other)?.delete(k);
    }
    pairsOf.delete(id);
  };

  function comparePair(world: World, x: string, y: string): void {
    const sx = sigs.get(x);
    const sy = sigs.get(y);
    const m = compareNames(names.get(x) ?? '', names.get(y) ?? '', sx && sy ? [sx, sy] : undefined);
    if (!m) return;
    const [a, b] = x < y ? [x, y] : [y, x];
    const ea = getEntity(world, a) as Entity;
    const eb = getEntity(world, b) as Entity;
    const key = `${a}|${b}`;
    pairs.set(
      key,
      note(
        m === 'same' ? 'duplicate-name' : 'near-duplicate-name',
        `${a}:${b}`,
        m === 'same' ? 'warn' : 'info',
        m === 'same'
          ? `${ea.name} (${ea.kind}) and ${eb.name} (${eb.kind}) have the same name`
          : `${ea.name} (${ea.kind}) and ${eb.name} (${eb.kind}) have nearly the same name`,
        [a, b],
        undefined,
        { a: ea.name, b: eb.name },
      ),
    );
    for (const id of [a, b]) {
      let s = pairsOf.get(id);
      if (!s) pairsOf.set(id, (s = new Set()));
      s.add(key);
    }
  }

  function updateNames(world: World, prev: World['entities'] | null): void {
    const changed = new Set<string>();
    for (const id of [...names.keys()]) {
      if (!live(getEntity(world, id))) {
        names.delete(id);
        sigs.delete(id);
        dropPairs(id);
      }
    }
    for (const e of Object.values(world.entities)) {
      if (!live(e)) continue;
      if (prev && prev[e.id] === e && names.has(e.id)) continue;
      const n = normaliseName(e.name);
      const was = prev?.[e.id];
      if (names.get(e.id) === n && was?.name === e.name && was.kind === e.kind) continue;
      names.set(e.id, n);
      sigs.set(e.id, nameSignature(n));
      changed.add(e.id);
    }
    if (changed.size === 0) return;
    for (const id of changed) dropPairs(id);
    const all = [...names.keys()];
    const done = new Set<string>();
    for (const id of changed) {
      for (const other of all) if (other !== id && !done.has(other)) comparePair(world, id, other);
      done.add(id);
    }
  }

  function acyclicKey(world: World): string {
    const schema = schemaOf(world);
    const parts: string[] = [];
    for (const e of Object.values(world.entities))
      for (const r of e.relations)
        if (schema.relations[r.type]?.acyclic) parts.push(`${e.id}>${r.type}>${r.target}`);
    return parts.sort().join('\n') + `|${Object.keys(world.entities).length}`;
  }

  return {
    run(world) {
      const schema = schemaOf(world);
      const entitiesChanged = world.entities !== lastEntities;
      if (entitiesChanged) {
        const places = placement(world);
        const spans = bandSpans(world);
        const ys = new Map<string, number | undefined>();
        ysCache = (id) => {
          if (!ys.has(id)) ys.set(id, heightOf(places.get(id)?.bands ?? [], spans));
          return ys.get(id);
        };
        const droppedBy = new Map<string, string[]>();
        for (const e of Object.values(world.entities))
          if (live(e))
            for (const r of e.relations)
              if (r.type === 'drops')
                droppedBy.set(r.target, [...(droppedBy.get(r.target) ?? []), e.id]);
        const counts = laneCounts(world, places);
        placeNotes = [
          ...laneEmptyNotes(counts, spans),
          ...laneImbalanceNotes(world, places, spans),
          ...nowhereNotes(world, places, droppedBy),
          ...unreachableNotes(world, ysCache),
        ];
        updateNames(world, lastEntities);
        const ck = acyclicKey(world);
        if (ck !== cycleKey) {
          cycleKey = ck;
          cycleCache = cycleNotes(world, ysCache);
        }
      }
      if (entitiesChanged || world.numbers !== lastNumbers) {
        numberNotes = [
          ...formulaNotes(numbers.formulaProblems(world)),
          ...curveNotes(world, numbers.curveDeviations(world), ysCache),
        ];
      }

      const out: Note[] = [...placeNotes, ...cycleCache, ...pairs.values(), ...numberNotes];
      for (const id of [...perEntity.keys()]) if (!getEntity(world, id)) perEntity.delete(id);
      for (const e of Object.values(world.entities)) {
        const targets = [
          ...e.relations.map((r) => getEntity(world, r.target)),
          ...schema.kinds[e.kind].fields
            .filter((f) => f.type === 'ref' && typeof e.fields[f.key] === 'string')
            .map((f) => getEntity(world, e.fields[f.key] as string)),
        ];
        const y = ysCache(e.id);
        const c = perEntity.get(e.id);
        if (
          c &&
          c.entity === e &&
          c.schema === schema &&
          c.y === y &&
          c.targets.length === targets.length &&
          c.targets.every((t, i) => t === targets[i])
        ) {
          out.push(...c.notes);
          continue;
        }
        const notes = [...requiredNotes(schema, e, y), ...relationNotes(world, e, y)];
        perEntity.set(e.id, { entity: e, schema, targets, y, notes });
        out.push(...notes);
      }
      lastEntities = world.entities;
      lastNumbers = world.numbers;
      // Ids are ASCII (`check:<kind>:<key>`): a plain comparison, much faster than localeCompare.
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}

/** Every check on one world, from scratch. */
export const runChecks = (world: World, adapters: CheckAdapters = {}): Note[] =>
  createCheckRunner(adapters).run(world);
