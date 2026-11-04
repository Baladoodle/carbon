import type { Candidate, MomentRequest, Spot } from '../ai/moments';
import { SpreadRequestSchema } from '../ai/moments';
import type { Entity } from '../model/entity';
import { ENTITY_KINDS, type EntityKind } from '../model/kinds';
import { kindAllowed } from '../model/validate';
import { entitiesOfKind, getEntity, schemaOf, type World } from '../model/world';
import { renderTaste, tasteContext } from '../taste/context';
import { MOVE_DEFS } from './moves';
import { bandOf, spotBand, spotEntities, spotKind } from './spot';

/**
 * The `spread` prompt builder (docs/SYSTEM.md §8): pure, deterministic, built
 * from the world and the request alone. Parts in cache order:
 *
 *  1. `system`   carbon's role and the spread rules (static)
 *  2. `digest`   the world in brief (changes slowly)
 *  3. `taste`    active rules, top patterns, kill-reason examples (changes slowly)
 *  4. `focus`    the spot, its entities and neighbours, the kind schema, the direction
 *  5. `task`     the move's instructions, ending with the diversity contract
 *
 * The real gateway (W4) sends 1–3 before the cache breakpoint and 4–5 after it.
 * It may replace `digest` with its context packer's output (`opts.digest`).
 */
export interface PromptParts {
  system: string;
  digest: string;
  taste: string;
  focus: string;
  task: string;
}

export interface PromptOptions {
  /** A packed world digest from the context packer, used instead of the built-in one. */
  digest?: string;
}

/** Caps that keep a spread prompt small however big the world grows. */
export const LIMITS = {
  namesPerKind: 60,
  neighbours: 24,
  focusEntities: 8,
  textChars: 240,
} as const;

/** A rough local token estimate (≈ 4 characters per token, rounded up). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export const promptTokens = (p: PromptParts): number =>
  estimateTokens(p.system + p.digest + p.taste + p.focus + p.task);

const clip = (s: string, n: number = LIMITS.textChars): string =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s;

const fmt = (v: unknown): string => {
  if (typeof v === 'string') return clip(v);
  return clip(JSON.stringify(v));
};

export const SPREAD_SYSTEM = [
  'You are the design partner inside carbon, a studio for designing the world and progression of Infinite: an endless vertical world on a Y axis, from endless depths to endless sky, divided into bands, each with biomes, materials, creatures, structures, and a progression of capabilities, items and feats.',
  'You are running a spread: you propose many candidates at once so the designer can judge them side by side. The designer keeps, kills or merges each one. You never change the world yourself.',
  'Ground every candidate in THIS world: use its bands, biomes, materials and creatures by name and id, and its own voice. Never generic fantasy, never a renamed copy of an existing entity, never an idea whose only point is a bigger number.',
  'Respect the taste block: its rules are hard constraints, its patterns and kill examples show what the designer likes and rejects. The one exception is the wildcard, described in the task.',
  'Use only entity ids that appear in the prompt. Write names in title case and identities as one sentence of at most 20 words.',
].join('\n\n');

/** The built-in world digest: bands with their biomes, then names per kind. */
export function worldDigest(world: World): string {
  const lines: string[] = [`<world name="${world.settings.name}">`];
  const bands = entitiesOfKind(world, 'band')
    .filter((b) => b.state !== 'graveyard')
    .sort((a, b) => heightNum(a.fields.y_bottom) - heightNum(b.fields.y_bottom));
  const biomes = entitiesOfKind(world, 'biome').filter((b) => b.state !== 'graveyard');
  lines.push('Bands, deepest first:');
  for (const b of bands) {
    lines.push(
      `- ${b.name} [${b.id}] y ${fmtH(b.fields.y_bottom)}..${fmtH(b.fields.y_top)}: ${clip(b.identity, 120)}`,
    );
    for (const bi of biomes.filter((x) => x.fields.band === b.id))
      lines.push(`  - biome ${bi.name} [${bi.id}]: ${clip(bi.identity, 100)}`);
  }
  for (const kind of ENTITY_KINDS) {
    if (kind === 'band' || kind === 'biome') continue;
    const es = entitiesOfKind(world, kind).filter((e) => e.state !== 'graveyard');
    if (es.length === 0) continue;
    const shown = es.slice(0, LIMITS.namesPerKind).map((e) => `${e.name} [${e.id}]`);
    const more = es.length > shown.length ? ` and ${es.length - shown.length} more` : '';
    lines.push(`${schemaOf(world).kinds[kind].plural} (${es.length}): ${shown.join(', ')}${more}`);
  }
  lines.push('</world>');
  return lines.join('\n');
}

