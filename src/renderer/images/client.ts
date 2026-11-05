import { useEffect } from 'react';
import { cmd, type Command } from '@core/commands/registry';
import type {
  BatchPlan,
  BatchPlanRequest,
  BatchProgress,
  BatchResult,
  BatchRunRequest,
  IconFromConceptRequest,
  ImageEstimate,
  ImageEstimateRequest,
  ImageGenerateRequest,
  ImageLogEntry,
  ImagePromptResult,
  ImageResult,
  ImageStatus,
  SheetAcceptRequest,
  SheetAcceptResult,
  SheetCropRequest,
  SheetReview,
  SheetRunRequest,
  SheetRunResult,
} from '@core/images/gateway';
import { DEFAULT_IMAGE_MODEL, DEFAULT_IMAGE_QUALITY } from '@core/images/model';
import { invoke, on } from '../bridge';
import { createStore, useStore } from '../state/store';
import type { ImageKind, ImageMeta } from './model';

/**
 * The renderer's image gateway: core's `ImageGateway` over the `images:*`
 * IPC channels (src/shared/ipc.ts). Every image UI goes through here.
 */

const INITIAL: ImageStatus = {
  mode: 'off',
  enabled: false,
  reason: 'connecting…',
  model: DEFAULT_IMAGE_MODEL,
  quality: DEFAULT_IMAGE_QUALITY,
  spend: { sessionUsd: 0, monthUsd: 0 },
  budget: { sessionUsd: 0, monthUsd: 0 },
  paused: false,
  pending: 0,
};

export const imageStatusStore = createStore<ImageStatus>(INITIAL);
export const useImageStatus = (): ImageStatus => useStore(imageStatusStore, (s) => s);

/** The image log as it grows (the AI log shows it beside Claude's calls). */
export const imageLogStore = createStore<ImageLogEntry[]>([]);

const progressListeners = new Map<string, (p: BatchProgress) => void>();
let started = false;

/** Follows image status, the log and batch progress. Called once by the shell. */
export function startImageSync(): void {
  if (started) return;
  started = true;
  on('images:status', (s) => imageStatusStore.set(s));
  on('images:progress', (p) => progressListeners.get(p.batchId)?.(p));
  on('images:logged', (e) => imageLogStore.set((l) => [...l, e]));
  void invoke('images:status', null)
    .then((s) => imageStatusStore.set(s))
    .catch(() => undefined);
}

let seq = 0;
export const newRequestId = (prefix = 'img'): string =>
  `${prefix}-${Date.now().toString(36)}-${++seq}`;

export const images = {
  prompt(entityId: string, kind: ImageKind, requestId?: string): Promise<ImagePromptResult> {
    return invoke('images:prompt', { entityId, kind, ...(requestId ? { requestId } : {}) });
  },
  estimate(req: ImageEstimateRequest): Promise<ImageEstimate> {
    return invoke('images:estimate', req);
  },
  generate(req: ImageGenerateRequest): Promise<ImageResult> {
    return invoke('images:generate', req);
  },
  iconFromConcept(req: IconFromConceptRequest): Promise<ImageResult> {
    return invoke('images:iconFromConcept', req);
  },
  batchPlan(req: BatchPlanRequest): Promise<BatchPlan> {
    return invoke('images:batchPlan', req);
  },
  async batchRun(
    req: BatchRunRequest,
    onProgress?: (p: BatchProgress) => void,
  ): Promise<BatchResult> {
    if (onProgress) progressListeners.set(req.batchId, onProgress);
    try {
      return await invoke('images:batchRun', req);
    } finally {
      progressListeners.delete(req.batchId);
    }
  },
  async sheetRun(
    req: SheetRunRequest,
    onProgress?: (p: BatchProgress) => void,
  ): Promise<SheetRunResult> {
    if (onProgress) progressListeners.set(req.batchId, onProgress);
    try {
      return await invoke('images:sheetRun', req);
    } finally {
      progressListeners.delete(req.batchId);
    }
  },
  sheetAccept(req: SheetAcceptRequest): Promise<SheetAcceptResult> {
    return invoke('images:sheetAccept', req);
  },
  sheetCrop(req: SheetCropRequest): Promise<SheetReview | null> {
    return invoke('images:sheetCrop', req);
  },
  cancel(id: string): Promise<{ ok: true }> {
    return invoke('images:cancel', { id });
  },
  log(limit?: number): Promise<ImageLogEntry[]> {
    return invoke('images:log', limit === undefined ? {} : { limit });
  },
  deleteFiles(entityId?: string): Promise<{ removed: number; bytes: number }> {
    return invoke('images:deleteFiles', entityId ? { entityId } : {});
  },
};

// ── Commands (core's image commands; IMAGES.md §3) ─────────────────────────

export const imageCommands = {
  select: (entity: string, image: string): Command => cmd('image.select', { entity, image }),
  unselect: (entity: string, kind: ImageKind): Command => cmd('image.unselect', { entity, kind }),
  remove: (entity: string, image: string): Command => cmd('image.remove', { entity, image }),
};

// ── Pixels ──────────────────────────────────────────────────────────────────

export type ImageVariant = 'png' | 'src' | 'thumb';
type Loaded = { dataUrl: string; width: number; height: number } | null;

/** Data URLs by `entity/id/variant` (null: the file is gone). An image file never changes under its id. */
const loaded = createStore<Record<string, string | null>>({});
const inflight = new Map<string, Promise<Loaded>>();

const keyOf = (meta: Pick<ImageMeta, 'entity' | 'id'>, variant: ImageVariant): string =>
  `${meta.entity}/${meta.id}/${variant}`;

export function loadImage(
  meta: Pick<ImageMeta, 'entity' | 'id'>,
  variant: ImageVariant = 'png',
): Promise<Loaded> {
  const key = keyOf(meta, variant);
  let p = inflight.get(key);
  if (!p) {
    p = invoke('images:file', { entityId: meta.entity, imageId: meta.id, variant })
      .then((r) => {
        loaded.set((m) => ({ ...m, [key]: r?.dataUrl ?? null }));
        return r;
      })
      .catch(() => {
        inflight.delete(key);
        return null;
      });
    inflight.set(key, p);
  }
  return p;
}

/** The image's data URL once loaded (null until then, or if the file is gone). */
export function useImageSrc(
  meta: Pick<ImageMeta, 'entity' | 'id'> | null | undefined,
  variant: ImageVariant = 'png',
): string | null {
  const key = meta ? keyOf(meta, variant) : null;
  const src = useStore(loaded, (m) => (key ? (m[key] ?? null) : null));
  useEffect(() => {
    if (meta && key && !inflight.has(key)) void loadImage(meta, variant);
    // The key names the file; `meta` and `variant` are in it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return src;
}

export const usd = (n: number, digits = 2): string => `$${n.toFixed(digits)}`;

/** A cost estimate as the UI shows it: exact to the cent, finer below a cent. */
export const estimateText = (n: number): string =>
  n === 0 ? '$0' : n < 0.01 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;
