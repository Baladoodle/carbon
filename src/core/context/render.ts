import type { Entity } from '../model/entity';
import { isEmptyValue } from '../model/fields';
import { ENTITY_KINDS } from '../model/kinds';
import { entitiesOfKind, schemaOf, type World } from '../model/world';
import { stableStringify } from '../util/json';
import { bandBottom, defaultPlacement, type PlacementResolver } from './placement';
import { tasteContext, TOP_PATTERNS } from '../taste/context';

/**
 * Text renderings of the world for prompts. All of them are deterministic:
 * keys in schema order, entities by id, no clock. That is what makes the
 * stable parts of a prompt byte-identical between requests, so they cache.
 */

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A field value as compact text. */
export function renderValue(value: unknown): string {
  if (typeof value === 'string') return oneLine(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value.join(', ');
  return stableStringify(value);
}

/** One line: `- id (kind, state) "Name": identity`. */
export function renderSummary(e: Entity): string {
  const identity = e.identity.trim() === '' ? '' : `: ${oneLine(e.identity)}`;
  return `- ${e.id} (${e.kind}, ${e.state}) "${oneLine(e.name)}"${identity}`;
}

/** Every non-empty field, attribute and relation of an entity. */
export function renderFull(
  world: World,
  e: Entity,
  place: PlacementResolver = defaultPlacement,
): string {
  const schema = schemaOf(world);
  const kind = schema.kinds[e.kind];
  const lines = [`## ${e.id} (${e.kind}, ${e.state}) "${oneLine(e.name)}"`];
  const add = (label: string, v: unknown): void => {
    if (!isEmptyValue(v)) lines.push(`${label}: ${renderValue(v)}`);
  };
  add('identity', e.identity);
  for (const f of kind.fields) add(f.key, e.fields[f.key]);
  for (const k of Object.keys(e.fields).sort())
    if (!kind.fields.some((f) => f.key === k)) add(k, e.fields[k]);
  const attrs = Object.keys(e.attributes).sort();
  if (attrs.length > 0)
    lines.push(`attributes: ${attrs.map((k) => `${k}=${String(e.attributes[k])}`).join(', ')}`);
  if (e.relations.length > 0)
    lines.push(
      `relations: ${e.relations
        .map((r) => `${r.type} → ${r.target}${r.note ? ` (${oneLine(r.note)})` : ''}`)
        .join('; ')}`,
    );
  const p = place(world, e);
  if (e.kind !== 'band' && (p.band || p.biome))
    lines.push(
      `place: ${[p.band && `band ${p.band}`, p.biome && `biome ${p.biome}`].filter(Boolean).join(', ')}${p.inferred ? ' (inferred)' : ''}`,
    );
  add('tags', e.tags);
  add('why', e.why);
  if (e.killed)
    lines.push(`killed: ${e.killed.reason}${e.killed.note ? ` (${e.killed.note})` : ''}`);
  if (e.description.trim() !== '') lines.push(`description: ${oneLine(e.description)}`);
  return lines.join('\n');
}

/** How much of the world digest to include, from most to least. */
export type DigestLevel = 0 | 1 | 2 | 3;

/**
 * The world digest (SYSTEM §8 step 2): bands from the depths up with their
 * biomes, then counts and names per kind. Level 0 is everything; each level up
 * drops detail (names lists, then biome identities, then band identities), so
 * the packer can shrink it to fit a budget.
 */
export function renderDigest(world: World, level: DigestLevel = 0, namesPerKind = 150): string {
  const schema = schemaOf(world);
  const bands = entitiesOfKind(world, 'band').sort(
    (a, b) => bandBottom(a) - bandBottom(b) || a.id.localeCompare(b.id),
  );
  const biomes = entitiesOfKind(world, 'biome');
  const lines = [`# World: ${oneLine(world.settings.name)}`, '', '## Bands, from the depths up'];
  if (bands.length === 0) lines.push('(no bands yet)');
  for (const b of bands) {
    const y = `${renderValue(b.fields.y_bottom ?? '?')}..${renderValue(b.fields.y_top ?? '?')}`;
    const danger = b.fields.danger ? ` danger ${renderValue(b.fields.danger)}` : '';
    const who = level >= 3 ? '' : b.identity ? `: ${oneLine(b.identity)}` : '';
    const character =
      level >= 2 || !b.fields.character ? '' : ` (${renderValue(b.fields.character)})`;
    lines.push(`- ${b.id} "${oneLine(b.name)}" y ${y}${danger}${who}${character}`);
    for (const bi of biomes.filter((x) => x.fields.band === b.id)) {
      const id = level >= 2 || !bi.identity ? '' : `: ${oneLine(bi.identity)}`;
      lines.push(`  - biome ${bi.id} "${oneLine(bi.name)}"${id}`);
    }
  }
  const loose = biomes.filter((x) => !bands.some((b) => b.id === x.fields.band));
  for (const bi of loose) lines.push(`- biome ${bi.id} "${oneLine(bi.name)}" (no band)`);
  lines.push('', '## Entities per kind');
  for (const kind of ENTITY_KINDS) {
    const es = entitiesOfKind(world, kind).filter((e) => e.state !== 'graveyard');
    const label = schema.kinds[kind].plural;
    if (level >= 1 || es.length === 0) {
      lines.push(`- ${label}: ${es.length}`);
      continue;
    }
    const shown = es.slice(0, namesPerKind).map((e) => `${oneLine(e.name)} [${e.id}]`);
    const more = es.length > namesPerKind ? `, +${es.length - namesPerKind} more` : '';
    lines.push(`- ${label} (${es.length}): ${shown.join('; ')}${more}`);
  }
  const graveyard = Object.values(world.entities).filter((e) => e.state === 'graveyard').length;
  if (graveyard > 0) lines.push(`- In the graveyard: ${graveyard}`);
  return lines.join('\n');
}

/** Options for which taste goes into a request. */
export interface TasteOptions {
  /** Only these rules (a spread's switches); default all enabled rules. */
  ruleIds?: readonly string[];
  /** Leave the taste rules out entirely (a spread's wildcard). */
  withoutRules?: boolean;
  maxPatterns?: number;
}

/**
 * Taste (SYSTEM §8 step 2, EXPERIENCE §6): the active rules, the top patterns
 * and the kill reasons with use counts and recent examples. What goes in is
 * decided by `tasteContext` (src/core/taste), the same selection the Spread
 * and Taste views show; this renders it for the packer.
 */
export function renderTaste(world: World, opts: TasteOptions = {}): string {
  const t = tasteContext(world, opts.ruleIds);
  const active = opts.withoutRules ? [] : t.rules;
  const top = t.patterns.slice(0, opts.maxPatterns ?? TOP_PATTERNS);
  const lines = ['# Taste'];
  lines.push('', '## Rules (the designer’s own; never break them)');
  if (active.length === 0) lines.push('(none)');
  for (const r of active) lines.push(`- [${r.id}] ${oneLine(r.text)}`);
  if (top.length > 0) {
    lines.push('', '## Patterns learned from keeps and kills');
    for (const p of top)
      lines.push(
        `- ${oneLine(p.text)}${p.examples.length > 0 ? ` (e.g. ${p.examples.join(', ')})` : ''}`,
      );
  }
  if (t.kills.length > 0) {
    lines.push('', '## Why candidates get killed (most used first)');
    for (const k of t.kills)
      lines.push(
        `- ${k.label} (${k.count})${k.examples.length > 0 ? `: e.g. ${k.examples.map(oneLine).join(', ')}` : ''}`,
      );
  }
  return lines.join('\n');
}
