import type { Entity } from '@core/model/entity';
import { isEmptyValue, type FieldDef } from '@core/model/fields';
import {
  ENTITY_KINDS,
  ENTITY_STATES,
  LANE_OF_KIND,
  LANES,
  type EntityKind,
} from '@core/model/kinds';
import { fieldValue } from '@core/model/lifecycle';
import { schemaOf, type World } from '@core/model/world';
import type { Placement } from '@core/placement';
import { parseNumber as parseDecimal } from '@core/bench/value';

/**
 * The Codex filter language (docs/EXPERIENCE.md §2), e.g.
 *
 *     state:decided band:"Low Sky" lane:items
 *
 * Pure (no React, no DOM), so it's unit- and property-tested on its own.
 *
 * Grammar:
 *
 *     query  := term (whitespace term)*         terms are ANDed
 *     term   := "-"? (key ":" op? values | word) "-" negates
 *     op     := ">" | ">=" | "<" | "<=" | "="   numeric comparison
 *     values := value ("," value)*               alternatives are ORed
 *     value  := bare | "quoted"                  a range is lo..hi
 *     word   := bare | "quoted"                  free text: name, identity, id, tags
 *
 * Keys: `state`, `kind`, `lane`, `band`, `biome`, `placed`, `name`, `identity`,
 * `description`, `why`, `id`, `tag`, `ai`, `origin`, `has`, `y`, every kind
 * field (`subkind:armor`, `rarity:rare,legendary`, `menace:>0`), every
 * attribute (`defense:>=4`) and every relation type (`made_from:"Vent Glass"`).
 */

export interface Span {
  from: number;
  to: number;
}

export interface QueryError extends Span {
  message: string;
}

export type CompareOp = '>' | '>=' | '<' | '<=' | '=';

export interface QueryValue extends Span {
  text: string;
  quoted: boolean;
}

export interface Term extends Span {
  negate: boolean;
  /** `null` for a free-text word. */
  key: string | null;
  keySpan: Span | null;
  op: CompareOp | null;
  values: QueryValue[];
}

export interface ParsedQuery {
  terms: Term[];
  errors: QueryError[];
}

const KEY_RE = /^[a-z_][a-z0-9_]*$/;
const isSpace = (c: string | undefined): boolean => c === ' ' || c === '\t' || c === '\n';

/** Parses a query. Never throws; every problem becomes an error with a span. */
export function parseQuery(src: string): ParsedQuery {
  const terms: Term[] = [];
  const errors: QueryError[] = [];
  let i = 0;
  const n = src.length;

  /** Reads one value (bare or quoted), stopping at whitespace or, if `inList`, a comma. */
  const readValue = (inList: boolean): QueryValue | null => {
    const from = i;
    if (src[i] === '"') {
      i++;
      let text = '';
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < n) {
          text += src.charAt(i + 1);
          i += 2;
        } else text += src.charAt(i++);
      }
      if (i >= n) {
        errors.push({ from, to: n, message: 'unclosed quote' });
        return { from, to: n, text, quoted: true };
      }
      i++;
      return { from, to: i, text, quoted: true };
    }
    while (i < n && !isSpace(src[i]) && !(inList && src[i] === ',') && src[i] !== '"') i++;
    if (i === from) return null;
    return { from, to: i, text: src.slice(from, i), quoted: false };
  };

  while (i < n) {
    while (i < n && isSpace(src[i])) i++;
    if (i >= n) break;
    const from = i;
    let negate = false;
    if (src[i] === '-' && i + 1 < n && !isSpace(src[i + 1])) {
      negate = true;
      i++;
    }
    // A key is letters up to a colon; anything else is a word.
    const keyStart = i;
    while (i < n && /[a-z0-9_]/i.test(src[i] ?? '')) i++;
    if (src[i] === ':' && i > keyStart) {
      const keyText = src.slice(keyStart, i).toLowerCase();
      const keySpan = { from: keyStart, to: i };
      i++;
      let op: CompareOp | null = null;
      const two = src.slice(i, i + 2);
      if (two === '>=' || two === '<=') {
        op = two;
        i += 2;
      } else if (src[i] === '>' || src[i] === '<' || src[i] === '=') {
        op = src[i] as CompareOp;
        i++;
      }
      const values: QueryValue[] = [];
      for (;;) {
        const v = readValue(true);
        if (v) values.push(v);
        if (src[i] === ',') {
          i++;
          if (i >= n || isSpace(src[i])) {
            errors.push({ from: i - 1, to: i, message: 'a value is missing after ","' });
            break;
          }
          continue;
        }
        break;
      }
      // Glued junk like `a:"b"c`: swallow it into an error rather than a new term.
      if (i < n && !isSpace(src[i])) {
        const junk = i;
        while (i < n && !isSpace(src[i])) i++;
        errors.push({ from: junk, to: i, message: 'expected a space here' });
      }
      if (!KEY_RE.test(keyText))
        errors.push({ ...keySpan, message: `"${keyText}" is not a filter key` });
      if (values.length === 0) errors.push({ from, to: i, message: `${keyText}: needs a value` });
      terms.push({ from, to: i, negate, key: keyText, keySpan, op, values });
      continue;
    }
    i = keyStart;
    const v = readValue(false);
    if (!v) {
      // A stray quote position or a lone "-": consume one char to make progress.
      i = Math.max(i, from + 1);
      errors.push({ from, to: i, message: 'expected a filter' });
      continue;
    }
    if (i < n && !isSpace(src[i])) {
      const junk = i;
      while (i < n && !isSpace(src[i])) i++;
      errors.push({ from: junk, to: i, message: 'expected a space here' });
    }
    terms.push({ from, to: i, negate, key: null, keySpan: null, op: null, values: [v] });
  }
  return { terms, errors };
}

