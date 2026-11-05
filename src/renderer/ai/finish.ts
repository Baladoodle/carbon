import type { Entity } from '@core/model/entity';
import type { EntityId } from '@core/model/ids';
import { EDITABLE_COMMON_FIELDS } from '@core/model/schema';
import type { World } from '@core/model/world';
import { hashValue } from '@core/util/hash';

type Trigger = 'finish_edit' | 'state_change';

export interface FinishDeps {
  getWorld: () => World | null | undefined;
  /** Runs the critique moment and publishes its notes (the Bench's controller). */
  critique: (id: EntityId, trigger: Trigger) => Promise<void>;
  /** Resolves once the edits in flight for an entity have landed. */
  settled: (id: EntityId) => Promise<unknown>;
  /** Automatic critiques stay quiet while the AI is off or paused. */
  allowed: () => boolean;
}

/**
 * Each field of an entity as a hash, keyed as `ai_fields` keys them: the common
 * fields, kind fields by their key, attributes as `attributes.<key>`, and the
 * relations as one pseudo-field (only you write relations).
 */
export type FieldSnapshot = Readonly<Record<string, string>>;

export function fieldSnapshot(e: Entity): FieldSnapshot {
  const out: Record<string, string> = {};
  for (const k of EDITABLE_COMMON_FIELDS) out[k] = hashValue(e[k]);
  for (const [k, v] of Object.entries(e.fields)) out[k] = hashValue(v ?? null);
  for (const [k, v] of Object.entries(e.attributes)) out[`attributes.${k}`] = hashValue(v);
  out.relations = hashValue(e.relations);
  return out;
}

/**
 * The fields YOU changed since the baseline: those that differ from it and
 * aren't AI-marked now. A value the AI wrote that you haven't touched is in
 * `ai_fields`, so it doesn't count; once you edit it, the command takes it out
 * of `ai_fields`, so it does. Sorted.
 */
export function userChangedFields(base: FieldSnapshot, e: Entity): string[] {
  const now = fieldSnapshot(e);
  const ai = new Set(e.ai_fields);
  const keys = new Set([...Object.keys(base), ...Object.keys(now)]);
  return [...keys].filter((k) => base[k] !== now[k] && !ai.has(k)).sort();
}

/**
 * When an automatic critique runs (EXPERIENCE §5), in one place for the whole
 * app. "Finishing an edit" means the entity changed since it came into focus
 * (or since its last critique) and then: focus moved to another entity, the
 * Bench lost focus or closed, or `ctrl+s`. A state change made in carbon
 * critiques too. An entity you didn't change is never sent, and neither is
 * one only the AI changed: accepting suggestions and fill proposals alone
 * doesn't ask the critic to judge the AI's own words (SYSTEM §8a).
 *
 * The baseline is the entity's `updated` stamp plus a snapshot of its fields,
 * so edits made anywhere (the Bench, the Codex, Climate) count, and the edit
 * that a blur commits is awaited (`settled`) before the comparison.
 */
export function createFinishTriggers(deps: FinishDeps) {
  /** Each tracked entity at its baseline: its `updated` stamp and its fields. */
  const baseline = new Map<EntityId, { updated: string; fields: FieldSnapshot }>();
  let focus: EntityId | null = null;

  const snap = (e: Entity) => ({ updated: e.updated, fields: fieldSnapshot(e) });

  /** Finishing an edit of `id`: critique it if it changed since its baseline. */
  async function finish(id: EntityId): Promise<void> {
    await deps.settled(id);
    const e = deps.getWorld()?.entities[id];
    const base = baseline.get(id);
    if (!e || base === undefined || e.updated === base.updated || e.state === 'graveyard') return;
    // Only the AI changed it (accepted suggestions or proposals): nothing of yours to judge.
    if (userChangedFields(base.fields, e).length === 0) return;
    if (!deps.allowed()) return;
    baseline.set(id, snap(e));
    await deps.critique(id, 'finish_edit');
  }

  /** Focus moved: finish the entity you left, start tracking the new one. */
  function focusChanged(next: EntityId | null): Promise<void> {
    if (next === focus) return Promise.resolve();
    const left = focus;
    focus = next;
    if (next) {
      const e = deps.getWorld()?.entities[next];
      if (e) baseline.set(next, snap(e));
    }
    if (!left) return Promise.resolve();
    return finish(left).then(() => {
      if (focus !== left) baseline.delete(left);
    });
  }

  /** States changed in carbon: critique each (not into the graveyard). */
  function statesChanged(ids: readonly EntityId[]): Promise<void> {
    if (!deps.allowed()) return Promise.resolve();
    const runs: Promise<void>[] = [];
    for (const id of ids) {
      const e = deps.getWorld()?.entities[id];
      if (!e || e.state === 'graveyard') continue;
      // The state change is the finished edit: leaving afterwards doesn't send it again.
      if (baseline.has(id)) baseline.set(id, snap(e));
      runs.push(deps.critique(id, 'state_change'));
    }
    return Promise.all(runs).then(() => undefined);
  }

  return {
    finish,
    focusChanged,
    statesChanged,
    baselineOf: (id: EntityId) => baseline.get(id)?.updated,
  };
}

export type FinishTriggers = ReturnType<typeof createFinishTriggers>;
