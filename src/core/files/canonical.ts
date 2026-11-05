import type { Patch, PatchOp } from '../commands/patch';

/**
 * The form of a value that the world's files give back exactly (the store's
 * central promise: whatever carbon holds in memory is what it reads back).
 * Commands' patches are put in this form before they apply, so the world in
 * memory never holds what a save and a reopen would quietly change:
 *
 * - **line ends**: the store reads text with LF line ends (a file saved on
 *   another OS loads like its LF twin), so CR LF and a lone CR become LF in
 *   every string
 * - **-0**: JSON writes it as `0` (variables, settings, curves, spreads), so
 *   it is `0` everywhere
 * - **a description** is the markdown body of its entity's file, which keeps
 *   no trailing whitespace, so it has none
 * - **the formula source** is a file of its own, read without a byte-order
 *   mark, so it starts without one
 *
 * Every rule is idempotent, and a value that needs none comes back as the
 * same object (no copy).
 */

const BOM = '﻿';

const text = (s: string): string => (s.includes('\r') ? s.replace(/\r\n?/g, '\n') : s);

/** Strings with LF line ends and numbers without -0, everywhere in a JSON value. */
export function canonicalValue(v: unknown): unknown {
  if (typeof v === 'string') return text(v);
  if (typeof v === 'number') return Object.is(v, -0) ? 0 : v;
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    for (let i = 0; i < v.length; i++) {
      const x: unknown = v[i];
      const y = canonicalValue(x);
      if (!Object.is(y, x)) (out ??= v.slice())[i] = y;
    }
    return out ?? v;
  }
  if (v && typeof v === 'object') {
    let out: Record<string, unknown> | null = null;
    for (const [k, x] of Object.entries(v)) {
      const y = canonicalValue(x);
      if (!Object.is(y, x)) (out ??= { ...(v as Record<string, unknown>) })[k] = y;
    }
    return out ?? v;
  }
  return v;
}

/** A description as its entity file's body keeps it. */
export const canonicalDescription = (s: string): string => text(s).replace(/\s+$/, '');

/** The formula source as its file keeps it. */
export const canonicalFormulas = (s: string): string => {
  const t = text(s);
  return t.startsWith(BOM) ? t.slice(BOM.length) : t;
};

/** Applies `fix` to `obj[key]` when it is a string, copying `obj` only if it changes. */
function fixKey<T>(obj: T, key: string, fix: (s: string) => string): T {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v !== 'string') return obj;
  const w = fix(v);
  return w === v ? obj : { ...obj, [key]: w };
}

function canonicalOp(op: PatchOp): PatchOp {
  if (op.op === 'remove') return op;
  let value = canonicalValue(op.value);
  const [root, a, b] = op.path;
  const depth = op.path.length;
  if (root === 'entities') {
    if (depth === 1 && value && typeof value === 'object') {
      let all: Record<string, unknown> | null = null;
      for (const [id, e] of Object.entries(value as Record<string, unknown>)) {
        const f = fixKey(e, 'description', canonicalDescription);
        if (f !== e) (all ??= { ...(value as Record<string, unknown>) })[id] = f;
      }
      value = all ?? value;
    } else if (depth === 2) value = fixKey(value, 'description', canonicalDescription);
    else if (depth === 3 && b === 'description' && typeof value === 'string')
      value = canonicalDescription(value);
  } else if (root === 'numbers') {
    if (depth === 1) value = fixKey(value, 'formulas', canonicalFormulas);
    else if (depth === 2 && a === 'formulas' && typeof value === 'string')
      value = canonicalFormulas(value);
  }
  return Object.is(value, op.value) ? op : { ...op, value };
}

/** The patch with every value in the form the files give back (the same ops if already so). */
export function canonicalPatch(patch: Patch): Patch {
  let out: Patch | null = null;
  for (let i = 0; i < patch.length; i++) {
    const op = patch[i] as PatchOp;
    const c = canonicalOp(op);
    if (c !== op) (out ??= patch.slice())[i] = c;
  }
  return out ?? patch;
}
