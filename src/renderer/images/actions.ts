import type { World } from '@core/model/world';
import { useActions, RANK, type Action } from '../actions';
import { flash, uiStore, useUi } from '../state/ui';
import { currentWorld, dispatch, transact, useWorld } from '../state/world';
import type { MenuEntry } from '../ui';
import { imageCommands, images, imageStatusStore } from './client';
import { selected, takesIcon, type ImageKind, type ImageMeta } from './model';
import { openImageOverlay, setPending } from './store';

/**
 * The image actions (docs/IMAGES.md §6), in one place so every surface offers
 * the same ones with the same keys: the Climate panel, the Column chip, the
 * Codex row and bulk bar, the Bench, the palette.
 *
 * Nothing here spends anything by itself: Concept and Icon open the confirm
 * step, and only its `enter` sends the call.
 */

export const KEYS = { concept: 'ctrl+g', icon: 'ctrl+shift+g' } as const;

const nameOf = (w: World, id: string): string => w.entities[id]?.name ?? id;

/** Why images can't be made now, or null. */
function blocked(): string | null {
  const s = imageStatusStore.get();
  if (!s.enabled) return `Images are off${s.reason ? `: ${s.reason}` : ''}`;
  return null;
}

/** Whether an entity can have an image of this kind. */
export function canHave(w: World, id: string, kind: ImageKind): boolean {
  const e = w.entities[id];
  if (!e) return false;
  return kind === 'concept' || takesIcon(w, e.kind);
}

/** Opens the confirm step for one image. */
export function requestImage(entity: string, kind: ImageKind): void {
  const w = currentWorld();
  if (!w || !w.entities[entity]) return;
  if (!canHave(w, entity, kind))
    return flash(`${w.schema.kinds[w.entities[entity].kind]?.label ?? 'This kind'} has no icon`);
  const why = blocked();
  if (why) return flash(why, 'error');
  openImageOverlay('confirm', { entity, kind });
}

/** Opens the batch dialog for several entities (only those that can have the kind). */
export function requestBatch(entities: readonly string[], kind: ImageKind): void {
  const w = currentWorld();
  if (!w) return;
  const ids = entities.filter((id) => canHave(w, id, kind));
  if (ids.length === 0) return flash(kind === 'icon' ? 'None of these take icons' : 'Nothing here');
  const why = blocked();
  if (why) return flash(why, 'error');
  openImageOverlay('batch', { entities: ids, kind });
}

/** The icon filtered from the entity's concept: free, so it runs at once. */
export async function iconFromConcept(entity: string): Promise<void> {
  const w = currentWorld();
  if (!w || !selected(w, entity, 'concept')) return flash('No concept to make an icon from');
  setPending(entity, 'icon', true);
  try {
    const r = await images.iconFromConcept({ entityId: entity });
    if (!r.ok) flash(r.error.message, 'error');
  } finally {
    setPending(entity, 'icon', false);
  }
}

/** Chooses an image as the entity's concept or icon (undoable). */
export async function chooseImage(entity: string, image: string): Promise<void> {
  const r = await dispatch(imageCommands.select(entity, image));
  if (!r.ok) flash(r.error.message, 'error');
}

/** Removes an image from the world (undoable; its files stay until "Delete image files"). */
export async function removeImage(entity: string, image: ImageMeta): Promise<void> {
  const w = currentWorld();
  const label = `Remove ${image.kind} of ${w ? nameOf(w, entity) : entity}`;
  const r = await transact(label, [imageCommands.remove(entity, image.id)]);
  if (!r.ok) flash(r.error.message, 'error');
}

/** The image entries of an entity's menu (Climate panel, Column chip, Codex row, Bench `…`). */
export function imageMenu(w: World, id: string): MenuEntry[] {
  const e = w.entities[id];
  if (!e) return [];
  const icons = takesIcon(w, e.kind);
  const concept = selected(w, id, 'concept');
  const icon = selected(w, id, 'icon');
  const out: MenuEntry[] = [
    {
      label: concept ? 'New concept' : 'Generate concept',
      keys: KEYS.concept,
      onSelect: () => requestImage(id, 'concept'),
    },
  ];
  if (icons) {
    out.push({
      label: icon ? 'New icon' : 'Generate icon',
      keys: KEYS.icon,
      onSelect: () => requestImage(id, 'icon'),
    });
    if (concept) out.push({ label: 'Icon from concept', onSelect: () => void iconFromConcept(id) });
  }
  if (concept)
    out.push({
      label: 'Remove concept',
      destructive: true,
      onSelect: () => void removeImage(id, concept),
    });
  if (icon)
    out.push({ label: 'Remove icon', destructive: true, onSelect: () => void removeImage(id, icon) });
  return out;
}

/** The entities "whatever is selected" means: a multi-selection, else the entity in focus. */
function targets(): { one: string | null; many: string[] } {
  const { focus, selection } = uiStore.get();
  if (selection.length > 1) return { one: null, many: selection };
  return { one: focus ?? selection[0] ?? null, many: [] };
}

function run(kind: ImageKind): void {
  const t = targets();
  if (t.many.length > 1) return requestBatch(t.many, kind);
  if (t.one) return requestImage(t.one, kind);
  flash('Nothing selected');
}

/**
 * The keys that work on whatever is selected, in every view (ctrl+g concept,
 * ctrl+shift+g icon), and the palette's entity-aware entries. Mounted once,
 * by the shell, at the shell's rank: a view can claim the same keys for its
 * own selection (the Codex does, for the rows its filter shows).
 */
export function useImageActions(): void {
  const focus = useUi((s) => s.focus);
  const selection = useUi((s) => s.selection);
  const info = useWorld((w) => {
    const id = focus ?? selection[0];
    const e = id ? w.entities[id] : undefined;
    return {
      name: e?.name ?? null,
      icons: e ? takesIcon(w, e.kind) : false,
      concept: id ? !!selected(w, id, 'concept') : false,
      many: selection.length > 1 ? selection.length : 0,
      manyIcons: selection.filter((x) => canHave(w, x, 'icon')).length,
    };
  });
  const one = focus ?? selection[0] ?? null;
  const many = info?.many ?? 0;
  const actions: Action[] = [
    {
      id: 'images.concept',
      label:
        many > 1
          ? `Generate concepts (${many})`
          : info?.name
            ? `Generate concept: ${info.name}`
            : 'Generate concept',
      group: 'Images',
      keys: [KEYS.concept],
      enabled: () => many > 1 || !!one,
      run: () => run('concept'),
    },
    {
      id: 'images.icon',
      label:
        many > 1
          ? `Generate icons (${info?.manyIcons ?? 0})`
          : info?.name
            ? `Generate icon: ${info.name}`
            : 'Generate icon',
      group: 'Images',
      keys: [KEYS.icon],
      enabled: () => (many > 1 ? (info?.manyIcons ?? 0) > 0 : !!one && !!info?.icons),
      run: () => run('icon'),
    },
    {
      id: 'images.icon-from-concept',
      label: info?.name ? `Icon from concept: ${info.name}` : 'Icon from concept',
      group: 'Images',
      enabled: () => many <= 1 && !!one && !!info?.icons && !!info.concept,
      run: () => one && void iconFromConcept(one),
    },
    {
      id: 'images.delete-files',
      label: 'Delete image files of removed images',
      group: 'Images',
      run: () => openImageOverlay('purge', {}),
    },
  ];
  // The palette lists only what's enabled now, so these appear when they apply.
  useActions(actions, true, { rank: RANK.shell });
}
