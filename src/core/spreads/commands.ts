import { z } from 'zod';
import { defineCommand } from '../commands/define';
import type { Patch } from '../commands/patch';
import { EntityIdSchema } from '../model/ids';
import { err, ok } from '../util/result';
import { candidateOf, readSpread, SpreadDataSchema, VerdictSchema } from './record';

/**
 * Spread commands, finer than the foundation's `spread.put`. Triage composes
 * these with entity and taste commands in one transaction (see triage.ts), so
 * each key press is one undo step.
 */

/** Saves a whole spread record, validated against the full shape (`spread.put` only checks id and created). */
export const saveSpread = defineCommand({
  payload: z.object({ record: SpreadDataSchema }),
  label: () => 'Spread',
  plan: (_world, p) => ok([{ op: 'set', path: ['spreads', p.record.id], value: p.record }]),
});

/** Records what you did with one candidate. A candidate is judged once; undo takes it back. */
export const judgeCandidate = defineCommand({
  payload: z
    .object({
      spread: z.string(),
      key: z.string(),
      verdict: VerdictSchema,
      reason: z.string().optional(),
      reasonLabel: z.string().optional(),
      note: z.string().max(200).optional(),
      entity: EntityIdSchema.optional(),
    })
    .refine((p) => p.verdict !== 'kill' || p.reason !== undefined, {
      message: 'a kill needs a reason',
      path: ['reason'],
    }),
  label: (p, w) => {
    const name = candidateOf(readSpread(w.spreads[p.spread]) ?? emptySpread, p.key)?.name ?? p.key;
    return p.verdict === 'keep'
      ? `Keep ${name}`
      : p.verdict === 'kill'
        ? `Kill ${name}`
        : `Merge ${name}`;
  },
  plan(world, p, ctx) {
    const raw = world.spreads[p.spread];
    const s = readSpread(raw);
    if (!raw || !s) return err('spread.not_found', `no spread "${p.spread}"`);
    if (!candidateOf(s, p.key)) return err('spread.no_candidate', `no candidate "${p.key}"`);
    if (s.judgements[p.key]) return err('spread.judged', `"${p.key}" is already judged`);
    const judgement = {
      verdict: p.verdict,
      ...(p.reason !== undefined ? { reason: p.reason } : {}),
      ...(p.reasonLabel !== undefined ? { reasonLabel: p.reasonLabel } : {}),
      ...(p.note !== undefined && p.note !== '' ? { note: p.note } : {}),
      ...(p.entity !== undefined ? { entity: p.entity } : {}),
      at: ctx.now,
    };
    const patch: Patch =
      'judgements' in raw
        ? [{ op: 'set', path: ['spreads', p.spread, 'judgements', p.key], value: judgement }]
        : [{ op: 'set', path: ['spreads', p.spread, 'judgements'], value: { [p.key]: judgement } }];
    patch.push({ op: 'set', path: ['spreads', p.spread, 'updated'], value: ctx.now });
    return ok(patch);
  },
});

const emptySpread = SpreadDataSchema.parse({
  id: 'none',
  created: '',
  updated: '',
  spot: { type: 'entity', entity: 'none' },
  move: 'vary',
  axes: { x: { label: '', low: '', high: '' }, y: { label: '', low: '', high: '' } },
  count: 1,
  candidates: [],
});

export const spreadCommands = {
  'spread.save': saveSpread,
  'spread.judge': judgeCandidate,
} as const;