const heightNum = (h: unknown): number =>
  h === '-inf' ? -Infinity : h === '+inf' ? Infinity : typeof h === 'number' ? h : 0;
const fmtH = (h: unknown): string =>
  typeof h === 'number' || typeof h === 'string' ? String(h) : '?';

/** One entity in full: fields, attributes and relations with their targets' names. */
export function renderEntity(world: World, e: Entity): string {
  const kind = schemaOf(world).kinds[e.kind];
  const lines = [`<entity id="${e.id}" kind="${e.kind}" state="${e.state}">`, `name: ${e.name}`];
  if (e.identity) lines.push(`identity: ${clip(e.identity)}`);
  if (e.description) lines.push(`description: ${clip(e.description, 600)}`);
  for (const f of kind.fields) {
    const v = e.fields[f.key];
    if (v === undefined) continue;
    lines.push(`${f.key}: ${fmt(v)}`);
  }
  for (const [k, v] of Object.entries(e.attributes)) lines.push(`attribute ${k}: ${v}`);
  for (const r of e.relations) {
    const t = getEntity(world, r.target);
    lines.push(
      `${r.type} → ${t?.name ?? r.target} [${r.target}]${r.note ? ` (${clip(r.note, 100)})` : ''}`,
    );
  }
  if (e.tags.length > 0) lines.push(`tags: ${e.tags.join(', ')}`);
  lines.push('</entity>');
  return lines.join('\n');
}

const summary = (e: Entity): string =>
  `- ${e.name} [${e.id}] (${e.kind}, ${e.state}): ${clip(e.identity, 120)}`;

/** Entities near the spot: same band and kind first, then the band's others. */
export function neighbours(world: World, spot: Spot, kind: EntityKind): Entity[] {
  const band = spotBand(world, spot);
  const focus = new Set(spotEntities(world, spot));
  const all = Object.values(world.entities)
    .filter((e) => !focus.has(e.id) && e.state !== 'graveyard' && e.kind !== 'band')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const inBand = (e: Entity): boolean => band !== undefined && bandOf(world, e.id) === band;
  const ranked = [
    ...all.filter((e) => e.kind === kind && inBand(e)),
    ...all.filter((e) => e.kind !== kind && inBand(e)),
    ...all.filter((e) => e.kind === kind && !inBand(e)),
  ];
  return ranked.slice(0, LIMITS.neighbours);
}

/** The kind's schema as the model needs it: fields, required ones, allowed relations. */
export function renderKind(world: World, kind: EntityKind): string {
  const schema = schemaOf(world);
  const def = schema.kinds[kind];
  const lines = [`<kind name="${kind}">`];
  for (const f of def.fields) {
    const opts = f.options ? ` one of ${f.options.join(' | ')}` : '';
    const range =
      f.min !== undefined || f.max !== undefined ? ` ${f.min ?? '-∞'}..${f.max ?? '∞'}` : '';
    lines.push(`field ${f.key} (${f.type}${opts}${range})${f.help ? `: ${f.help}` : ''}`);
  }
  for (const a of def.attributes)
    lines.push(`attribute ${a.key}${a.when ? ` when ${JSON.stringify(a.when)}` : ''}`);
  const need = [...new Set([...def.required.idea, ...def.required.shaped])];
  if (need.length > 0) lines.push(`fill if you can: ${need.join(', ')}`);
  const rels = Object.values(schema.relations).filter((r) => kindAllowed(r.from, kind));
  lines.push(
    `relations it can have: ${rels.map((r) => `${r.type} → ${r.to === '*' ? 'any' : r.to.join('|')}`).join('; ')}`,
  );
  lines.push('</kind>');
  return lines.join('\n');
}

function renderSpot(world: World, spot: Spot): string {
  const name = (id: string): string => getEntity(world, id)?.name ?? id;
  switch (spot.type) {
    case 'cell':
      return `A Column cell: the ${spot.lane} lane of the band ${name(spot.band)} [${spot.band}].`;
    case 'region': {
      const c = spot.climate;
      return `A Climate region of the band ${name(spot.band)} [${spot.band}]: temperature ${c.temperature.min}..${c.temperature.max}, moisture ${c.moisture.min}..${c.moisture.max} (0 cold/dry, 1 hot/wet).`;
    }
    case 'entity':
      return `A single entity: ${name(spot.entity)} [${spot.entity}].`;
    case 'selection':
      return `A selection of ${spot.entities.length} entities: ${spot.entities.map((id) => `${name(id)} [${id}]`).join(', ')}.`;
    case 'note':
      return `A note: "${clip(spot.note, 500)}"${spot.entities.length > 0 ? `, about ${spot.entities.map((id) => `${name(id)} [${id}]`).join(', ')}` : ''}.`;
  }
}

