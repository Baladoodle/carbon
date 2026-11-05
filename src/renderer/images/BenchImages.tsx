import type { ReactNode } from 'react';
import type { Entity } from '@core/model/entity';
import type { World } from '@core/model/world';
import { Button, ContextMenu, IconImage, Tooltip, cx, type MenuEntry } from '../ui';
import {
  chooseImage,
  iconFromConcept,
  KEYS,
  removeImage,
  requestImage,
  reviewSheet,
} from './actions';
import {
  selected,
  sheetOfIcon,
  takesIcon,
  versions,
  type ImageKind,
  type ImageMeta,
} from './model';
import { openImageOverlay, usePending } from './store';
import { describe, Shimmer, Thumb } from './Thumb';

/**
 * The Bench's image strip, under the title (docs/IMAGES.md §6): the chosen
 * concept (click to enlarge), the icon at 1× and 4×, and earlier versions as
 * small thumbnails (click to choose one). With no images it is one quiet row
 * of the two actions.
 */
export function BenchImages({ world, entity }: { world: World; entity: Entity }): ReactNode {
  const id = entity.id;
  const icons = takesIcon(world, entity.kind);
  const concept = selected(world, id, 'concept');
  const icon = selected(world, id, 'icon');
  const conceptPending = usePending(id, 'concept');
  const iconPending = usePending(id, 'icon');
  const fromSheet = icons && !!sheetOfIcon(world, id);
  const older = [
    ...versions(world, id, 'concept').filter((m) => m.id !== concept?.id),
    ...(icons ? versions(world, id, 'icon').filter((m) => m.id !== icon?.id) : []),
  ];
  const any = !!concept || !!icon || conceptPending || iconPending || older.length > 0;

  const versionMenu = (m: ImageMeta): MenuEntry[] => [
    { label: 'Choose', onSelect: () => void chooseImage(id, m.id) },
    { label: 'Enlarge', onSelect: () => openImageOverlay('lightbox', { entity: id, image: m.id }) },
    'separator',
    { label: 'Remove', destructive: true, onSelect: () => void removeImage(id, m) },
  ];
  const chosenMenu = (m: ImageMeta): MenuEntry[] => [
    { label: 'Enlarge', onSelect: () => openImageOverlay('lightbox', { entity: id, image: m.id }) },
    ...(m.origin.by === 'sheet'
      ? [{ label: 'Review sheet', onSelect: () => reviewSheet(id) } as MenuEntry]
      : []),
    {
      label: m.kind === 'concept' ? 'New concept' : 'New icon',
      keys: m.kind === 'concept' ? KEYS.concept : KEYS.icon,
      onSelect: () => requestImage(id, m.kind === 'icon' ? 'icon' : 'concept'),
    },
    'separator',
    { label: 'Remove', destructive: true, onSelect: () => void removeImage(id, m) },
  ];
  const itemsAt = (t: Element): MenuEntry[] | null => {
    const imgId = t.closest('[data-image]')?.getAttribute('data-image');
    const m = imgId ? older.find((x) => x.id === imgId) : undefined;
    if (m) return versionMenu(m);
    if (concept && imgId === concept.id) return chosenMenu(concept);
    if (icon && imgId === icon.id) return chosenMenu(icon);
    return null;
  };

  const actions = (
    <div className="bench-img-actions">
      <Tooltip content="Generate concept art" keys={KEYS.concept}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => requestImage(id, 'concept')}
          disabled={conceptPending}
          data-testid="bench-image-concept"
        >
          <IconImage /> Concept
        </Button>
      </Tooltip>
      {icons && (
        <Tooltip content="Generate an icon" keys={KEYS.icon}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => requestImage(id, 'icon')}
            disabled={iconPending}
            data-testid="bench-image-icon"
          >
            Icon
          </Button>
        </Tooltip>
      )}
      {icons && fromSheet && (
        <Tooltip content="Review the sheet this icon came from, free">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => reviewSheet(id)}
            data-testid="bench-image-review-sheet"
          >
            Sheet
          </Button>
        </Tooltip>
      )}
      {icons && concept && (
        <Tooltip content="The icon filtered from the concept, free">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void iconFromConcept(id)}
            disabled={iconPending}
            data-testid="bench-image-from-concept"
          >
            From concept
          </Button>
        </Tooltip>
      )}
    </div>
  );

  if (!any) return <div className="bench-images bench-images-none">{actions}</div>;

  return (
    <ContextMenu itemsAt={itemsAt}>
      <div className="bench-images" data-testid="bench-images">
        <div className="bench-img-main">
          {conceptPending ? (
            <Shimmer className="bench-img-concept" />
          ) : concept ? (
            <button
              type="button"
              className="bench-img-open"
              onClick={() => openImageOverlay('lightbox', { entity: id, image: concept.id })}
              aria-label="Enlarge the concept"
              data-testid="bench-concept"
            >
              <Thumb meta={concept} className="bench-img-concept" title={describe(concept)} />
            </button>
          ) : null}
          {icons && (iconPending || icon) && (
            <div className="bench-img-icon" data-testid="bench-icon">
              {iconPending ? (
                <Shimmer style={{ width: 64, height: 64 }} />
              ) : icon ? (
                <>
                  <Thumb meta={icon} size={64} title={describe(icon)} testId="bench-icon-4x" />
                  <Thumb
                    meta={icon}
                    size={18}
                    className="bench-img-1x"
                    title={describe(icon)}
                    testId="bench-icon-1x"
                  />
                </>
              ) : null}
            </div>
          )}
        </div>
        {older.length > 0 && (
          <div className="bench-img-versions" data-testid="bench-versions">
            {older.map((m) => (
              <Tooltip key={m.id} content={`Choose · ${describe(m)}`}>
                <button
                  type="button"
                  className={cx('bench-img-version', `bench-img-version-${m.kind}`)}
                  onClick={() => void chooseImage(id, m.id)}
                  data-image={m.id}
                  data-testid="bench-version"
                >
                  <Thumb meta={m} size={28} />
                </button>
              </Tooltip>
            ))}
          </div>
        )}
        {actions}
      </div>
    </ContextMenu>
  );
}

