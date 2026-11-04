/**
 * Built-in functions (docs/SYSTEM.md §6). Typing and evaluation live in
 * check.ts and evaluate.ts; this table is their shared description, used for
 * arity errors, hints and the editor.
 *
 * In the aggregates, the second argument is evaluated once per element, with
 * the element as `it`: `sum(items where subkind == "armor", .defense)`.
 */
export interface BuiltinInfo {
  name: string;
  min: number;
  max: number;
  /** How it's called, for hints and the editor. */
  usage: string;
  /** Whether argument 1 is evaluated per element of argument 0. */
  perElement?: boolean;
}

const b = (name: string, min: number, max: number, usage: string, perElement?: boolean): BuiltinInfo =>
  perElement ? { name, min, max, usage, perElement } : { name, min, max, usage };

export const BUILTINS: Record<string, BuiltinInfo> = {
  min: b('min', 1, Infinity, 'min(a, b, …) or min(list, .value)'),
  max: b('max', 1, Infinity, 'max(a, b, …) or max(list, .value)'),
  clamp: b('clamp', 3, 3, 'clamp(x, low, high)'),
  log: b('log', 1, 2, 'log(x) or log(x, base)'),
  exp: b('exp', 1, 1, 'exp(x)'),
  pow: b('pow', 2, 2, 'pow(base, exponent)'),
  sqrt: b('sqrt', 1, 1, 'sqrt(x)'),
  abs: b('abs', 1, 1, 'abs(x)'),
  floor: b('floor', 1, 1, 'floor(x)'),
  ceil: b('ceil', 1, 1, 'ceil(x)'),
  round: b('round', 1, 2, 'round(x) or round(x, digits)'),
  lerp: b('lerp', 3, 3, 'lerp(a, b, t)'),
  if: b('if', 3, 3, 'if(condition, then, else)'),
  sum: b('sum', 1, 2, 'sum(list) or sum(list, .value)', true),
  avg: b('avg', 1, 2, 'avg(list) or avg(list, .value)', true),
  count: b('count', 1, 2, 'count(list) or count(list, condition)', true),
  contains: b('contains', 2, 2, 'contains(list, value)'),
};

export const isBuiltin = (name: string): boolean => Object.prototype.hasOwnProperty.call(BUILTINS, name);

/** `it` is the current element inside `where` and the aggregates. */
export const RESERVED = new Set(['it']);
