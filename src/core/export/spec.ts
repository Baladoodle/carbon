import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { cmd, type Command } from '../commands/registry';
import type { Entity } from '../model/entity';
import type { FieldDef } from '../model/fields';
import { ENTITY_KINDS, type EntityKind, type EntityState } from '../model/kinds';
import { getEntity, schemaOf, type World } from '../model/world';
import { routeNeeds } from '../checks/checks';
import { createNumbersAdapter, type NumbersAdapter } from '../checks/numbers';
import { resolvedPlaces, type PlacementFn } from '../checks/placement';

/**
 * Export (docs/EXPERIENCE.md §7): decided entities out as a markdown spec for
 * Claude Code. All pure: choosing entities, the deterministic spec (the
 * fallback when the AI is off, and the skeleton the AI draft is checked
 * against), the file name, the header that records what was exported, and the
 * commands that mark the entities exported.
 */

/** States an entity can be exported from (re-exporting an exported one is fine). */
export const EXPORTABLE: readonly EntityState[] = ['decided', 'exported'];
export const isExportable = (e: Entity): boolean => EXPORTABLE.includes(e.state);

export interface Selection {
  kinds?: readonly EntityKind[];
  bands?: readonly string[];
  /** Hand-picked ids (added to the kind and band choice). */
  ids?: readonly string[];
}

/**
 * The exportable entities a selection covers, in a stable order (by kind,
 * then name). Kinds and bands narrow each other; hand-picked ids are added.
 */
export function selectForExport(
  world: World,
  sel: Selection,
  placement: PlacementFn = resolvedPlaces,
): Entity[] {
  const places = sel.bands?.length ? placement(world) : null;
  const picked = new Set(sel.ids ?? []);
  const byRule = (e: Entity): boolean => {
    if (!sel.kinds?.length && !sel.bands?.length) return false;
    if (sel.kinds?.length && !sel.kinds.includes(e.kind)) return false;
    if (sel.bands?.length && places) {
      const bands = e.kind === 'band' ? [e.id] : (places.get(e.id)?.bands ?? []);
      if (!bands.some((b) => sel.bands?.includes(b))) return false;
    }
    return true;
  };
  return Object.values(world.entities)
    .filter((e) => isExportable(e) && (picked.has(e.id) || byRule(e)))
    .sort(
      (a, b) =>
        ENTITY_KINDS.indexOf(a.kind) - ENTITY_KINDS.indexOf(b.kind) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
}

/** A slug for file names: lower case, ascii, dashes. */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return s || 'spec';
}

/** `exports/YYYY-MM-DD-<slug>.md`, with `-2`, `-3`… if the name is taken. */
export function exportPath(date: string, name: string, existing: ReadonlySet<string>): string {
  const base = `${date}-${slugify(name)}`;
  let p = `exports/${base}.md`;
  for (let n = 2; existing.has(p); n++) p = `exports/${base}-${n}.md`;
  return p;
}

export interface ExportHeader {
  name: string;
  date: string;
  entities: string[];
}

/**
 * The spec file: a small YAML header (what carbon exported, so it can tell
 * later which entities changed since) and the markdown the user edited.
 */
export function withExportHeader(markdown: string, h: ExportHeader): string {
  const yaml = stringifyYaml(
    { carbon_export: 1, name: h.name, date: h.date, entities: h.entities },
    { lineWidth: 0 },
  );
  return `---\n${yaml}---\n\n${markdown.replace(/^\s+/, '').replace(/\s+$/, '')}\n`;
}

/** Reads the header back; null for a file carbon didn't write. */
export function readExportHeader(text: string): ExportHeader | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  let raw: unknown;
  try {
    raw = parseYaml(m[1] ?? '');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.carbon_export !== 1 || typeof r.name !== 'string' || !Array.isArray(r.entities))
    return null;
  return {
    name: r.name,
    date: typeof r.date === 'string' ? r.date : '',
    entities: r.entities.filter((x): x is string => typeof x === 'string'),
  };
}

/** Commands that mark the entities exported: one transaction, decided ones only. */
export function exportCommands(world: World, ids: readonly string[]): Command[] {
  return ids
    .map((id) => getEntity(world, id))
    .filter((e): e is Entity => e?.state === 'decided')
    .map((e) => cmd('entity.setState', { id: e.id, state: 'exported' }));
}

/** Entities exported before and edited since (back to `decided`): EXPERIENCE §8's flag. */
export function changedSinceExport(world: World, exports: readonly ExportHeader[]): Entity[] {
  const ids = new Set(exports.flatMap((x) => x.entities));
  return [...ids]
    .map((id) => getEntity(world, id))
    .filter((e): e is Entity => e?.state === 'decided')
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ── The deterministic spec ──────────────────────────────────────────────────

function show(value: unknown, def: FieldDef | undefined, world: World): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (Array.isArray(value) && value.length === 0) return null;
  switch (def?.type) {
    case 'ref':
      return typeof value === 'string' ? (getEntity(world, value)?.name ?? value) : null;
    case 'range': {
      const r = value as { min?: number; max?: number };
      return `${r.min ?? '…'}–${r.max ?? '…'}`;
    }
    case 'climate': {
      const c = value as {
        temperature: { min: number; max: number };
        moisture: { min: number; max: number };
      };
      return `temperature ${c.temperature.min}–${c.temperature.max}, moisture ${c.moisture.min}–${c.moisture.max}`;
    }
    case 'steps':
      return null; // rendered as its own list
    default:
      if (Array.isArray(value)) return value.map(String).join(', ');
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
        return String(value);
      return JSON.stringify(value);
  }
}

