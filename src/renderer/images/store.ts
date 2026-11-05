import { createStore, useStore } from '../state/store';
import { setUi, uiStore } from '../state/ui';
import type { ImageKind } from './model';

/**
 * The image UI's own state: what the confirm step, the batch dialog and the
 * lightbox show, and which images are being made right now (each draws a
 * shimmer where the image will land). Not part of the world.
 */
export interface ImageUi {
  confirm: { entity: string; kind: ImageKind } | null;
  batch: { entities: string[]; kind: ImageKind } | null;
  lightbox: { entity: string; image: string } | null;
  /** `entity:kind` → true while a call for it runs. */
  pending: Record<string, true>;
}

export const imageUi = createStore<ImageUi>({
  confirm: null,
  batch: null,
  lightbox: null,
  pending: {},
});

export const useImageUi = <T>(sel: (s: ImageUi) => T): T => useStore(imageUi, sel);

export const pendingKey = (entity: string, kind: ImageKind): string => `${entity}:${kind}`;

export const usePending = (entity: string | null | undefined, kind: ImageKind): boolean =>
  useImageUi((s) => !!entity && s.pending[pendingKey(entity, kind)] === true);

export function setPending(entity: string, kind: ImageKind, on: boolean): void {
  imageUi.set((s) => {
    const pending = { ...s.pending };
    if (on) pending[pendingKey(entity, kind)] = true;
    else delete pending[pendingKey(entity, kind)];
    return { ...s, pending };
  });
}

export const OVERLAY = {
  confirm: 'image-confirm',
  batch: 'image-batch',
  lightbox: 'image-lightbox',
} as const;

/** Opens one of the image overlays (escape closes it, like every overlay). */
export function openImageOverlay<K extends keyof typeof OVERLAY>(
  which: K,
  value: NonNullable<ImageUi[K]>,
): void {
  imageUi.set((s) => ({ ...s, [which]: value }));
  setUi({ overlay: OVERLAY[which] });
}

export function closeImageOverlay(which: keyof typeof OVERLAY): void {
  if (uiStore.get().overlay === OVERLAY[which]) setUi({ overlay: null });
}
