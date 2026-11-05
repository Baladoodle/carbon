import {
  EMPTY_ART,
  type ArtDirection,
  type EntityImages,
  type ImageKind,
  type ImageMeta,
} from '@core/images/model';
import type { EntityKind } from '@core/model/kinds';
import type { World } from '@core/model/world';

/**
 * The renderer's reading of the image part of the world (docs/IMAGES.md §3,
 * §5; the shapes are core's, src/core/images/model.ts). Every image UI reads
 * images through these.
 */

export type { ArtDirection, EntityImages, ImageKind, ImageMeta };

/** An entity's images, or undefined when it has none. */
export const imagesOf = (w: World, id: string): EntityImages | undefined =>
  w.images && Object.prototype.hasOwnProperty.call(w.images, id) ? w.images[id] : undefined;

/** The selected image of a kind (its metadata), if any. */
export function selected(w: World, id: string, kind: ImageKind): ImageMeta | undefined {
  const im = imagesOf(w, id);
  const sel = im?.[kind];
  return sel ? im.all.find((m) => m.id === sel) : undefined;
}

/** Every image of an entity of a kind, newest first (ids are ULIDs: they sort by time). */
export const versions = (w: World, id: string, kind: ImageKind): ImageMeta[] =>
  (imagesOf(w, id)?.all ?? [])
    .filter((m) => m.kind === kind)
    .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

/** Which kinds take icons: items, and any kind the schema marks `icon: true`. */
export function takesIcon(w: World, kind: EntityKind): boolean {
  if (kind === 'item') return true;
  const def = (w.schema.kinds as Record<string, { icon?: boolean } | undefined>)[kind];
  return def?.icon === true;
}

/** `settings.art`, with defaults. */
export const artOf = (w: World): ArtDirection => w.settings.art ?? EMPTY_ART;

/** Whether an image came from a paid (or fake-paid) call, rather than a free filter. */
export const generated = (m: ImageMeta): boolean => m.origin.by !== 'filter';
