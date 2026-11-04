import type { z } from 'zod';
import type { MomentRequest } from '../ai/moments';
import { PatternsResultSchema } from '../ai/moments';
import type { Taste, World } from '../model/world';
import { hashString } from '../util/hash';
import { allJudgements, type JudgementEntry } from '../spreads/record';

/**
 * Pattern learning (docs/EXPERIENCE.md §5–§6): after every 25 judgements, or
 * on demand, the `patterns` moment reads recent keeps and kills and proposes
 * patterns, which you promote to rules or dismiss.
 */

type Pattern = Taste['patterns'][number];

/** One pattern as the moment returns it. */
export const PatternInputSchema = PatternsResultSchema.shape.patterns.element;
export type PatternInput = z.infer<typeof PatternInputSchema>;

/** The moment runs after this many new judgements. */
export const PATTERN_EVERY = 25;
/** Judgements sent per run (the most recent). */
export const PATTERN_WINDOW = 80;

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** A pattern's id from its text: stable, and unique against `taken`. */
export function patternId(text: string, taken: ReadonlySet<string>): string {
  const base = `pat-${hashString(norm(text)).slice(0, 10)}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Merges a run's patterns into the list. Deterministic:
 *  - `updates: <id>` of an existing pattern replaces its text, examples and
 *    strength, keeping its status (a dismissed pattern stays dismissed).
 *  - a pattern with the same text as an existing one is the same pattern.
 *  - anything else is added as `proposed`.
 * Existing order is kept; new patterns go at the end in the run's order.
 */
export function mergePatterns(
  current: readonly Pattern[],
  incoming: readonly PatternInput[],
  at: string,
): Pattern[] {
  const out = current.map((p) => ({ ...p }));
  const ids = new Set(out.map((p) => p.id));
  for (const inc of incoming) {
    const text = inc.text.trim();
    if (text === '') continue;
    const target =
      (inc.updates !== undefined ? out.find((p) => p.id === inc.updates) : undefined) ??
      out.find((p) => norm(p.text) === norm(text));
    const examples = [...new Set(inc.examples)].slice(0, 6);
    if (target) {
      target.text = text;
      target.examples = examples;
      target.strength = inc.strength;
      target.updated = at;
      continue;
    }
    const id = patternId(text, ids);
    ids.add(id);
    out.push({ id, text, status: 'proposed', examples, strength: inc.strength, updated: at });
  }
  return out;
}

/** How many judgements the world holds (keeps, kills and merges across all spreads). */
export const judgementCount = (world: World): number => allJudgements(world).length;

/** The judgement count at the last patterns run (0 if never). */
export function lastPatternsRun(world: World): number {
  const p = (world.settings as { patterns?: { judged?: unknown } }).patterns;
  const n = p && typeof p.judged === 'number' ? p.judged : 0;
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** New judgements since the last run. (A removed spread can make the total drop: clamp at 0.) */
export const judgedSinceRun = (world: World): number =>
  Math.max(0, judgementCount(world) - lastPatternsRun(world));

/** Whether the automatic run is due: `PATTERN_EVERY` new judgements since the last run. */
export const patternsDue = (world: World, every = PATTERN_EVERY): boolean =>
  judgedSinceRun(world) >= every;

const toJudgement = (j: JudgementEntry): MomentRequest<'patterns'>['judgements'][number] => {
  const verdict = j.judgement.verdict === 'kill' ? 'kill' : 'keep';
  const reason =
    j.judgement.verdict === 'kill'
      ? [j.judgement.reasonLabel ?? j.judgement.reason, j.judgement.note].filter(Boolean).join(': ')
      : undefined;
  return {
    candidate: { name: j.candidate.name, identity: j.candidate.identity, kind: j.candidate.kind },
    verdict,
    ...(reason ? { reason } : {}),
  };
};

/** The request for a patterns run: the most recent judgements, oldest first. `null` with none. */
export function patternsRequest(
  world: World,
  limit = PATTERN_WINDOW,
): MomentRequest<'patterns'> | null {
  const all = allJudgements(world);
  if (all.length === 0) return null;
  return { judgements: all.slice(-limit).map(toJudgement) };
}
