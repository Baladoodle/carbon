import { z } from 'zod';
import { defineCommand } from '../commands/define';
import type { Patch } from '../commands/patch';
import { EntityIdSchema } from '../model/ids';
import { EntityKindSchema } from '../model/kinds';
import type { World } from '../model/world';
import { err, ok, type Result } from '../util/result';
import {
  ArtDirectionSchema,
  EMPTY_ART,
  ImageIdSchema,
  ImageKindSchema,
  ImageMetaSchema,
  type EntityImages,
  type ImageMeta,
} from './model';

/**
 * The image commands (docs/IMAGES.md §3). Every one keeps `world.images` in
 * its canonical form (see `imagesProblems`): sorted versions, selections that
 * point at an image of the right kind, and no empty entries.
 *
 * Removing or unselecting never touches the pixels: main keeps the files
 * until the explicit "Delete image files" action.
 */

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** The patch that turns entity `entity`'s images into `next` (or removes them). Exact, so the inverse is too. */
function patchEntityImages(world: World, entity: string, next: EntityImages | undefined): Patch {
  const images = world.images;
  if (!next || (next.all.length === 0 && !next.concept && !next.icon)) {
    if (!images || !has(images, entity)) return [];
    // The last entity's images: drop the section, so the world stays canonical.
    return Object.keys(images).length === 1
      ? [{ op: 'remove', path: ['images'] }]
      : [{ op: 'remove', path: ['images', entity] }];
  }
  const value: EntityImages = {
    ...(next.concept ? { concept: next.concept } : {}),
    ...(next.icon ? { icon: next.icon } : {}),
    all: [...next.all].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  if (!images) return [{ op: 'set', path: ['images'], value: { [entity]: value } }];
  return [{ op: 'set', path: ['images', entity], value }];
}

const imagesOf = (world: World, entity: string): EntityImages | undefined =>
  world.images && has(world.images, entity) ? world.images[entity] : undefined;

function findImage(world: World, entity: string, image: string): Result<ImageMeta> {
  const meta = imagesOf(world, entity)?.all.find((m) => m.id === image);
  return meta ? ok(meta) : err('image.not_found', `no image "${image}" for "${entity}"`);
}

/** Adds an image main has written to disk; selects it unless `select: false`. */
export const addImage = defineCommand({
  payload: z.object({ image: ImageMetaSchema, select: z.boolean().default(true) }),
  label: (p) =>
    p.image.kind === 'icon'
      ? 'Add icon'
      : p.image.kind === 'sheet'
        ? 'Add icon sheet'
        : 'Add concept image',
  plan(world, p) {
    const m = p.image;
    if (!has(world.entities, m.entity))
      return err('entity.not_found', `no entity "${m.entity}" for the image`);
    const cur = imagesOf(world, m.entity) ?? { all: [] };
    if (cur.all.some((x) => x.id === m.id))
      return err('image.exists', `image "${m.id}" is already in the world`);
    if (m.origin.by === 'filter') {
      const fromId = m.origin.from;
      if (!cur.all.some((x) => x.id === fromId))
        return err('image.not_found', `the image it was filtered from ("${fromId}") isn't there`);
    }
    if (m.origin.by === 'sheet') {
      const sheetId = m.origin.sheet;
      const sheet = Object.values(world.images ?? {})
        .flatMap((e) => e.all)
        .find((x) => x.id === sheetId);
      if (sheet?.kind !== 'sheet')
        return err('image.not_found', `the sheet it was cropped from ("${sheetId}") isn't there`);
    }
    if ((m.kind === 'sheet') !== (m.sheet !== undefined))
      return err('image.sheet', 'a sheet carries its grid, and only a sheet does');
    const next: EntityImages = { ...cur, all: [...cur.all, m] };
    if (p.select && m.kind !== 'sheet') next[m.kind] = m.id;
    return ok(patchEntityImages(world, m.entity, next));
  },
});

export const selectImage = defineCommand({
  payload: z.object({ entity: EntityIdSchema, image: ImageIdSchema }),
  label: (p, w) =>
    imagesOf(w, p.entity)?.all.find((m) => m.id === p.image)?.kind === 'icon'
      ? 'Choose icon'
      : 'Choose concept image',
  plan(world, p) {
    const f = findImage(world, p.entity, p.image);
    if (!f.ok) return f;
    const kind = f.value.kind;
    if (kind === 'sheet')
      return err('image.sheet', 'a sheet is not chosen; its cells become icons');
    const cur = imagesOf(world, p.entity) as EntityImages;
    if (cur[kind] === p.image) return ok([]);
    return ok(patchEntityImages(world, p.entity, { ...cur, [kind]: p.image }));
  },
});

export const unselectImage = defineCommand({
  payload: z.object({ entity: EntityIdSchema, kind: ImageKindSchema }),
  label: (p) => (p.kind === 'icon' ? 'Clear icon' : 'Clear concept image'),
  plan(world, p) {
    const cur = imagesOf(world, p.entity);
    if (!cur?.[p.kind]) return ok([]);
    const next: EntityImages = { ...cur };
    delete next[p.kind];
    return ok(patchEntityImages(world, p.entity, next));
  },
});

/** Removes an image from the world (and its selection). Its files stay until "Delete image files". */
export const removeImage = defineCommand({
  payload: z.object({ entity: EntityIdSchema, image: ImageIdSchema }),
  label: (p, w) =>
    imagesOf(w, p.entity)?.all.find((m) => m.id === p.image)?.kind === 'icon'
      ? 'Remove icon'
      : 'Remove concept image',
  plan(world, p) {
    const f = findImage(world, p.entity, p.image);
    if (!f.ok) return f;
    const cur = imagesOf(world, p.entity) as EntityImages;
    // An icon filtered from it keeps `origin.from` as provenance: removal is still allowed.
    const next: EntityImages = { ...cur, all: cur.all.filter((m) => m.id !== p.image) };
    if (next.concept === p.image) delete next.concept;
    if (next.icon === p.image) delete next.icon;
    return ok(patchEntityImages(world, p.entity, next));
  },
});

/** Sets the art direction and per-kind notes (`settings.art`). `null` or '' clears a kind's note. */
export const setArt = defineCommand({
  payload: z.object({
    direction: z.string().max(4000).optional(),
    kinds: z.partialRecord(EntityKindSchema, z.string().max(2000).nullable()).optional(),
  }),
  label: () => 'Change art direction',
  plan(world, p) {
    const cur = ArtDirectionSchema.parse(world.settings.art ?? EMPTY_ART);
    const kinds = { ...cur.kinds };
    for (const [k, v] of Object.entries(p.kinds ?? {})) {
      const key = k as keyof typeof kinds;
      if (v === null || v.trim() === '') delete kinds[key];
      else kinds[key] = v;
    }
    const direction = p.direction ?? cur.direction;
    if (direction === '' && Object.keys(kinds).length === 0)
      return ok(has(world.settings, 'art') ? [{ op: 'remove', path: ['settings', 'art'] }] : []);
    return ok([{ op: 'set', path: ['settings', 'art'], value: { direction, kinds } }]);
  },
});

export const imageCommands = {
  'image.add': addImage,
  'image.select': selectImage,
  'image.unselect': unselectImage,
  'image.remove': removeImage,
  'art.set': setArt,
} as const;

/**
 * Everything that makes `world.images` non-canonical or inconsistent. Empty
 * for every world the commands produce (a property test proves it). Images of
 * entities that no longer exist are allowed (undoing the delete brings them
 * back).
 */
export function imagesProblems(images: World['images']): string[] {
  if (images === undefined) return [];
  const out: string[] = [];
  const keys = Object.keys(images);
  if (keys.length === 0) out.push('images: an empty section (it should be absent)');
  for (const entity of keys) {
    const e = images[entity] as EntityImages;
    if (e.all.length === 0) out.push(`images.${entity}: no images (the entry should be absent)`);
    const ids = new Set<string>();
    let prev = '';
    for (const m of e.all) {
      if (m.entity !== entity) out.push(`images.${entity}: image ${m.id} belongs to ${m.entity}`);
      if (ids.has(m.id)) out.push(`images.${entity}: image ${m.id} twice`);
      if (m.id <= prev) out.push(`images.${entity}: not sorted by id`);
      ids.add(m.id);
      prev = m.id;
    }
    for (const kind of ['concept', 'icon'] as const) {
      const sel = e[kind];
      if (sel === undefined) continue;
      const m = e.all.find((x) => x.id === sel);
      if (!m) out.push(`images.${entity}.${kind}: ${sel} is not one of its images`);
      else if (m.kind !== kind) out.push(`images.${entity}.${kind}: ${sel} is a ${m.kind}`);
    }
  }
  return out;
}
