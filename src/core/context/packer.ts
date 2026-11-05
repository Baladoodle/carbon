import type { Entity } from '../model/entity';
import type { EntityId } from '../model/ids';
import { getEntity, type World } from '../model/world';
import { defaultPlacement, type PlacementResolver } from './placement';
import { rankEntities, type Focus, type Tier } from './relevance';
import {
  renderDigest,
  renderFull,
  renderSummary,
  renderTaste,
  type DigestLevel,
  type TasteOptions,
} from './render';
import { BLOCK_OVERHEAD, clipToTokens, estimateTokens } from './tokens';

/**
 * The context packer (docs/SYSTEM.md §8 step 3). It renders the world digest,
 * the taste and the focus, ranks every other entity by relevance and fills a
 * token budget with them, choosing a full or a summary rendering for each.
 *
 * Guarantees (property-tested in packer.test.ts):
 *  - `tokens.total <= budget` (and the budget never exceeds HARD_LIMIT)
 *  - the same world, focus and options always give byte-identical output
 *  - entities appear in relevance order; an entity is never rendered twice
 */

/** Default token budget for the packed context (SYSTEM §8). */
export const DEFAULT_BUDGET = 60_000;
/** Hard limit for the packed context. Requests must stay under 100k in total. */
export const HARD_LIMIT = 95_000;

export interface PackOptions {
  /** Token budget for everything the packer returns. Clamped to [0, HARD_LIMIT]. */
  budget?: number;
  /** Tokens reserved for the caller's own text (instructions, the ask), subtracted from the budget. */
  reserved?: number;
  taste?: TasteOptions;
  /** Tiers rendered in full when they fit (default: direct relations and the same cell). */
  fullTiers?: readonly Tier[];
  placement?: PlacementResolver;
}

export interface PackedEntity {
  id: EntityId;
  tier: Tier;
  rendering: 'full' | 'summary';
}

export interface PackedContext {
  /** World digest: bands, biomes, counts and names (slow-changing; cached). */
  digest: string;
  /** Taste: rules, patterns, kill reasons (slow-changing; cached). */
  taste: string;
  /** The entities in focus, in full (per request). */
  focus: string;
  /** Related and nearby entities, most relevant first (per request). */
  neighbours: string;
  included: PackedEntity[];
  /** Entities that didn't fit. */
  omitted: number;
  digestLevel: DigestLevel;
  tokens: {
    digest: number;
    taste: number;
    focus: number;
    neighbours: number;
    total: number;
    budget: number;
  };
}

// Shares of the budget each fixed part may take before it is shrunk.
const SHARE = { digest: 0.3, taste: 0.12, focus: 0.3 } as const;

export function packContext(world: World, focus: Focus, opts: PackOptions = {}): PackedContext {
  const place = opts.placement ?? defaultPlacement;
  const budget = Math.max(
    0,
    Math.min(HARD_LIMIT, Math.floor(opts.budget ?? DEFAULT_BUDGET)) -
      Math.max(0, Math.ceil(opts.reserved ?? 0)),
  );
  const fullTiers = new Set<Tier>(opts.fullTiers ?? [0, 1]);

  // 1. Digest: the most detailed level that fits its share.
  let digestLevel: DigestLevel = 0;
  let digest = renderDigest(world, 0);
  for (const level of [1, 2, 3] as const) {
    if (estimateTokens(digest) <= budget * SHARE.digest) break;
    digestLevel = level;
    digest = renderDigest(world, level);
  }
  digest = clipToTokens(digest, Math.floor(budget * SHARE.digest));

  // 2. Taste, clipped to its share.
  const taste = clipToTokens(renderTaste(world, opts.taste), Math.floor(budget * SHARE.taste));

  // 3. Focus entities in full, sharing the focus allowance.
  const focused = focus.entities.map((id) => getEntity(world, id)).filter((e): e is Entity => !!e);
  const per = focused.length > 0 ? Math.floor((budget * SHARE.focus) / focused.length) : 0;
  const focusText = focused
    .map((e) => clipToTokens(renderFull(world, e, place), per))
    .filter(Boolean)
    .join('\n\n');

  // 4. Neighbours, most relevant first, into what's left.
  const fixed = estimateTokens(digest) + estimateTokens(taste) + estimateTokens(focusText);
  let room = budget - fixed - 8; // the neighbours block's own framing
  const included: PackedEntity[] = [];
  const parts: string[] = [];
  let omitted = 0;
  for (const { entity, tier } of rankEntities(world, focus, place)) {
    if (room <= 0) {
      omitted++;
      continue;
    }
    const full = fullTiers.has(tier) ? renderFull(world, entity, place) : null;
    // Each part costs its own estimate plus a separating newline (estimates
    // are sub-additive, so the joined text never costs more than the parts).
    const cost = (s: string): number => estimateTokens(`${s}\n`) - BLOCK_OVERHEAD;
    if (full !== null && cost(full) <= room) {
      parts.push(full);
      room -= cost(full);
      included.push({ id: entity.id, tier, rendering: 'full' });
      continue;
    }
    const summary = renderSummary(entity);
    if (cost(summary) <= room) {
      parts.push(summary);
      room -= cost(summary);
      included.push({ id: entity.id, tier, rendering: 'summary' });
    } else omitted++;
  }
  let neighbours = parts.join('\n');
  // Belt and braces: the estimate of the joined text must fit too.
  while (parts.length > 0 && fixed + estimateTokens(neighbours) > budget) {
    parts.pop();
    included.pop();
    omitted++;
    neighbours = parts.join('\n');
  }
  const tokens = {
    digest: estimateTokens(digest),
    taste: estimateTokens(taste),
    focus: estimateTokens(focusText),
    neighbours: estimateTokens(neighbours),
    total: 0,
    budget,
  };
  tokens.total = tokens.digest + tokens.taste + tokens.focus + tokens.neighbours;
  return { digest, taste, focus: focusText, neighbours, included, omitted, digestLevel, tokens };
}
