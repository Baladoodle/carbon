import { z } from 'zod';

/** A stable slug: lowercase letters, digits and single hyphens. Unique across all kinds. */
export const EntityIdSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'an id is a lowercase slug, e.g. "glass-lung"');
export type EntityId = z.infer<typeof EntityIdSchema>;

/** An ISO 8601 timestamp in UTC, as produced by `new Date().toISOString()`. */
export const TimestampSchema = z.iso.datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Turns a name into a slug ("Glass Lung!" → "glass-lung"). Never empty. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug === '' ? 'untitled' : slug;
}

/** The slug of `name`, made unique against `taken` with a numeric suffix. Deterministic. */
export function uniqueId(name: string, taken: (id: string) => boolean): EntityId {
  const base = slugify(name);
  if (!taken(base)) return base;
  for (let n = 2; ; n++) {
    const id = `${base}-${n}`;
    if (!taken(id)) return id;
  }
}
