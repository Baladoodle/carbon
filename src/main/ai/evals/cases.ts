import type { Moment, MomentRequest } from '@core/ai/moments';
import { CLEAN, SEEDED } from './worlds';

/**
 * The eval cases, per moment. Critique cases carry what they expect: a seeded
 * flaw must be caught (recall) and a clean entity must get no notes
 * (precision). The others feed schema validity, references, duplicate names,
 * spread diversity and the token limit.
 */
export interface EvalCase<M extends Moment = Moment> {
  id: string;
  moment: M;
  request: MomentRequest<M>;
  /** Critique: the note kinds that catch the seeded flaw. */
  expect?: { catches: string[] } | { clean: true };
}

const c = <M extends Moment>(
  id: string,
  moment: M,
  request: MomentRequest<M>,
  extra: Partial<EvalCase<M>> = {},
): EvalCase => ({ id, moment, request, ...extra });

export const CASES: EvalCase[] = [
  ...SEEDED.map((s) =>
    c(
      `critique-flaw-${s.entity.id}`,
      'critique',
      { entityId: s.entity.id, trigger: 'on_demand' },
      { expect: { catches: s.catches } },
    ),
  ),
  ...CLEAN.map((e) =>
    c(
      `critique-clean-${e.id}`,
      'critique',
      { entityId: e.id, trigger: 'finish_edit' },
      { expect: { clean: true } },
    ),
  ),
  c('suggest-name-updraft-kite', 'suggest_one', { entityId: 'updraft-kite', field: 'name' }),
  c('suggest-tradeoff-spore-lantern', 'suggest_one', {
    entityId: 'spore-lantern',
    field: 'tradeoff',
  }),
  c('suggest-identity-frost-wisp', 'suggest_one', { entityId: 'frost-wisp', field: 'identity' }),
  c('suggest-subkind-brass-band', 'suggest_one', { entityId: 'brass-band', field: 'subkind' }),
  c('suggest3-name-lantern-moth', 'suggest_three', { entityId: 'lantern-moth', field: 'name' }),
  c('suggest3-change-brass-band', 'suggest_three', { entityId: 'brass-band', field: 'change' }),
  c('fill-high-drift', 'fill_entity', { entityId: 'high-drift' }),
  c('fill-frost-wisp', 'fill_entity', { entityId: 'frost-wisp' }),
  c('spread-fill-low-sky-items', 'spread', {
    spot: { type: 'cell', band: 'low-sky', lane: 'items' },
    move: 'fill',
    count: 8,
  }),
  c('spread-vary-lantern-moth', 'spread', {
    spot: { type: 'entity', entity: 'lantern-moth' },
    move: 'vary',
    count: 8,
  }),
  c('spec-cinder-sting-glide', 'spec_draft', {
    entityIds: ['cinder-sting', 'glide'],
    name: 'First weapon and glide',
  }),
  c('patterns-kills', 'patterns', {
    judgements: [
      {
        candidate: { name: 'Iron Ring', identity: '+5 defense', kind: 'item' },
        verdict: 'kill',
        reason: 'just a number',
      },
      {
        candidate: { name: 'Steel Ring', identity: '+10 defense', kind: 'item' },
        verdict: 'kill',
        reason: 'just a number',
      },
      {
        candidate: { name: 'Echo Bell', identity: 'Ring it to hear hidden rooms.', kind: 'item' },
        verdict: 'keep',
      },
      {
        candidate: { name: 'Fire Sword', identity: 'A sword, but on fire.', kind: 'item' },
        verdict: 'kill',
        reason: 'seen it',
      },
      {
        candidate: {
          name: 'Gust Lantern',
          identity: 'Its flame leans toward updrafts.',
          kind: 'item',
        },
        verdict: 'keep',
      },
    ],
  }),
];
