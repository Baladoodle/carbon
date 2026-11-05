import { getEntity, type World } from '../model/world';
import { imagePaths } from './model';

/**
 * Images in an export (docs/IMAGES.md §6): the selected icon and concept of
 * each exported entity are copied into `exports/<spec>/images/`, and the spec
 * lists their paths, so Claude Code can move icons into Infinite's
 * `assets/items/`. Pure: main copies the files.
 */
export interface ExportImage {
  entity: string;
  kind: 'icon' | 'concept';
  /** World-relative source (`images/<entity>/<id>.png`). */
  from: string;
  /** World-relative destination (`exports/<spec>/images/<entity>.<kind>.png`). */
  to: string;
  width?: number;
  height?: number;
}

/** `exports/2026-11-05-first-set.md` → `exports/2026-11-05-first-set/images`. */
export const exportImagesDir = (specPath: string): string =>
  `${specPath.replace(/\.md$/, '')}/images`;

export function exportImages(
  world: World,
  ids: readonly string[],
  specPath: string,
): ExportImage[] {
  const dir = exportImagesDir(specPath);
  const out: ExportImage[] = [];
  for (const id of ids) {
    const imgs = world.images?.[id];
    if (!imgs || !getEntity(world, id)) continue;
    for (const kind of ['icon', 'concept'] as const) {
      const sel = imgs[kind];
      const meta = sel ? imgs.all.find((m) => m.id === sel) : undefined;
      if (!meta) continue;
      out.push({
        entity: id,
        kind,
        from: imagePaths(id, meta.id).png,
        to: `${dir}/${id}.${kind}.png`,
        ...(meta.width ? { width: meta.width } : {}),
        ...(meta.height ? { height: meta.height } : {}),
      });
    }
  }
  return out;
}

/** The spec's "Images" section: each entity's icon and concept paths. Empty when there are none. */
export function imagesSection(world: World, images: readonly ExportImage[]): string {
  if (images.length === 0) return '';
  const lines = [
    '## Images',
    '',
    'Copied beside this spec. Icons are 16×16 PNGs with hard transparency, for `assets/items/`.',
    '',
  ];
  for (const img of images) {
    const name = getEntity(world, img.entity)?.name ?? img.entity;
    const size = img.width && img.height ? ` (${img.width}×${img.height})` : '';
    lines.push(`- ${name}, ${img.kind}: \`${img.to}\`${size}`);
  }
  return `${lines.join('\n')}\n`;
}
