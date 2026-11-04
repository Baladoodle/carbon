import type { Entity } from '@core/model/entity';
import type { EntityKind } from '@core/model/kinds';
import type { KindSet, RelationTypeDef } from '@core/model/schema';
import { getEntity, schemaOf, type World } from '@core/model/world';

/**
 * Relation rules for the Bench's picker, pure. They mirror what the commands
 * enforce (kinds, no self relations, no duplicates, acyclic types), so the
 * picker only offers relations the store will accept.
 */
const inSet = (set: KindSet, kind: EntityKind): boolean => set === '*' || set.includes(kind);

/** Relation types an entity of this kind can have, in schema order. */
export function relationTypesFrom(world: World, kind: EntityKind): RelationTypeDef[] {
  return Object.values(schemaOf(world).relations).filter((r) => inSet(r.from, kind));
}

/** Whether `to` can reach `from` along `type` (adding from → to would close a cycle). */
function reaches(world: World, type: string, start: string, goal: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === goal) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const r of getEntity(world, id)?.relations ?? [])
      if (r.type === type) stack.push(r.target);
  }
  return false;
}

/** Entities `e` may relate to with `type`, by name. */
export function targetsFor(world: World, e: Entity, type: string): Entity[] {
  const def = schemaOf(world).relations[type];
  if (!def || !inSet(def.from, e.kind)) return [];
  const existing = new Set(e.relations.filter((r) => r.type === type).map((r) => r.target));
  return Object.values(world.entities)
    .filter((t) => t.id !== e.id && inSet(def.to, t.kind) && !existing.has(t.id))
    .filter((t) => !def.acyclic || !reaches(world, type, t.id, e.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface Incoming {
  from: Entity;
  type: string;
  label: string;
  note?: string;
}

/** Relations other entities hold to `id`, read from their side (symmetric ones show as outgoing already). */
export function incomingTo(world: World, id: string): Incoming[] {
  const rels = schemaOf(world).relations;
  const out: Incoming[] = [];
  for (const other of Object.values(world.entities)) {
    if (other.id === id) continue;
    for (const r of other.relations) {
      if (r.target !== id) continue;
      const def = rels[r.type];
      if (def?.symmetric) continue;
      out.push({
        from: other,
        type: r.type,
        label: def?.inverseLabel ?? r.type,
        ...(r.note ? { note: r.note } : {}),
      });
    }
  }
  return out.sort(
    (a, b) => a.label.localeCompare(b.label) || a.from.name.localeCompare(b.from.name),
  );
}

/** Entities a ref field may point to. */
export function refTargets(
  world: World,
  refKinds: readonly EntityKind[] | undefined,
  selfId: string,
): Entity[] {
  return Object.values(world.entities)
    .filter((t) => t.id !== selfId && (!refKinds || refKinds.includes(t.kind)))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