const quote = (s: string): string =>
  s === '' || /[\s,":\\]/.test(s) || s.startsWith('-') ? `"${s.replace(/["\\]/g, '\\$&')}"` : s;

/** Prints terms back as a query (canonical spacing and quoting). `parseQuery(formatQuery(t))` gives `t` back. */
export function formatQuery(terms: readonly Term[]): string {
  return terms
    .map((t) => {
      const vals = t.values.map((v) => quote(v.text)).join(',');
      return `${t.negate ? '-' : ''}${t.key === null ? vals : `${t.key}:${t.op ?? ''}${vals}`}`;
    })
    .join(' ');
}

// ── Compiling against a world ────────────────────────────────────────────────

/** What a row offers the matcher. */
export interface Row {
  entity: Entity;
  placement: Placement | undefined;
}

export type Matcher = (row: Row) => boolean;

export interface CompiledQuery {
  match: Matcher;
  errors: QueryError[];
  /** The kinds the query restricts to through `kind:` or `lane:` (null: any). */
  kinds: EntityKind[] | null;
  /** Whether the query is empty (matches everything). */
  empty: boolean;
}

const BUILTIN_KEYS = [
  'state',
  'kind',
  'lane',
  'band',
  'biome',
  'placed',
  'name',
  'identity',
  'description',
  'why',
  'id',
  'tag',
  'tags',
  'ai',
  'origin',
  'has',
  'y',
] as const;

const lower = (s: string): string => s.toLowerCase();
const includes = (hay: string, needle: string): boolean => lower(hay).includes(lower(needle));

/** Levenshtein distance, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return row[b.length] ?? 0;
}

const suggest = (word: string, options: readonly string[]): string => {
  let best: string | null = null;
  let bestD = Infinity;
  for (const o of options) {
    const d = distance(word, o);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best !== null && bestD <= Math.max(1, Math.floor(word.length / 3))
    ? `; did you mean ${best}?`
    : '';
};

/** A number in a filter: as the Bench reads one (the ruler's typographic minus too), or ±inf. */
const parseNumber = (s: string): number | null => {
  const t = s.trim().replace(/−/g, '-');
  if (t === '') return null;
  if (t === 'inf' || t === '+inf') return Infinity;
  if (t === '-inf') return -Infinity;
  return parseDecimal(t);
};

type NumTest = (x: number) => boolean;
type RangeTest = (lo: number, hi: number) => boolean;

/** A numeric test for one value: `5`, `2..5`, or with an op. Null with an error message if invalid. */
function numericTest(op: CompareOp | null, v: QueryValue): { test: RangeTest } | { error: string } {
  const range = /^(.*)\.\.(.*)$/.exec(v.text);
  if (range && op === null) {
    const lo = parseNumber(range[1] ?? '');
    const hi = parseNumber(range[2] ?? '');
    if (lo === null || hi === null || lo > hi)
      return { error: `"${v.text}" is not a range like 2..5` };
    return { test: (a, b) => a <= hi && b >= lo };
  }
  const x = parseNumber(v.text);
  if (x === null) return { error: `"${v.text}" is not a number` };
  // A value with extent (a band's Y range) matches if any point in it does.
  switch (op ?? '=') {
    case '>':
      return { test: (_a, b) => b > x };
    case '>=':
      return { test: (_a, b) => b >= x };
    case '<':
      return { test: (a) => a < x };
    case '<=':
      return { test: (a) => a <= x };
    default:
      return { test: (a, b) => a <= x && x <= b };
  }
}

const point =
  (t: RangeTest): NumTest =>
  (x) =>
    t(x, x);

/** Matches an entity's value of a kind field against one query value. */
function fieldTest(
  def: FieldDef,
  v: QueryValue,
  op: CompareOp | null,
  world: World,
): ((raw: unknown) => boolean) | string {
  const t = v.text;
  const num = (): ((raw: unknown) => boolean) | string => {
    const nt = numericTest(op, v);
    if ('error' in nt) return nt.error;
    if (def.type === 'range')
      return (raw) => {
        const r = raw as { min?: unknown; max?: unknown } | undefined;
        return typeof r?.min === 'number' && typeof r.max === 'number' && nt.test(r.min, r.max);
      };
    if (def.type === 'height')
      return (raw) => {
        const x = raw === '-inf' ? -Infinity : raw === '+inf' ? Infinity : raw;
        return typeof x === 'number' && point(nt.test)(x);
      };
    return (raw) => typeof raw === 'number' && point(nt.test)(raw);
  };
  switch (def.type) {
    case 'number':
    case 'range':
    case 'height':
      return num();
    case 'boolean': {
      const yes = ['yes', 'true', 'y', '1'].includes(lower(t));
      const no = ['no', 'false', 'n', '0'].includes(lower(t));
      if (!yes && !no) return `${def.key}: use yes or no`;
      return (raw) => (raw === true) === yes;
    }
    case 'enum':
      if (op) return `${def.key}: can't compare a choice with ${op}`;
      if (def.options && !def.options.some((o) => lower(o) === lower(t)))
        return `${def.key}: no option "${t}"${suggest(lower(t), def.options)}`;
      return (raw) => typeof raw === 'string' && lower(raw) === lower(t);
    case 'list':
      if (op) return `${def.key}: can't compare a list with ${op}`;
      return (raw) =>
        Array.isArray(raw) && raw.some((x) => typeof x === 'string' && includes(x, t));
    case 'ref':
      if (op) return `${def.key}: can't compare a reference with ${op}`;
      return (raw) => {
        if (typeof raw !== 'string') return false;
        const target = world.entities[raw];
        return lower(raw) === lower(t) || (!!target && lower(target.name) === lower(t));
      };
    case 'steps':
      if (op) return `${def.key}: can't compare steps with ${op}`;
      return (raw) =>
        Array.isArray(raw) &&
        raw.some(
          (s: { text?: unknown; needs?: unknown }) =>
            (typeof s.text === 'string' && includes(s.text, t)) ||
            (Array.isArray(s.needs) && s.needs.includes(t)),
        );
    case 'climate':
      return `${def.key}: climate can't be filtered`;
    case 'text':
    case 'longtext':
      if (op) return `${def.key}: can't compare text with ${op}`;
      return (raw) => typeof raw === 'string' && includes(raw, t);
  }
}

/**
 * Compiles a query against a world: checks keys and values, and returns a
 * matcher. Terms with errors are left out, so the rest still filters.
 */
export function compileQuery(src: string, world: World): CompiledQuery {
  const parsed = parseQuery(src);
  const errors = [...parsed.errors];
  const schema = schemaOf(world);
  const matchers: Matcher[] = [];
  let kinds: Set<EntityKind> | null = null;

  const fieldDefs = new Map<string, Map<EntityKind, FieldDef>>();
  for (const k of ENTITY_KINDS)
    for (const f of schema.kinds[k].fields) {
      const m = fieldDefs.get(f.key) ?? new Map<EntityKind, FieldDef>();
      m.set(k, f);
      fieldDefs.set(f.key, m);
    }
  const attrKeys = new Set<string>();
  for (const k of ENTITY_KINDS) for (const a of schema.kinds[k].attributes) attrKeys.add(a.key);
  for (const e of Object.values(world.entities))
    for (const a of Object.keys(e.attributes)) attrKeys.add(a);
  const relTypes = new Set(Object.keys(schema.relations));
  const allKeys = [...BUILTIN_KEYS, ...fieldDefs.keys(), ...attrKeys, ...relTypes];

  const byName = (t: string, kind: EntityKind): string | null => {
    const l = lower(t);
    for (const e of Object.values(world.entities))
      if (e.kind === kind && (e.id === l || lower(e.name) === l)) return e.id;
    return null;
  };

  for (const term of parsed.terms) {
    if (term.values.length === 0) continue;
    const at = (v: Span, message: string): void =>
      void errors.push({ from: v.from, to: v.to, message });
    const alts: Matcher[] = [];
    let bad = false;
    const add = (m: Matcher): void => void alts.push(m);

    if (term.key === null) {
      const t = term.values[0]?.text ?? '';
      add(
        ({ entity: e }) =>
          includes(e.name, t) ||
          includes(e.identity, t) ||
          includes(e.id, t) ||
          e.tags.some((g) => includes(g, t)),
      );
    } else {
      const key = term.key;
      const keySpan = term.keySpan ?? term;
      const noOp = (): boolean => {
        if (!term.op) return true;
        at(keySpan, `${key}: can't compare with ${term.op}`);
        bad = true;
        return false;
      };
      const isBuiltin = (BUILTIN_KEYS as readonly string[]).includes(key);
      if (isBuiltin && key !== 'y' && !noOp()) continue;
      for (const v of term.values) {
        const t = v.text;
        const l = lower(t);
        switch (key) {
          case 'state':
            if (!(ENTITY_STATES as readonly string[]).includes(l)) {
              at(v, `no state "${t}"${suggest(l, ENTITY_STATES)}`);
              bad = true;
            } else add(({ entity: e }) => e.state === l);
            break;
          case 'kind':
          case 'lane': {
            const k = kindFrom(l, schema);
            if (!k) {
              at(v, `no ${key} "${t}"${suggest(l, key === 'lane' ? LANES : ENTITY_KINDS)}`);
              bad = true;
            } else {
              add(({ entity: e }) => e.kind === k);
              if (!term.negate) {
                kinds ??= new Set<EntityKind>();
                kinds.add(k);
              }
            }
            break;
          }
          case 'band':
          case 'biome': {
            if (l === 'none') {
              add(({ placement: p }) =>
                key === 'band' ? !p || p.bands.length === 0 : !p || p.biomes.length === 0,
              );
              break;
            }
            const id = byName(t, key);
            if (!id) {
              at(v, `no ${key} "${t}"`);
              bad = true;
            } else
              add(
                ({ entity: e, placement: p }) =>
                  e.id === id ||
                  (key === 'band' ? !!p?.bands.includes(id) : !!p?.biomes.includes(id)),
              );
            break;
          }
          case 'placed': {
            const mode = l === 'none' ? 'unplaced' : l;
            if (!['pinned', 'inferred', 'unplaced'].includes(mode)) {
              at(v, 'placed: use pinned, inferred or none');
              bad = true;
            } else add(({ placement: p }) => (p?.mode ?? 'unplaced') === mode);
            break;
          }
          case 'name':
          case 'identity':
          case 'description':
          case 'why':
            add(({ entity: e }) => includes(e[key], t));
            break;
          case 'id':
            add(({ entity: e }) => includes(e.id, t));
            break;
          case 'tag':
          case 'tags':
            add(({ entity: e }) => e.tags.some((g) => lower(g) === l));
            break;
          case 'ai': {
            const yes = ['yes', 'true', 'y', '1'].includes(l);
            if (!yes && !['no', 'false', 'n', '0'].includes(l)) {
              at(v, 'ai: use yes or no');
              bad = true;
            } else add(({ entity: e }) => e.ai_fields.length > 0 === yes);
            break;
          }
          case 'origin':
            if (l !== 'user' && l !== 'ai') {
              at(v, 'origin: use user or ai');
              bad = true;
            } else add(({ entity: e }) => e.origin.by === l);
            break;
          case 'has': {
            const isField =
              fieldDefs.has(l) || ['name', 'identity', 'description', 'why', 'tags'].includes(l);
            if (!isField && !attrKeys.has(l) && !relTypes.has(l)) {
              at(
                v,
                `no field "${t}"${suggest(l, [...fieldDefs.keys(), ...attrKeys, ...relTypes])}`,
              );
              bad = true;
            } else
              add(({ entity: e }) => {
                if (relTypes.has(l) && e.relations.some((r) => r.type === l)) return true;
                if (attrKeys.has(l) && e.attributes[l] !== undefined) return true;
                return isField && !isEmptyValue(fieldValue(e, l));
              });
            break;
          }
          case 'y': {
            const nt = numericTest(term.op, v);
            if ('error' in nt) {
              at(v, nt.error);
              bad = true;
            } else add(({ placement: p }) => !!p?.y && nt.test(p.y.min, p.y.max));
            break;
          }
          default: {
            const defs = fieldDefs.get(key);
            if (defs) {
              const tests = new Map<EntityKind, (raw: unknown) => boolean>();
              let firstErr: string | null = null;
              for (const [k, def] of defs) {
                const r = fieldTest(def, v, term.op, world);
                if (typeof r === 'string') firstErr ??= r;
                else tests.set(k, r);
              }
              if (tests.size === 0) {
                at(v, firstErr ?? `${key}: invalid value`);
                bad = true;
              } else add(({ entity: e }) => tests.get(e.kind)?.(e.fields[key]) ?? false);
            } else if (attrKeys.has(key)) {
              const nt = numericTest(term.op, v);
              if ('error' in nt) {
                at(v, nt.error);
                bad = true;
              } else
                add(({ entity: e }) => {
                  const x = e.attributes[key];
                  return x !== undefined && nt.test(x, x);
                });
            } else if (relTypes.has(key)) {
              if (term.op) {
                at(keySpan, `${key}: can't compare with ${term.op}`);
                bad = true;
                break;
              }
              add(({ entity: e }) =>
                e.relations.some((r) => {
                  if (r.type !== key) return false;
                  const target = world.entities[r.target];
                  return r.target === l || (!!target && lower(target.name) === l);
                }),
              );
            } else {
              if (!bad) at(keySpan, `unknown filter "${key}"${suggest(key, allKeys)}`);
              bad = true;
            }
          }
        }
      }
    }
    if (bad || alts.length === 0) continue;
    const any: Matcher = (row) => alts.some((m) => m(row));
    matchers.push(term.negate ? (row) => !any(row) : any);
  }
  return {
    match: (row) => matchers.every((m) => m(row)),
    errors: errors.sort((a, b) => a.from - b.from || a.to - b.to),
    kinds: kinds ? [...kinds] : null,
    empty: parsed.terms.length === 0,
  };
}

/** `items`, `item`, `Items` → `item`; lanes and kind labels both work. */
function kindFrom(word: string, schema: ReturnType<typeof schemaOf>): EntityKind | null {
  for (const k of ENTITY_KINDS) {
    const def = schema.kinds[k];
    if (
      word === k ||
      word === lower(def.label) ||
      word === lower(def.plural) ||
      LANE_OF_KIND[k] === word
    )
      return k;
  }
  return null;
}