/** The image entries of the Bench `…` menu. */
export function benchImageMenu(world: World, entity: Entity): MenuEntry[] {
  const id = entity.id;
  const icons = takesIcon(world, entity.kind);
  const concept = selected(world, id, 'concept');
  const icon = selected(world, id, 'icon');
  const out: MenuEntry[] = [
    { label: 'Concept', keys: KEYS.concept, onSelect: () => requestImage(id, 'concept') },
  ];
  if (icons) out.push({ label: 'Icon', keys: KEYS.icon, onSelect: () => requestImage(id, 'icon') });
  if (icons && concept)
    out.push({ label: 'Icon from concept', onSelect: () => void iconFromConcept(id) });
  if (icons && sheetOfIcon(world, id))
    out.push({ label: 'Review sheet', onSelect: () => reviewSheet(id) });
  const choices = (kind: ImageKind, cur: ImageMeta | undefined): MenuEntry[] =>
    versions(world, id, kind)
      .filter((m) => m.id !== cur?.id)
      .slice(0, 3)
      .map((m) => ({
        label: `Choose ${kind} from ${m.created.slice(0, 10)}`,
        onSelect: () => void chooseImage(id, m.id),
      }));
  out.push(...choices('concept', concept));
  if (icons) out.push(...choices('icon', icon));
  if (concept)
    out.push({
      label: 'Remove concept',
      destructive: true,
      onSelect: () => void removeImage(id, concept),
    });
  if (icon)
    out.push({
      label: 'Remove icon',
      destructive: true,
      onSelect: () => void removeImage(id, icon),
    });
  return out;
}
