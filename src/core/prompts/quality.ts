import { CRITIQUE_KINDS } from '../ai/moments';
import type { Entity } from '../model/entity';
import type { World } from '../model/world';
import { normName } from './schema';

/**
 * The one quality bar (docs/SYSTEM.md §8a, docs/IMAGES.md §7). The critic
 * judges by these criteria and every generating prompt (suggest one and three,
 * fill, every spread move) is told to meet them, so the writer and the critic
 * can't disagree about what "good" means. Both views are rendered from this
 * table; `quality.test.ts` fails if a criterion reaches one and not the other.
 *
 * Typed by the critique kinds, so a new kind in `CRITIQUE_KINDS` doesn't
 * compile until it has both a rubric line and a constraint line here.
 */
export type QualityKind = (typeof CRITIQUE_KINDS)[number];

export interface Criterion {
  kind: QualityKind;
  /** The critic's view: what counts as this problem. */
  rubric: string;
  /** The writer's view: what everything it writes must satisfy. */
  must: string;
}

const TABLE: Record<QualityKind, Omit<Criterion, 'kind'>> = {
  just_a_number: {
    rubric:
      'its effect is only a stat change (+N, ×N, a percentage, a faster/stronger version) with no new behaviour, choice, verb or feeling. Numbers attached to a distinct identity are fine.',
    must: 'Never only a stat change (+N, ×N, a percentage, a faster or stronger version). Give it a new behaviour, choice, verb or feeling; numbers may only accompany a distinct identity.',
  },
  rule_clash: {
    rubric:
      'it breaks one of the designer\'s rules. Set ruleId to that rule\'s id in brackets, e.g. "r1".',
    must: "Obey every one of the designer's rules in the taste block.",
  },
  duplicate: {
    rubric:
      "it is the same thing as another existing entity: the same or nearly the same name, or the same role and identity under a different name. Put the other entity's id in entities.",
    must: 'Never the same thing as an existing entity: not the same or nearly the same name, and not the same role and identity under another name.',
  },
  contradicts_relation: {
    rubric:
      "one of its relations, or one pointing at it, is wrong or impossible: a target id that doesn't exist in the world, a target of the wrong kind, or a relation that contradicts the entity's own fields or place (a lava creature living in a frozen biome). Put the relation's target id in entities only if that entity exists.",
    must: "Agree with the entity's relations, fields and place: refer only to existing ids of the right kind, and never contradict where it lives or what it is made of.",
  },
  weak_identity: {
    rubric: "its one-line identity is missing, generic, or doesn't say what makes it distinct.",
    must: 'An identity is one concrete line that says what makes it distinct. Never generic, never a line that could describe another entity.',
  },
};

/** The criteria, in the critic's order (`CRITIQUE_KINDS`). */
export const QUALITY: readonly Criterion[] = CRITIQUE_KINDS.map((kind) => ({
  kind,
  ...TABLE[kind],
}));

/** The critic's view: one line per criterion (inside the critique instructions). */
export function critiqueRubric(): string {
  return QUALITY.map((c) => `- ${c.kind}: ${c.rubric}`).join('\n');
}

/**
 * The writer's view: the constraint block every generating prompt carries.
 * `subject` names what it applies to ("Every value you propose"); `exception`
 * is an extra line (a spread's wildcard ignores the rules).
 */
export function qualityConstraints(subject = 'Everything you write', exception?: string): string {
  return [
    '# Quality bar (must satisfy)',
    '',
    `The designer's critic reviews what you write against exactly these criteria. ${subject} must satisfy all of them, so the critic has nothing to raise:`,
    ...QUALITY.map((c) => `- ${c.kind}: ${c.must}`),
    ...(exception ? [exception] : []),
  ].join('\n');
}

// ── The deterministic self-check ────────────────────────────────────────────
// What a proposal would fail at once, checked without the model: the parts of
// the bar a program can decide. A proposal that fails is dropped at parse
// time (and counted in `dropped`), never shown. Conservative on purpose: a
// false drop costs a suggestion, a false keep costs only a critique note.

/** Words that, with numbers, make an identity "just a number" (+10% damage). */
const STAT_WORDS = new Set([
  'damage',
  'dmg',
  'defense',
  'defence',
  'armor',
  'armour',
  'attack',
  'power',
  'strength',
  'speed',
  'health',
  'hp',
  'life',
  'mana',
  'stamina',
  'energy',
  'regen',
  'regeneration',
  'range',
  'reach',
  'crit',
  'critical',
  'chance',
  'rate',
  'resistance',
  'resist',
  'xp',
  'experience',
  'luck',
  'jump',
  'height',
  'duration',
  'cooldown',
  'stat',
  'stats',
  'all',
  'more',
  'extra',
  'bonus',
  'increased',
  'increase',
  'reduced',
  'reduce',
  'faster',
  'stronger',
  'higher',
  'longer',
  'better',
  'boost',
  'boosts',
  'grants',
  'gives',
  'adds',
  'to',
  'of',
  'the',
  'a',
  'an',
  'and',
  'per',
  'by',
  'plus',
  'for',
  'everything',
  'times',
]);

/**
 * True when a text is nothing but a stat change: it has a number and no word
 * outside the stat vocabulary ("+10% damage", "Grants 5 extra defense").
 */
export function isJustANumber(text: string): boolean {
  const t = text.toLowerCase();
  if (!/\d/.test(t)) return false;
  const words = t
    .replace(/[0-9]+([.,][0-9]+)?/g, ' ')
    .split(/[^a-z]+/)
    .filter((w) => w !== '' && w !== 'x');
  return words.every((w) => STAT_WORDS.has(w));
}

/** Another entity whose identity is the same line, normalised. */
function sameIdentity(world: World, identity: string, except?: string): Entity | undefined {
  const n = normName(identity);
  if (n.length < 8) return undefined;
  return Object.values(world.entities).find(
    (o) => o.id !== except && o.state !== 'graveyard' && normName(o.identity) === n,
  );
}

/** Another entity with this name, normalised (the duplicate criterion's name half). */
function sameName(world: World, name: string, except?: string): Entity | undefined {
  const n = normName(name);
  if (n === '') return undefined;
  return Object.values(world.entities).find((o) => o.id !== except && normName(o.name) === n);
}

/**
 * The criterion a proposed field value fails at once, or null. `except` is
 * the entity being written (its own name and identity don't count). Rule
 * clashes are not checked: taste rules are free prose with no keywords to
 * match (`TasteRuleSchema`), so only the critic can judge them.
 */
export function selfCheck(
  world: World,
  field: string,
  value: unknown,
  except?: string,
): QualityKind | null {
  if (typeof value !== 'string') return null;
  if (field === 'name' && sameName(world, value, except)) return 'duplicate';
  if (field === 'identity') {
    if (isJustANumber(value)) return 'just_a_number';
    if (sameIdentity(world, value, except)) return 'duplicate';
  }
  return null;
}

/** The criterion a new candidate (a spread's) fails at once, or null. */
export function selfCheckCandidate(
  world: World,
  c: { name: string; identity: string },
  except?: string,
): QualityKind | null {
  return (
    selfCheck(world, 'name', c.name, except) ?? selfCheck(world, 'identity', c.identity, except)
  );
}