/** The focus part: the spot, its entities, neighbours, the kind schema and the direction. */
export function spreadFocus(
  world: World,
  req: MomentRequest<'spread'>,
  parent?: Candidate,
): string {
  const r = SpreadRequestSchema.parse(req);
  const kind = spotKind(world, r.spot);
  const lines = ['<focus>', `Spot: ${renderSpot(world, r.spot)}`];
  const band = spotBand(world, r.spot);
  const bandE = band ? getEntity(world, band) : undefined;
  if (bandE) lines.push('The band:', renderEntity(world, bandE));
  if (r.spot.type === 'region') {
    lines.push('Biomes already on this band’s climate plane:');
    for (const b of entitiesOfKind(world, 'biome').filter((x) => x.fields.band === band))
      lines.push(`- ${b.name} [${b.id}] climate ${fmt(b.fields.climate)}`);
  }
  const focus = spotEntities(world, r.spot).slice(0, LIMITS.focusEntities);
  if (focus.length > 0) {
    lines.push('In focus:');
    for (const id of focus) lines.push(renderEntity(world, getEntity(world, id) as Entity));
  }
  const near = neighbours(world, r.spot, kind);
  if (near.length > 0) {
    lines.push('Nearby (do not repeat these):');
    for (const e of near) lines.push(summary(e));
  }
  if (parent) lines.push(`Followed from the candidate "${parent.name}": ${clip(parent.identity)}`);
  lines.push(renderKind(world, kind));
  if (r.direction?.trim())
    lines.push(`Direction from the designer: ${clip(r.direction.trim(), 300)}`);
  lines.push('</focus>');
  return lines.join('\n');
}

/** The task part: the move, the output shape and the diversity contract (always last). */
export function spreadTask(world: World, req: MomentRequest<'spread'>): string {
  const r = SpreadRequestSchema.parse(req);
  const def = MOVE_DEFS[r.move];
  const axes = r.axes ?? def.axes;
  const kind = spotKind(world, r.spot);
  const n = r.count;
  const out: string[] = ['<task>', `Move: ${def.label}. ${def.instructions}`];
  if (def.output === 'finding')
    out.push(
      'Every candidate is a finding: kind null, no fields; relations name the entities involved.',
    );
  else if (def.output === 'about')
    out.push(
      `Every candidate changes an existing entity: set "about" to its id (one of: ${spotEntities(world, r.spot).join(', ')}) and kind to that entity's kind.`,
    );
  else out.push(`Every candidate is a new ${kind}: kind "${kind}", with the fields it can fill.`);
  out.push(
    `Field axes: x = ${axes.x.label} (0 ${axes.x.low} → 1 ${axes.x.high}); y = ${axes.y.label} (0 ${axes.y.low} → 1 ${axes.y.high}). Give each candidate a position {x, y} in 0..1 that honestly places it on both.`,
    'Keys are "c1", "c2", … in order. Stream candidates one at a time.',
    '',
    'Diversity contract:',
    `- Exactly ${n} candidates.`,
    `- Spread them across the field: no quadrant of the ${axes.x.label} × ${axes.y.label} plane left empty when ${n} ≥ 4, and no two at the same position.`,
    `- The last candidate (c${n}) is the wildcard: "wildcard": true, and it ignores the taste block entirely (rules, patterns and kills). All others have "wildcard": false and obey taste.`,
    '- No two candidates share a verb: the first verb of each identity is different.',
    '- No candidate repeats an existing name or another candidate’s idea.',
    '</task>',
  );
  return out.join('\n');
}

/** Builds the whole `spread` prompt. */
export function buildSpreadPrompt(
  world: World,
  req: MomentRequest<'spread'>,
  opts: PromptOptions & { parent?: Candidate } = {},
): PromptParts {
  const r = SpreadRequestSchema.parse(req);
  return {
    system: SPREAD_SYSTEM,
    digest: opts.digest ?? worldDigest(world),
    taste: renderTaste(tasteContext(world, r.ruleIds)),
    focus: spreadFocus(world, r, opts.parent),
    task: spreadTask(world, r),
  };
}
