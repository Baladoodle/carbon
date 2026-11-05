import { ImageMetaSchema, imagePaths, SelectionFileSchema, selectionPath } from './model';
import type { EntityImages, ImageMeta, WorldImages } from './model';

/**
 * `world.images` ⇄ text files (pure). Each image's metadata is
 * `images/<entity>/<id>.json`, and an entity's choices are
 * `images/<entity>/selected.json` (present only when something is chosen).
 * The PNGs beside them are binary and handled by main; they are never part
 * of the world's text files.
 */

/** An image's metadata file, or an entity's selection file. */
export const IMAGE_FILE = /^images\/([^/]+)\/([^/]+)\.json$/;

export interface ImageLoadIssue {
  path: string;
  code: string;
  message: string;
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** Metadata in a fixed key order, for small git diffs. */
function metaJson(m: ImageMeta): string {
  return json(ImageMetaSchema.parse(m));
}

/** The text files of one entity's images. */
export function entityImageFiles(entity: string, e: EntityImages): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of e.all) out.set(imagePaths(entity, m.id).json, metaJson(m));
  if (e.concept || e.icon)
    out.set(
      selectionPath(entity),
      json({ ...(e.concept ? { concept: e.concept } : {}), ...(e.icon ? { icon: e.icon } : {}) }),
    );
  return out;
}

export function imageFilesOf(images: WorldImages | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const [entity, e] of Object.entries(images ?? {}))
    for (const [p, c] of entityImageFiles(entity, e)) out.set(p, c);
  return out;
}

const parse = (text: string, path: string, issues: ImageLoadIssue[]): unknown => {
  try {
    return JSON.parse(text);
  } catch (e) {
    issues.push({
      path,
      code: 'file.json',
      message: e instanceof Error ? e.message : 'invalid JSON',
    });
    return undefined;
  }
};

const zodMessage = (issues: readonly { path: PropertyKey[]; message: string }[]): string =>
  issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');

/**
 * Builds the images of the given entities from their files. Invalid files are
 * reported with the store's quarantine codes and left out; a selection that
 * names a missing image (or one of the other kind) is reported and ignored.
 * The result is canonical: sorted, no empty entries, `undefined` when empty.
 */
export function imagesFromFiles(files: Iterable<[string, string]>): {
  images: WorldImages | undefined;
  issues: ImageLoadIssue[];
} {
  const issues: ImageLoadIssue[] = [];
  const metas = new Map<string, ImageMeta[]>();
  const selections = new Map<string, { path: string; concept?: string; icon?: string }>();
  for (const [path, text] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const m = IMAGE_FILE.exec(path);
    if (!m) continue;
    const entity = m[1] as string;
    const name = m[2] as string;
    const raw = parse(text, path, issues);
    if (raw === undefined) continue;
    if (name === 'selected') {
      const r = SelectionFileSchema.safeParse(raw);
      if (!r.success) {
        issues.push({ path, code: 'file.invalid', message: zodMessage(r.error.issues) });
        continue;
      }
      selections.set(entity, { path, ...r.data });
      continue;
    }
    const r = ImageMetaSchema.safeParse(raw);
    if (!r.success) {
      issues.push({ path, code: 'file.invalid', message: zodMessage(r.error.issues) });
      continue;
    }
    if (r.data.id !== name || r.data.entity !== entity) {
      issues.push({
        path,
        code: 'file.location',
        message: `image "${r.data.id}" of "${r.data.entity}" must live at ${imagePaths(r.data.entity, r.data.id).json}`,
      });
      continue;
    }
    const list = metas.get(entity) ?? [];
    list.push(r.data);
    metas.set(entity, list);
  }
  const images: WorldImages = {};
  for (const entity of [...new Set([...metas.keys(), ...selections.keys()])].sort()) {
    const all = (metas.get(entity) ?? []).sort((a, b) => (a.id < b.id ? -1 : 1));
    const sel = selections.get(entity);
    const e: EntityImages = { all };
    for (const kind of ['concept', 'icon'] as const) {
      const id = sel?.[kind];
      if (id === undefined) continue;
      const found = all.find((x) => x.id === id);
      if (found?.kind === kind) e[kind] = id;
      else
        issues.push({
          path: sel?.path ?? selectionPath(entity),
          code: 'image.selection',
          message: found
            ? `the ${kind} "${id}" is a ${found.kind}`
            : `the ${kind} "${id}" isn't one of its images (ignored)`,
        });
    }
    if (all.length === 0) continue;
    images[entity] = e;
  }
  return { images: Object.keys(images).length > 0 ? images : undefined, issues };
}

/** The image text files a change to `images` touches (written or removed), comparing before and after. */
export function imageFilesForChange(
  before: WorldImages | undefined,
  after: WorldImages | undefined,
  entity: string | undefined,
): { write: Map<string, string>; remove: Set<string> } {
  const write = new Map<string, string>();
  const remove = new Set<string>();
  const entities =
    entity === undefined
      ? [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
      : [entity];
  for (const id of entities) {
    const was = before?.[id] ? entityImageFiles(id, before[id]) : new Map<string, string>();
    const now = after?.[id] ? entityImageFiles(id, after[id]) : new Map<string, string>();
    for (const p of was.keys()) if (!now.has(p)) remove.add(p);
    for (const [p, c] of now) if (was.get(p) !== c) write.set(p, c);
  }
  return { write, remove };
}
