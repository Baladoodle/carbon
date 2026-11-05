import { z } from 'zod';
import { EntityIdSchema } from '../model/ids';
import { EntityKindSchema } from '../model/kinds';

/**
 * Images and icons (docs/IMAGES.md §3). Image metadata is part of `World`
 * (`world.images`), so choosing and removing images are ordinary undoable
 * commands. The pixels are files beside it, written by main
 * (`<world>/images/<entity>/<image-id>.png`, `.src.png`, `.json`).
 */

export const IMAGE_KINDS = ['concept', 'icon'] as const;
export const ImageKindSchema = z.enum(IMAGE_KINDS);
export type ImageKind = z.infer<typeof ImageKindSchema>;

/** The OpenAI image models carbon offers. The first is the default. */
export const IMAGE_MODELS = ['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst'] as const;
export const ImageModelSchema = z.enum(IMAGE_MODELS);
export type ImageModel = z.infer<typeof ImageModelSchema>;
export const DEFAULT_IMAGE_MODEL: ImageModel = 'gpt-image-2.6-flare';

/** Rendering quality. Low is the default for concept art and icons alike; medium and high are per call. */
export const IMAGE_QUALITIES = ['low', 'medium', 'high'] as const;
export const ImageQualitySchema = z.enum(IMAGE_QUALITIES);
export type ImageQuality = z.infer<typeof ImageQualitySchema>;
export const DEFAULT_IMAGE_QUALITY: ImageQuality = 'low';

/** Provider sizes. Concepts: 1024×1024 or 1536×1024 (landscape, for Climate panels). Icons are generated at 1024×1024 and filtered to 16×16. */
export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const;
export const ImageSizeSchema = z.enum(IMAGE_SIZES);
export type ImageSize = z.infer<typeof ImageSizeSchema>;
export const DEFAULT_SIZE: Record<ImageKind, ImageSize> = {
  concept: '1536x1024',
  icon: '1024x1024',
};
/** The icon's output size (Infinite's item icons). */
export const ICON_PX = 16;

/**
 * An image id: a ULID (26 characters of Crockford base32), so ids sort by
 * creation time and never collide with the folder's other files.
 */
export const ImageIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an image id is a ULID');
export type ImageId = z.infer<typeof ImageIdSchema>;

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

export const ImageOriginSchema = z.discriminatedUnion('by', [
  z.object({
    by: z.literal('openai'),
    model: z.string().min(1),
    quality: z.string().min(1),
    size: z.string().min(1),
    prompt: z.string(),
    requestId: z.string().optional(),
    /** For an edit with a reference: the image id used as the reference. */
    reference: ImageIdSchema.optional(),
  }),
  z.object({
    by: z.literal('filter'),
    /** The image this one was filtered from. */
    from: ImageIdSchema,
    preset: z.string().min(1),
    settings: z.unknown().optional(),
  }),
  z.object({
    // Added: a fake provider's image (CARBON_IMAGES=fake, tests). Never from a paid call.
    by: z.literal('fake'),
    prompt: z.string(),
    size: z.string().min(1),
  }),
]);
export type ImageOrigin = z.infer<typeof ImageOriginSchema>;

export const ImageUsageSchema = z.object({
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  images: z.number().int().min(0),
});
export type ImageUsage = z.infer<typeof ImageUsageSchema>;

export const ImageMetaSchema = z.object({
  id: ImageIdSchema,
  entity: EntityIdSchema,
  kind: ImageKindSchema,
  origin: ImageOriginSchema,
  usage: ImageUsageSchema.optional(),
  costUsd: z.number().min(0).optional(),
  created: z.iso.datetime(),
  /** Pixel dimensions of the `.png`. */
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  hashes: z.object({ output: Sha256Schema, source: Sha256Schema.optional() }),
});
export type ImageMeta = z.infer<typeof ImageMetaSchema>;

/** One entity's images: every version (sorted by id), and the chosen concept and icon. */
export const EntityImagesSchema = z.object({
  concept: ImageIdSchema.optional(),
  icon: ImageIdSchema.optional(),
  all: z.array(ImageMetaSchema),
});
export type EntityImages = z.infer<typeof EntityImagesSchema>;

/**
 * `world.images`. Absent when the world has no images, and an entity's entry
 * is absent when it has none, so the world has one canonical form (a save and
 * reload gives it back exactly). Images of a deleted entity are kept: undoing
 * the delete brings them back, and "Delete image files" purges them.
 */
export const WorldImagesSchema = z.record(EntityIdSchema, EntityImagesSchema);
export type WorldImages = z.infer<typeof WorldImagesSchema>;

/** `settings.art` (IMAGES.md §5): the world's art direction, edited in Taste. */
export const ArtDirectionSchema = z.object({
  direction: z.string().max(4000).default(''),
  /** Per-kind notes, e.g. `{ biome: "wide establishing shots" }`. */
  kinds: z.partialRecord(EntityKindSchema, z.string().max(2000)).default({}),
});
export type ArtDirection = z.infer<typeof ArtDirectionSchema>;
export const EMPTY_ART: ArtDirection = { direction: '', kinds: {} };

/** Kinds that get icons by default (the schema can mark others with `icon: true`). */
export const ICON_KINDS_DEFAULT = ['item'] as const;

/** The world-relative paths of an image's files. */
export const imagePaths = (entity: string, id: string) => ({
  png: `images/${entity}/${id}.png`,
  src: `images/${entity}/${id}.src.png`,
  json: `images/${entity}/${id}.json`,
});
/** One entity's selection file (`{ concept?, icon? }`). */
export const selectionPath = (entity: string): string => `images/${entity}/selected.json`;
export const SelectionFileSchema = z.object({
  concept: ImageIdSchema.optional(),
  icon: ImageIdSchema.optional(),
});
