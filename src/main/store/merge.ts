import { entityFromMarkdown, entityToMarkdown } from '@core/files/entity-file';
import type { Entity } from '@core/model/entity';
import { stableStringify } from '@core/util/json';

/**
 * Three-way merge of one file, for external edits that land while carbon's own
 * edit of the same file is still unsaved to the outside (see disk-state.ts).
 *
 * - `base`: the file before carbon's recent writes (the common ancestor)
 * - `ours`: carbon's version
 * - `theirs`: what's on disk now (an editor, Claude Code, a git checkout)
 *
 * Entity files merge field by field: a field only one side changed takes that
 * side's value; a field both sides changed to different values is a conflict,
 * which the user settles (carbon's value or the file's). Other files merge
 * whole: if both changed them differently, the whole file is a conflict.
 * `null` content means the file doesn't exist on that side.
 */
export interface FieldConflict {
  /** `name`, `why`, `fields.change`, `attributes.defense`, `relations`, or `(file)`. */
  key: string;
  ours: unknown;
  theirs: unknown;
}

export type MergeResult =
  | { kind: 'take'; content: string | null }
  | {
      kind: 'merged';
      /** The merge with carbon's values on conflicting keys (and theirs elsewhere). */
      ifOurs: string | null;
      /** The merge with the file's values on conflicting keys. */
      ifTheirs: string | null;
      conflicts: FieldConflict[];
    };

const same = (a: unknown, b: unknown): boolean => stableStringify(a) === stableStringify(b);

/** Keys merged one by one; `updated` is never a conflict (the later time wins). */
const SCALAR_KEYS = [
  'kind',
  'name',
  'identity',
  'description',
  'state',
  'why',
  'tags',
  'relations',
  'origin',
  'ai_fields',
  'killed',
  'created',
] as const;

type Flat = Map<string, unknown>;

function flatten(e: Entity): Flat {
  const m: Flat = new Map();
  for (const k of SCALAR_KEYS) m.set(k, e[k]);
  for (const [k, v] of Object.entries(e.fields)) m.set(`fields.${k}`, v);
  for (const [k, v] of Object.entries(e.attributes)) m.set(`attributes.${k}`, v);
  return m;
}

function unflatten(m: Flat, id: string, updated: string): Entity {
  const e: Record<string, unknown> = { id, fields: {}, attributes: {}, updated };
  const fields: Record<string, unknown> = {};
  const attributes: Record<string, unknown> = {};
  for (const [k, v] of m) {
    if (v === undefined) continue;
    if (k.startsWith('fields.')) fields[k.slice(7)] = v;
    else if (k.startsWith('attributes.')) attributes[k.slice(11)] = v;
    else e[k] = v;
  }
  e.fields = fields;
  e.attributes = attributes;
  return e as unknown as Entity;
}

const parse = (text: string | null): Entity | null | 'invalid' => {
  if (text === null) return null;
  const r = entityFromMarkdown(text);
  return r.ok ? r.value : 'invalid';
};

/** Merges one file. `isEntity` selects field-level merging. */
export function mergeFile(
  base: string | null,
  ours: string | null,
  theirs: string | null,
  isEntity: boolean,
): MergeResult {
  if (theirs === ours) return { kind: 'take', content: theirs };
  if (ours === base) return { kind: 'take', content: theirs };
  if (theirs === base) return { kind: 'take', content: ours };
  const whole: MergeResult = {
    kind: 'merged',
    ifOurs: ours,
    ifTheirs: theirs,
    conflicts: [{ key: '(file)', ours, theirs }],
  };
  if (!isEntity) return whole;
  const b = parse(base);
  const o = parse(ours);
  const t = parse(theirs);
  if (
    o === null ||
    t === null ||
    o === 'invalid' ||
    t === 'invalid' ||
    b === 'invalid' ||
    o.id !== t.id
  )
    return whole;
  const fb = b ? flatten(b) : new Map<string, unknown>();
  const fo = flatten(o);
  const ft = flatten(t);
  const keys = [...new Set([...fb.keys(), ...fo.keys(), ...ft.keys()])].sort();
  const mergedOurs: Flat = new Map();
  const mergedTheirs: Flat = new Map();
  const conflicts: FieldConflict[] = [];
  for (const k of keys) {
    const vb = fb.get(k);
    const vo = fo.get(k);
    const vt = ft.get(k);
    let pick: unknown;
    if (same(vo, vt) || same(vt, vb)) pick = vo;
    else if (same(vo, vb)) pick = vt;
    else {
      conflicts.push({ key: k, ours: vo, theirs: vt });
      mergedOurs.set(k, vo);
      mergedTheirs.set(k, vt);
      continue;
    }
    mergedOurs.set(k, pick);
    mergedTheirs.set(k, pick);
  }
  const updated = o.updated > t.updated ? o.updated : t.updated;
  const render = (m: Flat): string | null => {
    const e = unflatten(m, o.id, updated);
    const back = entityFromMarkdown(entityToMarkdown(e));
    return back.ok ? entityToMarkdown(back.value) : null;
  };
  const ifOurs = render(mergedOurs);
  const ifTheirs = render(mergedTheirs);
  if (ifOurs === null || ifTheirs === null) return whole;
  if (conflicts.length === 0) return { kind: 'take', content: ifOurs };
  return { kind: 'merged', ifOurs, ifTheirs, conflicts };
}