const one = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Acceptance questions Claude Code can test the implementation against. */
export function acceptanceQuestions(world: World, e: Entity): string[] {
  const q: string[] = [];
  const f = e.fields;
  const name = e.name;
  const str = (k: string): string | null =>
    typeof f[k] === 'string' && f[k] !== '' ? one(f[k]) : null;
  switch (e.kind) {
    case 'item': {
      const change = str('change');
      const tradeoff = str('tradeoff');
      const moment = str('moment');
      if (change) q.push(`With ${name}, does the game change like this: ${change}?`);
      if (tradeoff) q.push(`Is the cost of using ${name} felt: ${tradeoff}?`);
      if (moment) q.push(`Does the first moment with ${name} play out as: ${moment}?`);
      const needs = routeNeeds(e).map((id) => getEntity(world, id)?.name ?? id);
      if (needs.length) q.push(`Can a player get ${name} only by way of ${needs.join(', ')}?`);
      break;
    }
    case 'band': {
      const b = f.y_bottom;
      const t = f.y_top;
      const h = (v: unknown): string | null =>
        typeof v === 'number' || typeof v === 'string' ? String(v) : null;
      if (h(b) !== null && h(t) !== null)
        q.push(`Does ${name} span Y ${h(b) ?? ''} to ${h(t) ?? ''}?`);
      const c = str('character');
      if (c) q.push(`Does being in ${name} feel ${c.toLowerCase()}?`);
      break;
    }
    case 'biome': {
      const band = typeof f.band === 'string' ? getEntity(world, f.band)?.name : undefined;
      if (band) q.push(`Does ${name} generate only within ${band}?`);
      const sig = str('signature');
      if (sig) q.push(`Is ${name} recognisable by ${sig}?`);
      break;
    }
    case 'capability': {
      const verb = str('verb');
      if (verb) q.push(`Can the player now ${verb.replace(/^to /, '')}?`);
      break;
    }
    case 'feat': {
      const deed = str('deed');
      if (deed) q.push(`Is ${name} earned by: ${deed}?`);
      break;
    }
    default:
      break;
  }
  const schema = schemaOf(world);
  for (const r of e.relations) {
    const def = schema.relations[r.type];
    const t = getEntity(world, r.target);
    if (!def || !t) continue;
    if (['found_in', 'lives_in', 'drops', 'made_from', 'unlocks', 'counters'].includes(r.type))
      q.push(`Does ${name} ${def.label} ${t.name}?`);
  }
  return q;
}

export interface SpecOptions {
  name: string;
  numbers?: NumbersAdapter;
}

/** The deterministic spec: summary, each entity in full, formulas, acceptance questions. */
export function buildSpec(world: World, ids: readonly string[], opts: SpecOptions): string {
  const schema = schemaOf(world);
  const entities = ids.map((id) => getEntity(world, id)).filter((e): e is Entity => !!e);
  const out: string[] = [`# ${opts.name}`, '', '## Summary', ''];
  const counts = ENTITY_KINDS.map((k) => {
    const n = entities.filter((e) => e.kind === k).length;
    return n === 0
      ? null
      : `${n} ${n === 1 ? schema.kinds[k].label.toLowerCase() : schema.kinds[k].plural.toLowerCase()}`;
  }).filter(Boolean);
  out.push(`${counts.join(', ')}: ${entities.map((e) => e.name).join(', ')}.`, '');
  for (const e of entities) {
    const kind = schema.kinds[e.kind];
    out.push(`## ${e.name}`, '', `*${kind.label}* · \`${e.id}\``, '');
    if (e.identity) out.push(`> ${one(e.identity)}`, '');
    if (e.description) out.push(e.description.trim(), '');
    const rows: string[] = [];
    for (const def of kind.fields) {
      const v = show(e.fields[def.key], def, world);
      if (v !== null) rows.push(`- **${def.label}:** ${one(v)}`);
    }
    if (rows.length) out.push(...rows, '');
    const route = e.fields.route;
    if (Array.isArray(route) && route.length) {
      out.push('**Route**', '');
      (route as { text?: string; needs?: string[] }[]).forEach((s, i) => {
        const needs = (s.needs ?? []).map((id) => getEntity(world, id)?.name ?? id);
        out.push(
          `${i + 1}. ${one(s.text ?? '')}${needs.length ? ` (needs ${needs.join(', ')})` : ''}`,
        );
      });
      out.push('');
    }
    const attrs = Object.entries(e.attributes).sort(([a], [b]) => a.localeCompare(b));
    if (attrs.length) {
      out.push('| Attribute | Value |', '|---|---|');
      for (const [k, v] of attrs) {
        const label = kind.attributes.find((a) => a.key === k)?.label ?? k;
        out.push(`| ${label} | ${v} |`);
      }
      out.push('');
    }
    const rels = e.relations
      .map((r) => {
        const def = schema.relations[r.type];
        const t = getEntity(world, r.target);
        return `- ${def?.label ?? r.type} ${t?.name ?? r.target}${r.note ? ` — ${one(r.note)}` : ''}`;
      })
      .sort();
    if (rels.length) out.push(...rels, '');
    if (e.why) out.push(`**Why:** ${one(e.why)}`, '');
  }
  const formulas = (opts.numbers ?? createNumbersAdapter()).dependencies?.(world, ids) ?? [];
  if (formulas.length) out.push('## Formulas', '', '```', ...formulas, '```', '');
  const questions = entities.flatMap((e) => acceptanceQuestions(world, e));
  out.push('## Acceptance questions', '');
  if (questions.length) out.push(...questions.map((q) => `- [ ] ${q}`));
  else out.push(`- [ ] Does each entity above exist in the game as described?`);
  return `${out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
}
