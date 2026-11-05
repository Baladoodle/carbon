import type { EntityKind } from '@core/model/kinds';
import type { World } from '@core/model/world';

/**
 * The renderer's reading of the image part of the world (docs/IMAGES.md §3, §5).
 * One adapter: every image UI reads images through these, so the shapes live
 * in one place.
 */

export type ImageKind = 'concept' | 'icon';

export interface ImageMeta {
  id: string;
  entity: string;
  kind: ImageKind;
  origin:
    | {
        by: 'openai';
        model: string;
        quality: string;
        size: string;
        prompt: string;
        requestId?: string;
      }
    | { by: 'filter'; from: string; preset: string; settings?: unknown };
  usage?: { inputTokens?: number; outputTokens?: number; images: number };
  costUsd?: number;
  created: string;
  hashes: { output: string; source?: string };
}

export interface EntityImages {
  concept?: string;
  icon?: string;
  all: ImageMeta[];
}

export interface ArtDirection {
  direction: string;
  kinds: Partial<Record<EntityKind, string>>;
}

const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined =>
  o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

const imagesTable = (w: World): Record<string, EntityImages> | undefined =>
  (w as { images?: Record<string, EntityImages> }).images;

/** An entity's images, or undefined when it has none. */
export const imagesOf = (w: World, id: string): EntityImages | undefined =>
  own(imagesTable(w), id);

/** The selected image of a kind (its metadata), if any. */
export function selected(w: World, id: string, kind: ImageKind): ImageMeta | undefined {
  const im = imagesOf(w, id);
  const sel = im?.[kind];
  return sel ? im.all.find((m) => m.id === sel) : undefined;
}

/** Every image of an entity of a kind, newest first. */
export const versions = (w: World, id: string, kind: ImageKind): ImageMeta[] =>
  (imagesOf(w, id)?.all ?? [])
    .filter((m) => m.kind === kind)
    .sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));

/** Which kinds take icons: items, and any kind the schema marks `icon: true`. */
export function takesIcon(w: World, kind: EntityKind): boolean {
  if (kind === 'item') return true;
  const def = (w.schema.kinds as Record<string, { icon?: boolean } | undefined>)[kind];
  return def?.icon === true;
}

/** `settings.art`, with defaults. */
export function artOf(w: World): ArtDirection {
  const raw = (w.settings as { art?: unknown }).art;
  const a = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const kinds =
    a.kinds && typeof a.kinds === 'object' ? (a.kinds as ArtDirection['kinds']) : {};
  return { direction: typeof a.direction === 'string' ? a.direction : '', kinds };
}
