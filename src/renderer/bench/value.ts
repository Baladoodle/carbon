import { fieldValueSchema, isEmptyValue, type FieldDef } from '@core/model/fields';
import { fieldValue } from '@core/model/lifecycle';
import type { Entity } from '@core/model/entity';
import type { KindDef } from '@core/model/schema';

/**
 * Field values ⇄ the text you type on the Bench, per field type, pure. Every
 * value the Bench commits (yours or an accepted AI proposal) goes through
 * `parseText` or `checkValue`, so it's valid for its field before the command
 * sees it.
 */

/** The common text fields, described like kind fields so one form renders both. */
export const COMMON_DEFS: Record<'name' | 'identity' | 'description' | 'why' | 'tags', FieldDef> = {
  name: { key: 'name', label: 'Name', type: 'text' },
  identity: { key: 'identity', label: 'Identity', type: 'text', help: 'The one-line fantasy' },
  description: { key: 'description', label: 'Description', type: 'longtext' },
  why: { key: 'why', label: 'Why', type: 'longtext', help: 'Required to mark it decided' },
  tags: { key: 'tags', label: 'Tags', type: 'list' },
};

/** The definition of a common or kind field by key. */
export function defOf(kind: KindDef, key: string): FieldDef | undefined {
  return (COMMON_DEFS as Record<string, FieldDef>)[key] ?? kind.fields.find((f) => f.key === key);
}

export type Parsed = { ok: true; value: unknown } | { ok: false; error: string };

const INF_UP = new Set(['+inf', 'inf', '∞', '+∞', 'infinity', '+infinity']);
const INF_DOWN = new Set(['-inf', '−inf', '-∞', '−∞', '-infinity', '−infinity']);

/** Parses a number typed by hand: allows the typographic minus and spaces. */
export function parseNumber(text: string): number | null {
  const t = text.trim().replace(/−/g, '-').replace(/\s+/g, '').replace(/,/g, '');
  if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const fmtNum = (n: number): string => (n < 0 ? `−${String(-n)}` : String(n));

/** The text shown for a value in an input. */
export function formatValue(def: FieldDef, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (def.type) {
    case 'text':
    case 'longtext':
    case 'enum':
    case 'ref':
      return typeof value === 'string' ? value : '';
    case 'number':
      return typeof value === 'number' ? fmtNum(value) : '';
    case 'height':
      return value === '+inf'
        ? '+∞'
        : value === '-inf'
          ? '−∞'
          : typeof value === 'number'
            ? fmtNum(value)
            : '';
    case 'list':
      return Array.isArray(value) ? value.filter((v) => typeof v === 'string').join(', ') : '';
    case 'range': {
      const r = value as { min?: unknown; max?: unknown };
      return typeof r.min === 'number' && typeof r.max === 'number'
        ? `${fmtNum(r.min)} … ${fmtNum(r.max)}`
        : '';
    }
    case 'climate': {
      const c = value as {
        temperature?: { min: number; max: number };
        moisture?: { min: number; max: number };
      };
      return c.temperature && c.moisture
        ? `temperature ${c.temperature.min}–${c.temperature.max}, moisture ${c.moisture.min}–${c.moisture.max}`
        : '';
    }
    case 'steps':
      return Array.isArray(value)
        ? (value as { text?: unknown }[])
            .map((s, i) => `${i + 1}. ${typeof s.text === 'string' ? s.text : ''}`)
            .join('  ')
        : '';
    case 'boolean':
      return value === true ? 'yes' : value === false ? 'no' : '';
  }
}

/** Checks a value against its field (the same rules the commands use). Empty means "clear". */
export function checkValue(def: FieldDef, value: unknown): Parsed {
  if (isEmptyValue(value)) {
    if (def.key === 'name') return { ok: false, error: 'An entity needs a name' };
    return { ok: true, value: null };
  }
  if (def.key === 'tags' || (def.type === 'list' && def.key in COMMON_DEFS)) {
    return Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? { ok: true, value }
      : { ok: false, error: 'A list of words' };
  }
  const r = fieldValueSchema(def).safeParse(value);
  if (r.success) return { ok: true, value: r.data };
  const issue = r.error.issues[0];
  if (issue?.code === 'too_small' && 'minimum' in issue)
    return { ok: false, error: `At least ${String(issue.minimum)}` };
  if (issue?.code === 'too_big' && 'maximum' in issue)
    return { ok: false, error: `At most ${String(issue.maximum)}` };
  if (def.type === 'enum') return { ok: false, error: `One of ${(def.options ?? []).join(', ')}` };
  return { ok: false, error: issue?.message ?? 'Not a valid value' };
}

/** Parses typed text into a value for a one-line field (text, longtext, number, height, list). */
export function parseText(def: FieldDef, text: string): Parsed {
  const t = text.trim();
  switch (def.type) {
    case 'text':
    case 'longtext':
      // Keep inner whitespace of long text; trim the ends.
      return checkValue(def, def.type === 'longtext' ? text.replace(/^\s+|\s+$/g, '') : t);
    case 'number': {
      if (t === '') return checkValue(def, null);
      const n = parseNumber(t);
      return n === null ? { ok: false, error: 'A number' } : checkValue(def, n);
    }
    case 'height': {
      if (t === '') return checkValue(def, null);
      const low = t.toLowerCase();
      if (INF_UP.has(low)) return checkValue(def, '+inf');
      if (INF_DOWN.has(low)) return checkValue(def, '-inf');
      const n = parseNumber(t);
      return n === null ? { ok: false, error: 'A height, or ±∞' } : checkValue(def, n);
    }
    case 'list':
      return checkValue(
        def,
        t
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x !== ''),
      );
    case 'enum':
    case 'ref':
      return checkValue(def, t);
    case 'range':
    case 'climate':
    case 'steps':
    case 'boolean':
      return { ok: false, error: 'Not typed as text' };
  }
}

/** Whether a field is empty on an entity (for fill and for "missing"). */
export const isEmptyField = (e: Entity, key: string): boolean => isEmptyValue(fieldValue(e, key));

/** Whether a field's editor is a single text input (so a suggestion can be shown inline). */
export const isTextual = (def: FieldDef): boolean =>
  def.type === 'text' ||
  def.type === 'longtext' ||
  def.type === 'number' ||
  def.type === 'height' ||
  def.type === 'list';

/** The attribute definitions that apply to an entity (their `when` conditions hold). */
export function attributesFor(kind: KindDef, e: Entity): KindDef['attributes'] {
  return kind.attributes.filter(
    (a) => !a.when || Object.entries(a.when).every(([k, v]) => e.fields[k] === v),
  );
}
