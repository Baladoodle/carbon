import { printNumber, printString } from './printer';

/**
 * Runtime values: numbers, booleans, strings, entity references and lists.
 * An entity reference with `id: null` is "no entity" (an unplaced entity's
 * band): it equals only itself, and reading a property from it is an error.
 */
export interface EntityRef {
  $: 'entity';
  id: string | null;
}
export interface ListValue {
  $: 'list';
  items: Value[];
}
export type Value = number | boolean | string | EntityRef | ListValue;

export const entityRef = (id: string | null): EntityRef => ({ $: 'entity', id });
export const listValue = (items: Value[]): ListValue => ({ $: 'list', items });

export const isEntity = (v: Value): v is EntityRef => typeof v === 'object' && v.$ === 'entity';
export const isList = (v: Value): v is ListValue => typeof v === 'object' && v.$ === 'list';

/** Structural equality (numbers by value, so 0 === -0). */
export function valueEquals(a: Value, b: Value): boolean {
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (a.$ === 'entity') return b.$ === 'entity' && a.id === b.id;
  if (b.$ !== 'list') return false;
  return (
    a.items.length === b.items.length &&
    a.items.every((x, i) => valueEquals(x, b.items[i] as Value))
  );
}

/** Rounds away float noise for display: 0.30000000000000004 → 0.3. */
export function formatNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return '∞';
  if (n === -Infinity) return '−∞';
  const s = printNumber(Number.isInteger(n) ? n : Number(n.toPrecision(6)));
  return s.startsWith('-') ? `−${s.slice(1)}` : s;
}

export interface FormatOptions {
  /** Entity names by id, to show names instead of ids. */
  name?: (id: string) => string | undefined;
  /** Lists longer than this are cut with "…". */
  maxItems?: number;
}

export function formatValue(v: Value, opts: FormatOptions = {}): string {
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return printString(v);
  if (v.$ === 'entity') return v.id === null ? 'none' : (opts.name?.(v.id) ?? v.id);
  const max = opts.maxItems ?? 6;
  const shown = v.items.slice(0, max).map((x) => formatValue(x, opts));
  if (v.items.length > max) shown.push(`… ${v.items.length - max} more`);
  return `[${shown.join(', ')}]`;
}

/** A JSON-safe form (for IPC, AI prompts and exports). */
export type PlainValue =
  number | boolean | string | null | { entity: string | null } | PlainValue[];

export function toPlain(v: Value): PlainValue {
  if (typeof v !== 'object') return Number.isFinite(v) || typeof v !== 'number' ? v : String(v);
  if (v.$ === 'entity') return { entity: v.id };
  return v.items.map(toPlain);
}
