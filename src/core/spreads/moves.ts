import type { Axis, Move, Spot } from '../ai/moments';
import { MOVES } from '../ai/moments';

/**
 * The nine moves of a spread (docs/EXPERIENCE.md §4) as data: the key that
 * picks it, what it asks for, which spots it can aim at, the field's default
 * axes, and what its candidates become when you keep them.
 *
 * - `new`: a new entity at the spot (Fill, Vary, Oppose, Alloy, Push).
 * - `about`: a change to an existing entity (`candidate.about`): Ground, Cost, Name.
 * - `finding`: not an entity at all (`candidate.kind === null`): Break.
 */
export type MoveOutput = 'new' | 'about' | 'finding';
export type SpotType = Spot['type'];

export interface MoveDef {
  move: Move;
  /** The key that picks it in the spread bar (and after `→`). */
  key: string;
  label: string;
  /** What it asks for, in a line (tooltips and the palette). */
  asks: string;
  /** What the model is told to do (the move instructions in the prompt). */
  instructions: string;
  /** Spot types it can aim at. */
  spots: readonly SpotType[];
  /** Entities the spot must name (Alloy needs two). */
  minEntities: number;
  output: MoveOutput;
  /** The field's default axes. */
  axes: { x: Axis; y: Axis };
}

const ax = (label: string, low: string, high: string): Axis => ({ label, low, high });

export const MOVE_DEFS: Record<Move, MoveDef> = {
  fill: {
    move: 'fill',
    key: 'f',
    label: 'Fill',
    asks: 'Candidates for an empty spot, built to fit their neighbours',
    instructions:
      'Propose new entities for this spot. Each must fit its neighbours (the band, the biomes and the entities around it) and fill a gap they leave, not repeat what is already there.',
    spots: ['cell', 'region', 'note', 'selection'],
    minEntities: 0,
    output: 'new',
    axes: { x: ax('strangeness', 'familiar', 'strange'), y: ax('impact', 'quiet', 'loud') },
  },
  vary: {
    move: 'vary',
    key: 'v',
    label: 'Vary',
    asks: 'Siblings of an entity: same role, different identity',
    instructions:
      'Propose siblings of the focus entity: each plays the same role in the world (same kind, same slot in the progression, similar weight) but has a different identity. Never a renamed copy.',
    spots: ['entity', 'selection'],
    minEntities: 1,
    output: 'new',
    axes: {
      x: ax('distance', 'close sibling', 'distant cousin'),
      y: ax('strangeness', 'familiar', 'strange'),
    },
  },
  oppose: {
    move: 'oppose',
    key: 'o',
    label: 'Oppose',
    asks: 'The strongest inversion of an entity or a rule',
    instructions:
      'Propose the strongest inversions of the focus: what it would be if its core idea were turned inside out. Invert the idea, not just its numbers or its adjectives.',
    spots: ['entity', 'selection', 'note'],
    minEntities: 0,
    output: 'new',
    axes: { x: ax('inversion', 'partial', 'total'), y: ax('tone', 'playful', 'grim') },
  },
  alloy: {
    move: 'alloy',
    key: 'a',
    label: 'Alloy',
    asks: 'Two entities combined into something neither is',
    instructions:
      'Combine the focus entities into new entities that neither of them is. Each candidate takes something essential from each source and becomes a third thing; say what it takes from which.',
    spots: ['selection'],
    minEntities: 2,
    output: 'new',
    axes: {
      x: ax('balance', 'more the first', 'more the second'),
      y: ax('novelty', 'blend', 'new'),
    },
  },
  push: {
    move: 'push',
    key: 'p',
    label: 'Push',
    asks: 'The same thing at 10× strength, weirdness or cost',
    instructions:
      'Propose the focus pushed to an extreme: ten times the strength, the weirdness or the cost. Keep what makes it itself and follow the consequences honestly, including what it breaks.',
    spots: ['entity', 'selection'],
    minEntities: 1,
    output: 'new',
    axes: { x: ax('strength', '1×', '10×'), y: ax('weirdness', 'sane', 'weird') },
  },
  ground: {
    move: 'ground',
    key: 'g',
    label: 'Ground',
    asks: 'Ties an entity to bands, biomes, materials and creatures, with reasons',
    instructions:
      'Propose ways to tie the focus entity into the world: relations to existing bands, biomes, materials and creatures, each with a one-line reason (the relation note). Each candidate is one coherent grounding, set as `about` the entity it changes, and uses only existing entity ids.',
    spots: ['entity', 'selection'],
    minEntities: 1,
    output: 'about',
    axes: { x: ax('height', 'deeper', 'higher'), y: ax('tie', 'loose', 'tight') },
  },
  cost: {
    move: 'cost',
    key: 'c',
    label: 'Cost',
    asks: '2 or 3 acquisition routes with their total effort',
    instructions:
      'Propose acquisition routes for the focus entity: each candidate is a route of 2 or 3 steps (the `route` field, steps that name the entities they need) and states its total effort in the rationale. Set `about` to the entity it changes.',
    spots: ['entity', 'selection'],
    minEntities: 1,
    output: 'about',
    axes: { x: ax('effort', 'cheap', 'costly'), y: ax('detour', 'on the way', 'out of the way') },
  },
  break: {
    move: 'break',
    key: 'r',
    label: 'Break',
    asks: 'Exploits, degenerate combinations, trivialised bands',
    instructions:
      'Find the ways the focus breaks the game: exploits, degenerate combinations with existing entities, bands it trivialises, loops that skip progression. Each candidate is a finding (kind null): name it, say in the identity what breaks, and list the entities involved as relations of type `pairs_with`.',
    spots: ['cell', 'region', 'selection', 'entity', 'note'],
    minEntities: 0,
    output: 'finding',
    axes: {
      x: ax('severity', 'minor', 'game-breaking'),
      y: ax('likelihood', 'rare', 'inevitable'),
    },
  },
  name: {
    move: 'name',
    key: 'n',
    label: 'Name',
    asks: "A naming pass in the world's own voice",
    instructions:
      "Propose names for the focus entities in the world's own voice: learn it from the existing names, never generic fantasy. Each candidate keeps the entity's identity, changes only its name, and is set as `about` the entity it renames.",
    spots: ['entity', 'selection'],
    minEntities: 1,
    output: 'about',
    axes: { x: ax('register', 'plain', 'ornate'), y: ax('tone', 'warm', 'ominous') },
  },
};

/** The moves in the order of EXPERIENCE.md §4. */
export const MOVE_LIST: readonly MoveDef[] = MOVES.map((m) => MOVE_DEFS[m]);

/** The move picked by a key, if any. */
export const moveByKey = (key: string): MoveDef | undefined => MOVE_LIST.find((m) => m.key === key);

/**
 * The axes you can choose for a field: every move's defaults plus a few
 * general ones, unique by label, in a fixed order.
 */
export const AXIS_LIBRARY: readonly Axis[] = (() => {
  const extra = [
    ax('menace', 'gentle', 'menacing'),
    ax('rarity', 'common', 'rare'),
    ax('scale', 'small', 'vast'),
    ax('cost', 'cheap', 'costly'),
    ax('power', 'modest', 'strong'),
    ax('complexity', 'simple', 'intricate'),
  ];
  const seen = new Set<string>();
  const out: Axis[] = [];
  for (const a of [...MOVE_LIST.flatMap((m) => [m.axes.x, m.axes.y]), ...extra]) {
    if (seen.has(a.label)) continue;
    seen.add(a.label);
    out.push(a);
  }
  return out;
})();
