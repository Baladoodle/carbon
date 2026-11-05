import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { AiGateway } from '@core/ai/gateway';
import type { CritiqueNote, MomentResult } from '@core/ai/moments';
import { applyCommands } from '@core/commands/apply';
import { cmd } from '@core/commands/registry';
import { EntitySchema } from '@core/model/entity';
import type { World } from '@core/model/world';

import { critiqueBuilder } from '@core/prompts/critique';
import { fillBuilder, parseFill } from '@core/prompts/fill';
import { SAMPLE_TIME } from '@core/testing/sample';
import type { Metric } from './metrics';
import { evalWorld } from './worlds';

/**
 * The self-consistency eval (docs/SYSTEM.md §8a): fill an entity, accept
 * every proposal, then critique it. The critic and the writer share one
 * quality bar, so the critic should have (almost) nothing to say about what
 * the writer just wrote: the share of notes on just-filled fields must stay
 * at or below 10%.
 *
 * Live (`npm run eval`), both calls go through the real gateway. Offline
 * (`--replay`, `--dry`), the answers come from `evals/fixtures/consistency/`:
 * a fill answer per case and the critic's answer for each set of fields the
 * fill left AI-written, keyed by those fields. The prompts are still built by
 * the real builders and the answers parsed by them, so the parse-time
 * self-check (src/core/prompts/quality.ts) is part of what's measured.
 */

export interface ConsistencyCase {
  id: string;
  entityId: string;
}

/**
 * A blank item whose fill reproduces the reported conflict in the fixtures:
 * the writer proposes a pure-number identity, the critic flags it.
 */
export const THERMAL_CHARM = EntitySchema.parse({
  id: 'thermal-charm',
  kind: 'item',
  name: 'Thermal Charm',
  state: 'idea',
  fields: { subkind: 'accessory' },
  relations: [{ type: 'in_band', target: 'low-sky' }],
  created: SAMPLE_TIME,
  updated: SAMPLE_TIME,
});

/** The eval world plus the blank item. */
export function consistencyWorld(): World {
  const w = evalWorld();
  w.entities[THERMAL_CHARM.id] = THERMAL_CHARM;
  return w;
}

export const CONSISTENCY_CASES: ConsistencyCase[] = [
  { id: 'consistency-thermal-charm', entityId: 'thermal-charm' },
  { id: 'consistency-high-drift', entityId: 'high-drift' },
  { id: 'consistency-frost-wisp', entityId: 'frost-wisp' },
];

export type Answer<M extends 'fill_entity' | 'critique'> =
  | { ok: true; result: MomentResult<M>; dropped: number; costUsd: number }
  | { ok: false; error: string; costUsd: number };

/** Answers one moment against a world (the gateway live, the fixtures offline). */
export interface Answerer {
  fill(world: World, entityId: string): Promise<Answer<'fill_entity'>>;
  critique(world: World, entityId: string): Promise<Answer<'critique'>>;
}

export interface ConsistencyRun {
  case: ConsistencyCase;
  ok: boolean;
  error?: string;
  /** Fields the fill wrote (every proposal accepted, as the Bench's Accept all does). */
  filled: string[];
  /** Fill proposals the parse dropped (invalid, or failing the self-check). */
  dropped: number;
  notes: Pick<CritiqueNote, 'kind' | 'field'>[];
  costUsd: number;
}

/** The field a note is about: its own, or identity for a weak identity. */
export const noteField = (n: Pick<CritiqueNote, 'kind' | 'field'>): string | undefined =>
  n.field ?? (n.kind === 'weak_identity' ? 'identity' : undefined);

/** Fill, accept every proposal, critique: per case. */
export async function runConsistency(
  world: World,
  cases: readonly ConsistencyCase[],
  answer: Answerer,
  log?: (line: string) => void,
): Promise<ConsistencyRun[]> {
  const runs: ConsistencyRun[] = [];
  for (const c of cases) {
    const base: ConsistencyRun = {
      case: c,
      ok: false,
      filled: [],
      dropped: 0,
      notes: [],
      costUsd: 0,
    };
    const fill = await answer.fill(world, c.entityId);
    base.costUsd += fill.costUsd;
    if (!fill.ok) {
      runs.push({ ...base, error: `fill: ${fill.error}` });
      log?.(`error ${c.id} (fill: ${fill.error})`);
      continue;
    }
    base.dropped = fill.dropped;
    // Accept all, as the Bench does: every proposal but the name, as AI values.
    const accepted = fill.result.proposals.filter((p) => p.field !== 'name');
    const applied = applyCommands(
      world,
      accepted.map((p) =>
        cmd('entity.setField', { id: c.entityId, field: p.field, value: p.value, source: 'ai' }),
      ),
      { now: '2026-11-05T00:00:00.000Z' },
    );
    if (!applied.ok) {
      runs.push({ ...base, error: `accept: ${applied.error.message}` });
      continue;
    }
    const after = applied.value.world;
    const filled = accepted.map((p) => p.field);
    const critique = await answer.critique(after, c.entityId);
    base.costUsd += critique.costUsd;
    if (!critique.ok) {
      runs.push({ ...base, filled, error: `critique: ${critique.error}` });
      log?.(`error ${c.id} (critique: ${critique.error})`);
      continue;
    }
    const notes = critique.result.notes.map((n) => ({
      kind: n.kind,
      ...(n.field ? { field: n.field } : {}),
    }));
    runs.push({ ...base, ok: true, filled, notes });
    const onFilled = notes.filter((n) => filled.includes(noteField(n) ?? ''));
    log?.(
      `ok    ${c.id}: filled ${filled.length} (${fill.dropped} dropped), ${notes.length} notes, ${onFilled.length} on filled fields`,
    );
  }
  return runs;
}

