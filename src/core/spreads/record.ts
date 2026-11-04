import { z } from 'zod';
import { AxisSchema, CandidateSchema, MoveSchema, SpotSchema, type Candidate } from '../ai/moments';
import { EntityIdSchema } from '../model/ids';
import type { SpreadRecord, World } from '../model/world';
import { spotSlug } from './spot';
import type { Spot } from '../ai/moments';

/**
 * A spread as stored in `spreads/<id>.json` (the world's `spreads` map). The
 * foundation's `SpreadRecordSchema` only fixes `id` and `created`; this is the
 * full shape W5 writes and reads. Unknown keys are kept.
 */

export const VERDICTS = ['keep', 'kill', 'merge'] as const;
export const VerdictSchema = z.enum(VERDICTS);
export type Verdict = z.infer<typeof VerdictSchema>;

/** What you did with one candidate. */
export const JudgementRecordSchema = z.object({
  verdict: VerdictSchema,
  /** Kill: the reason key ("1".."7", "0"). */
  reason: z.string().optional(),
  /** Kill: the reason's label when it was used (labels can be renamed later). */
  reasonLabel: z.string().optional(),
  /** Kill with "other": the few words you typed. */
  note: z.string().max(200).optional(),
  /** Keep / merge: the entity it became or changed. */
  entity: EntityIdSchema.optional(),
  at: z.string(),
});
export type JudgementRecord = z.infer<typeof JudgementRecordSchema>;

export const SPREAD_STATUSES = ['done', 'cancelled', 'failed'] as const;

export const SpreadDataSchema = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9._-]+$/),
  created: z.string(),
  updated: z.string(),
  spot: SpotSchema,
  move: MoveSchema,
  direction: z.string().max(300).optional(),
  axes: z.object({ x: AxisSchema, y: AxisSchema }),
  /** Candidates asked for. */
  count: z.number().int().min(1).max(16),
  /** Taste rules switched on for this spread. */
  ruleIds: z.array(z.string()).default([]),
  /** How the stream ended. */
  status: z.enum(SPREAD_STATUSES).default('done'),
  /** The spread and candidate this one was followed from (`→`). */
  parent: z.object({ spread: z.string(), key: z.string() }).optional(),
  candidates: z.array(CandidateSchema),
  judgements: z.record(z.string(), JudgementRecordSchema).default({}),
  /** Items the gateway dropped as invalid. */
  dropped: z.number().int().min(0).default(0),
  costUsd: z.number().min(0).default(0),
});
export type SpreadData = z.infer<typeof SpreadDataSchema>;

/** Reads a stored record as a full spread, or `null` if it isn't one (an older or foreign file). */
export function readSpread(record: SpreadRecord | undefined): SpreadData | null {
  if (!record) return null;
  const r = SpreadDataSchema.safeParse(record);
  return r.success ? r.data : null;
}

/** Every readable spread in the world, oldest first (by `created`, then id). */
export function allSpreads(world: World): SpreadData[] {
  return Object.values(world.spreads)
    .map(readSpread)
    .filter((s): s is SpreadData => s !== null)
    .sort((a, b) =>
      a.created < b.created ? -1 : a.created > b.created ? 1 : a.id < b.id ? -1 : 1,
    );
}

/**
 * A new spread's id: `<yyyymmdd-hhmmss>-<spot slug>`, unique in the world.
 * Deterministic for the same time, world and spot.
 */
export function newSpreadId(world: World, spot: Spot, nowIso: string): string {
  const stamp = nowIso
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');
  const base = `${stamp}-${spotSlug(spot)}`.slice(0, 90);
  if (!Object.prototype.hasOwnProperty.call(world.spreads, base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!Object.prototype.hasOwnProperty.call(world.spreads, id)) return id;
  }
}

/** Candidates not yet judged, in their order. */
export const openCandidates = (s: SpreadData): Candidate[] =>
  s.candidates.filter((c) => !s.judgements[c.key]);

export const candidateOf = (s: SpreadData, key: string): Candidate | undefined =>
  s.candidates.find((c) => c.key === key);

/** One judgement, flattened with its candidate, for taste and pattern learning. */
export interface JudgementEntry {
  spread: string;
  key: string;
  candidate: Candidate;
  judgement: JudgementRecord;
}

/** Every judgement in the world, oldest first (by time, then spread and key). */
export function allJudgements(world: World): JudgementEntry[] {
  const out: JudgementEntry[] = [];
  for (const s of allSpreads(world))
    for (const [key, judgement] of Object.entries(s.judgements)) {
      const candidate = candidateOf(s, key);
      if (candidate) out.push({ spread: s.id, key, candidate, judgement });
    }
  return out.sort(
    (a, b) => cmp(a.judgement.at, b.judgement.at) || cmp(a.spread, b.spread) || cmp(a.key, b.key),
  );
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** What a finished (or stopped) run gives a new spread record. */
export interface SpreadRun {
  id: string;
  now: string;
  request: {
    spot: Spot;
    move: SpreadData['move'];
    direction?: string | undefined;
    count: number;
    axes: SpreadData['axes'];
    ruleIds: string[];
  };
  candidates: Candidate[];
  status: SpreadData['status'];
  parent?: SpreadData['parent'] | undefined;
  dropped?: number;
  costUsd?: number;
}

/**
 * A new spread record from a run. Candidates are de-duplicated by key (the
 * first wins) so a misbehaving stream can't produce two cards with one key.
 */
export function makeSpread(run: SpreadRun): SpreadData {
  const seen = new Set<string>();
  const candidates = run.candidates.filter((c) =>
    seen.has(c.key) ? false : (seen.add(c.key), true),
  );
  const direction = run.request.direction?.trim();
  return SpreadDataSchema.parse({
    id: run.id,
    created: run.now,
    updated: run.now,
    spot: run.request.spot,
    move: run.request.move,
    ...(direction ? { direction } : {}),
    axes: run.request.axes,
    count: run.request.count,
    ruleIds: run.request.ruleIds,
    status: run.status,
    ...(run.parent ? { parent: run.parent } : {}),
    candidates,
    judgements: {},
    dropped: run.dropped ?? 0,
    costUsd: run.costUsd ?? 0,
  });
}
