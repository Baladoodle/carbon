import { z } from 'zod';
import { isPlainObject } from '../util/json';

/**
 * A patch is a list of operations on the world document. Paths are object keys
 * only: arrays are replaced as whole values, which keeps inverses exact and
 * makes patches easy to read. Every intermediate object on a path must exist.
 *
 * Patches cross IPC (the renderer applies the same ops to its mirror), so they
 * are plain JSON and validated with `PatchSchema`.
 */
export const PatchOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set'), path: z.array(z.string()).min(1), value: z.unknown() }),
  z.object({ op: z.literal('remove'), path: z.array(z.string()).min(1) }),
]);
export type PatchOp =
  { op: 'set'; path: string[]; value: unknown } | { op: 'remove'; path: string[] };
export const PatchSchema = z.array(PatchOpSchema);
export type Patch = PatchOp[];

export class PatchError extends Error {
  constructor(
    message: string,
    readonly path: string[],
  ) {
    super(message);
    this.name = 'PatchError';
  }
}

const has = (o: Record<string, unknown>, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/** Reads the value at a path, or `undefined` if any part is absent. */
export function getAt(doc: unknown, path: readonly string[]): unknown {
  let cur: unknown = doc;
  for (const k of path) {
    if (!isPlainObject(cur) || !has(cur, k)) return undefined;
    cur = cur[k];
  }
  return cur;
}

export const hasAt = (doc: unknown, path: readonly string[]): boolean => {
  const parent = getAt(doc, path.slice(0, -1));
  return isPlainObject(parent) && has(parent, path[path.length - 1] ?? '');
};

/**
 * Returns a copy of `doc` with one op applied, sharing every untouched branch.
 * `fresh` holds the containers this patch has already copied: those are
 * modified in place instead of copied again, so a patch of several ops copies
 * each container on its paths once (a three-op patch on one entity copies the
 * entities table once, not three times). Nothing outside `fresh` is mutated.
 */
function applyOne<T>(doc: T, op: PatchOp, fresh: WeakSet<object>): T {
  const rec = (node: unknown, i: number): unknown => {
    if (!isPlainObject(node))
      throw new PatchError(`not an object at ${op.path.slice(0, i).join('.')}`, op.path);
    const key = op.path[i] as string;
    let copy: Record<string, unknown>;
    if (fresh.has(node)) copy = node;
    else {
      copy = { ...node };
      fresh.add(copy);
    }
    if (i === op.path.length - 1) {
      if (op.op === 'set') copy[key] = op.value;
      else delete copy[key];
      return copy;
    }
    if (!has(node, key))
      throw new PatchError(`missing "${key}" at ${op.path.slice(0, i + 1).join('.')}`, op.path);
    copy[key] = rec(node[key], i + 1);
    return copy;
  };
  return rec(doc, 0) as T;
}

/** Applies ops in order. Throws `PatchError` on a malformed path. Never mutates `doc`. */
export function applyPatch<T>(doc: T, patch: Patch): T {
  const fresh = new WeakSet<object>();
  let cur = doc;
  for (const op of patch) cur = applyOne(cur, op, fresh);
  return cur;
}

/**
 * Applies ops and returns the inverse patch: applying the inverse to the result
 * gives back a document deep-equal to `doc`.
 */
export function applyWithInverse<T>(doc: T, patch: Patch): { doc: T; inverse: Patch } {
  const inverse: Patch = [];
  // A captured inverse value is never a container this patch mutates later:
  // capturing happens only at an op's own path, which that op then replaces
  // or removes, so the captured container is unreachable from then on.
  const fresh = new WeakSet<object>();
  let cur = doc;
  for (const op of patch) {
    const existed = hasAt(cur, op.path);
    if (op.op === 'remove' && !existed) continue; // removing nothing is a no-op
    inverse.push(
      existed
        ? { op: 'set', path: op.path, value: getAt(cur, op.path) }
        : { op: 'remove', path: op.path },
    );
    cur = applyOne(cur, op, fresh);
  }
  inverse.reverse();
  return { doc: cur, inverse };
}

/** The top-level-ish locations a patch touches, e.g. `entities/glass-lung`, `numbers`. */
export function touchedKeys(patch: Patch, depth = 2): string[] {
  return [...new Set(patch.map((op) => op.path.slice(0, depth).join('/')))];
}

/** JSON-clone for values crossing a boundary (patch values are JSON). */
export const cloneJson = <T>(v: T): T =>
  v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