export const SELF_CONSISTENCY_MAX = 0.1;

/** The share of critique notes that land on fields the fill just wrote (≤ 10%). */
export function consistencyMetric(runs: readonly ConsistencyRun[]): Metric {
  const done = runs.filter((r) => r.ok);
  const failed = runs.filter((r) => !r.ok);
  const notes = done.flatMap((r) => r.notes.map((n) => ({ r, n })));
  const onFilled = notes.filter(({ r, n }) => r.filled.includes(noteField(n) ?? ''));
  const value = done.length === 0 ? null : notes.length === 0 ? 0 : onFilled.length / notes.length;
  const detail = [
    `${onFilled.length} of ${notes.length} notes on just-filled fields, over ${done.length} fills`,
    ...onFilled.map(({ r, n }) => `${r.case.id}: ${n.kind} on ${noteField(n)}`),
    ...failed.map((r) => `${r.case.id} did not run (${r.error ?? 'failed'})`),
  ].join('; ');
  return {
    id: 'self-consistency',
    label: 'Self-consistency: critique notes on just-filled fields',
    value,
    target: '≤ 10%',
    pass: value === null ? null : value <= SELF_CONSISTENCY_MAX && failed.length === 0,
    detail,
  };
}

// ── Offline: fixtures ───────────────────────────────────────────────────────

/** `evals/fixtures/consistency/<entity>.json`. */
export interface ConsistencyFixture {
  entityId: string;
  /** What the fill answered (the model's raw JSON). */
  fill: unknown;
  /**
   * What the critic answered (raw JSON), keyed by the entity's AI-written
   * fields when it was asked, sorted and joined with ",". The critic sees a
   * different entity when the parse drops a proposal, so each state has its
   * own answer.
   */
  critique: Record<string, unknown>;
}

export function loadConsistencyFixtures(dir: string): Map<string, ConsistencyFixture> {
  const out = new Map<string, ConsistencyFixture>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    const x = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as ConsistencyFixture;
    out.set(x.entityId, x);
  }
  return out;
}

/** The fixture key of an entity's state: its AI-written fields. */
export const critiqueKey = (world: World, entityId: string): string =>
  [...(world.entities[entityId]?.ai_fields ?? [])].sort().join(',');

/**
 * Answers from fixtures through the real builders: each prompt is built (so a
 * builder that refuses fails the case) and each answer parsed and validated
 * by the moment's own parse. `selfCheck: false` parses fills as before the
 * quality bar's self-check, to reproduce the conflict.
 */
export function fixtureAnswerer(
  fixtures: Map<string, ConsistencyFixture>,
  opts: { selfCheck?: boolean } = {},
): Answerer {
  return {
    fill(world, entityId) {
      const fx = fixtures.get(entityId);
      if (!fx) return Promise.resolve({ ok: false, error: 'no fixture', costUsd: 0 });
      const built = fillBuilder.build(world, { entityId });
      if (!built.ok) return Promise.resolve({ ok: false, error: built.error.message, costUsd: 0 });
      const p = parseFill(fx.fill, world, { entityId }, opts);
      return Promise.resolve(
        p.ok
          ? { ok: true, result: p.value.result, dropped: p.value.dropped, costUsd: 0 }
          : { ok: false, error: p.error.message, costUsd: 0 },
      );
    },
    critique(world, entityId) {
      const fx = fixtures.get(entityId);
      const key = critiqueKey(world, entityId);
      const raw = fx?.critique[key];
      if (raw === undefined)
        return Promise.resolve({
          ok: false,
          error: `no critique fixture for AI fields "${key}"`,
          costUsd: 0,
        });
      const b = critiqueBuilder;
      const req = { entityId, trigger: 'on_demand' as const };
      const built = b.build(world, req);
      if (!built.ok) return Promise.resolve({ ok: false, error: built.error.message, costUsd: 0 });
      const p = b.parse(raw, world, req);
      return Promise.resolve(
        p.ok
          ? { ok: true, result: p.value.result, dropped: p.value.dropped, costUsd: 0 }
          : { ok: false, error: p.error.message, costUsd: 0 },
      );
    },
  };
}

// ── Live: the real gateway ──────────────────────────────────────────────────

/**
 * Answers through a gateway whose `getWorld` reads `ref.world`: each call
 * sets it to the world it's asked about (the fill's, then the accepted one).
 */
export function gatewayAnswerer(gateway: AiGateway, ref: { world: World }): Answerer {
  return {
    async fill(world, entityId) {
      ref.world = world;
      const out = await gateway.run('fill_entity', { entityId });
      const costUsd = out.meta?.costUsd ?? 0;
      return out.ok
        ? { ok: true, result: out.result, dropped: out.meta.dropped, costUsd }
        : { ok: false, error: `${out.error.code}: ${out.error.message}`, costUsd };
    },
    async critique(world, entityId) {
      ref.world = world;
      const out = await gateway.run('critique', { entityId, trigger: 'on_demand' });
      const costUsd = out.meta?.costUsd ?? 0;
      return out.ok
        ? { ok: true, result: out.result, dropped: out.meta.dropped, costUsd }
        : { ok: false, error: `${out.error.code}: ${out.error.message}`, costUsd };
    },
  };
}
