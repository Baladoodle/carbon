import { z } from 'zod';
import { EntityIdSchema } from '../model/ids';
import {
  ImageIdSchema,
  ImageKindSchema,
  ImageMetaKindSchema,
  ImageMetaSchema,
  ImageModelSchema,
  ImageQualitySchema,
  ImageSizeSchema,
} from './model';

/**
 * The image gateway (docs/IMAGES.md §4): the single entry point for images,
 * in main, behind the `images:*` IPC channels (src/shared/ipc.ts).
 *
 * Every paid call is deliberate: the renderer first asks for a prompt
 * (`prompt`, which runs Claude's `image_prompt` moment) and an `estimate`,
 * shows both, and calls `generate` only after the user confirms. Nothing
 * here retries a call whose outcome is unknown.
 *
 * Implementations: the real one over OpenAI (src/main/images), the same
 * pipeline over a deterministic fake provider (`CARBON_IMAGES=fake`, every
 * test), and an off gateway (no key).
 */

export const IMAGE_ERROR_CODES = [
  'disabled', // images off (no key, CARBON_IMAGES=off)
  'no_key', // OpenAI rejected the key (401/403)
  'budget', // the OpenAI budget is reached; paused until raised
  'cancelled', // cancelled before the call was sent, or the user aborted it
  'rate_limited', // 429
  'server', // 5xx
  'network', // a connection failure before the request was sent
  'timeout', // no response in time: the outcome is UNKNOWN (may be charged); never retried
  'refused', // content policy refusal (moderation_blocked, safety system)
  'bad_request', // 400 other than a refusal
  'not_found', // the entity or reference image doesn't exist
  'invalid_output', // the response had no decodable image
  'prompt_failed', // Claude's image_prompt moment failed (its own error is in the message)
  'io', // writing the files failed
  'unknown',
] as const;
export const ImageErrorCodeSchema = z.enum(IMAGE_ERROR_CODES);
export type ImageErrorCode = z.infer<typeof ImageErrorCodeSchema>;

export const ImageErrorSchema = z.object({
  code: ImageErrorCodeSchema,
  message: z.string(),
  /** True when a call was sent and its outcome is unknown: it may have been charged. Never retried automatically. */
  unknownOutcome: z.boolean().default(false),
});
export type ImageError = z.infer<typeof ImageErrorSchema>;

/** One provider attempt (Genforge's receipt). There is at most one per call: nothing retries automatically. */
export const ImageAttemptSchema = z.object({
  at: z.iso.datetime(),
  provider: z.enum(['openai', 'fake']),
  endpoint: z.enum(['generate', 'edit']),
  model: z.string(),
  quality: z.string(),
  size: z.string(),
  status: z.enum(['ok', 'error', 'unknown']),
  httpStatus: z.number().int().optional(),
  requestId: z.string().optional(),
  latencyMs: z.number().min(0),
  usage: z
    .object({
      inputTokens: z.number().int().min(0).optional(),
      outputTokens: z.number().int().min(0).optional(),
      inputTextTokens: z.number().int().min(0).optional(),
      inputImageTokens: z.number().int().min(0).optional(),
    })
    .optional(),
  costUsd: z.number().min(0),
  /** How the cost was found: from the response's usage, or estimated (no usage reported, or unknown outcome). */
  costFrom: z.enum(['usage', 'estimate', 'none']),
  error: ImageErrorSchema.optional(),
});
export type ImageAttempt = z.infer<typeof ImageAttemptSchema>;

export const ImageReceiptSchema = z.object({
  /** The plan: what was asked. */
  entity: EntityIdSchema,
  kind: ImageMetaKindSchema,
  prompt: z.string(),
  attempts: z.array(ImageAttemptSchema),
  /** The image made, if any. */
  image: ImageIdSchema.optional(),
  costUsd: z.number().min(0),
});
export type ImageReceipt = z.infer<typeof ImageReceiptSchema>;

/** The options a paid call takes; anything absent comes from `settings.images`. */
export const ImageCallOptionsSchema = z.object({
  model: ImageModelSchema.optional(),
  quality: ImageQualitySchema.optional(),
  size: ImageSizeSchema.optional(),
});
export type ImageCallOptions = z.infer<typeof ImageCallOptionsSchema>;

// ── requests and responses ────────────────────────────────────────────────

export const ImagePromptRequestSchema = z.object({
  entityId: EntityIdSchema,
  kind: ImageKindSchema,
});
export const ImagePromptResultSchema = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    prompt: z.string(),
    /** What Claude's call cost (it's on Claude's meter, not OpenAI's). */
    claudeCostUsd: z.number().min(0),
  }),
  z.object({ ok: z.literal(false), error: ImageErrorSchema }),
]);
export type ImagePromptResult = z.infer<typeof ImagePromptResultSchema>;

export const ImageEstimateRequestSchema = ImageCallOptionsSchema.extend({
  kind: ImageKindSchema,
  /** Number of calls (a batch); default 1. */
  calls: z.number().int().min(0).max(10_000).default(1),
  /** Characters of prompt, for the input-token part of the estimate. */
  promptChars: z.number().int().min(0).optional(),
});
export const ImageEstimateSchema = z.object({
  model: ImageModelSchema,
  quality: ImageQualitySchema,
  size: ImageSizeSchema,
  calls: z.number().int().min(0),
  perCallUsd: z.number().min(0),
  totalUsd: z.number().min(0),
  /** Left in the session budget before this; the UI warns when `totalUsd` exceeds it. */
  remainingUsd: z.number(),
});
export type ImageEstimate = z.infer<typeof ImageEstimateSchema>;

export const ImageGenerateRequestSchema = ImageCallOptionsSchema.extend({
  /** Chosen by the renderer; used for cancellation. */
  requestId: z.string().min(1),
  entityId: EntityIdSchema,
  kind: ImageKindSchema,
  /** The confirmed (possibly edited) prompt. */
  prompt: z.string().min(1).max(32_000),
  /** An image of this entity to use as a reference (OpenAI edit). E.g. an icon from the concept. */
  reference: ImageIdSchema.optional(),
  /** Select the new image as the entity's concept or icon (default true). */
  select: z.boolean().default(true),
});
export const ImageResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), image: ImageMetaSchema, receipt: ImageReceiptSchema }),
  z.object({
    ok: z.literal(false),
    error: ImageErrorSchema,
    receipt: ImageReceiptSchema.optional(),
  }),
]);
export type ImageResult = z.infer<typeof ImageResultSchema>;

export const IconFromConceptRequestSchema = z.object({
  entityId: EntityIdSchema,
  /** The concept image to filter; default the entity's selected concept. */
  from: ImageIdSchema.optional(),
  select: z.boolean().default(true),
});

export const CELL_FLAGS = ['empty', 'background_only', 'touches_edge', 'fragmented'] as const;
export const CellFlagSchema = z.enum(CELL_FLAGS);

/** One planned sheet: up to 100 icons in one paid call. */
export const SheetPlanSchema = z.object({
  index: z.number().int().min(0),
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
  size: ImageSizeSchema,
  /** Each cell's prompt line, written from the entity (editable in the dialog). */
  items: z.array(z.object({ entityId: EntityIdSchema, name: z.string(), line: z.string() })),
  estimateUsd: z.number().min(0),
});
export type SheetPlan = z.infer<typeof SheetPlanSchema>;

export const BatchPlanRequestSchema = ImageCallOptionsSchema.extend({
  kind: ImageKindSchema,
  entityIds: z.array(EntityIdSchema).min(1).max(500),
  /** Include entities that already have one of this kind. */
  replace: z.boolean().default(false),
  /** Chosen by the renderer: cancels the prompt writing. */
  requestId: z.string().min(1).optional(),
});
export const BatchPlanItemSchema = z.object({
  entityId: EntityIdSchema,
  name: z.string(),
  /** The prompt Claude wrote (editable in the dialog); absent when skipped or failed. */
  prompt: z.string().optional(),
  /** Icons (sheets): the cell's prompt line. */
  line: z.string().optional(),
  /** Why the entity isn't in the run: it already has one (and replace is off), or its prompt failed. */
  skip: z.enum(['has_image', 'prompt_failed', 'not_found']).optional(),
  error: ImageErrorSchema.optional(),
});
export const BatchPlanSchema = z.object({
  kind: ImageKindSchema,
  model: ImageModelSchema,
  quality: ImageQualitySchema,
  size: ImageSizeSchema,
  items: z.array(BatchPlanItemSchema),
  /** Paid calls the run will make (items with a prompt). */
  calls: z.number().int().min(0),
  estimate: ImageEstimateSchema,
  claudeCostUsd: z.number().min(0),
  /**
   * Icons only (IMAGES.md §2a): the sheets the run will make. Each item then
   * has a `line` instead of a Claude-written prompt; `calls` counts sheets,
   * and the estimate is per sheet. Run it with `images:sheetRun`.
   */
  sheets: z.array(SheetPlanSchema).optional(),
});
export type BatchPlan = z.infer<typeof BatchPlanSchema>;

export const BatchRunRequestSchema = ImageCallOptionsSchema.extend({
  /** Chosen by the renderer: progress events carry it, and `cancel` takes it. */
  batchId: z.string().min(1),
  kind: ImageKindSchema,
  items: z
    .array(z.object({ entityId: EntityIdSchema, prompt: z.string().min(1).max(32_000) }))
    .min(1)
    .max(500),
  select: z.boolean().default(true),
});
export const BatchItemResultSchema = z.object({
  entityId: EntityIdSchema,
  result: ImageResultSchema,
});
export const BatchResultSchema = z.object({
  batchId: z.string(),
  /** In the order of the request. Items never started (cancelled, budget) carry that error. */
  items: z.array(BatchItemResultSchema),
  costUsd: z.number().min(0),
  cancelled: z.boolean(),
});
export type BatchResult = z.infer<typeof BatchResultSchema>;
export const BatchProgressSchema = z.object({
  batchId: z.string(),
  total: z.number().int().min(0),
  done: z.number().int().min(0),
  running: z.array(EntityIdSchema),
  /** The item that just finished, if any. */
  item: BatchItemResultSchema.optional(),
  costUsd: z.number().min(0),
});
export type BatchProgress = z.infer<typeof BatchProgressSchema>;

// ── icon sheets (IMAGES.md §2a) ───────────────────────────────────────────

export const SheetRunRequestSchema = ImageCallOptionsSchema.omit({ size: true }).extend({
  /** Chosen by the renderer: progress events carry it, and `cancel` takes it. */
  batchId: z.string().min(1),
  /** The confirmed items and their (possibly edited) lines; main splits them into sheets of ≤ 100. */
  items: z
    .array(z.object({ entityId: EntityIdSchema, line: z.string().min(1).max(600) }))
    .min(1)
    .max(500),
});

/** A data URL and its size. */
export const ImageDataSchema = z.object({
  dataUrl: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});

export const SheetCellReviewSchema = z.object({
  index: z.number().int().min(0),
  entityId: EntityIdSchema,
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  /** Reasons to look twice; accepting a flagged cell is allowed. */
  flags: z.array(CellFlagSchema),
  /** The sprite as cut from the sheet (at most 128px), or null when the cell is empty. */
  crop: ImageDataSchema.nullable(),
  /** The 16×16 icon it would become (the `item` filter), or null. */
  icon: ImageDataSchema.nullable(),
});
export type SheetCellReview = z.infer<typeof SheetCellReviewSchema>;

/** A generated sheet ready for review: it's already in the world (kind `sheet`); its cells are not icons yet. */
export const SheetReviewSchema = z.object({
  sheet: ImageMetaSchema,
  /** The sheet itself at most 1024px, for the review. */
  preview: ImageDataSchema,
  cells: z.array(SheetCellReviewSchema),
});
export type SheetReview = z.infer<typeof SheetReviewSchema>;

export const SheetOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), review: SheetReviewSchema, receipt: ImageReceiptSchema }),
  z.object({
    ok: z.literal(false),
    error: ImageErrorSchema,
    receipt: ImageReceiptSchema.optional(),
    /** The items this sheet would have held, to regenerate them. */
    entityIds: z.array(EntityIdSchema),
  }),
]);
export type SheetOutcome = z.infer<typeof SheetOutcomeSchema>;

export const SheetRunResultSchema = z.object({
  batchId: z.string(),
  sheets: z.array(SheetOutcomeSchema),
  costUsd: z.number().min(0),
  cancelled: z.boolean(),
});
export type SheetRunResult = z.infer<typeof SheetRunResultSchema>;

export const SheetCropRequestSchema = z.object({
  /** The entity the sheet belongs to (its first cell's). */
  entityId: EntityIdSchema,
  imageId: ImageIdSchema,
});

export const SheetAcceptRequestSchema = z.object({
  entityId: EntityIdSchema,
  imageId: ImageIdSchema,
  /** The cells to turn into icons (by index). */
  cells: z.array(z.number().int().min(0)).min(1),
  /** Make each new icon its entity's chosen icon (default true). */
  select: z.boolean().default(true),
});
export const SheetAcceptResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), images: z.array(ImageMetaSchema) }),
  z.object({ ok: z.literal(false), error: ImageErrorSchema }),
]);
export type SheetAcceptResult = z.infer<typeof SheetAcceptResultSchema>;

export const ImageStatusSchema = z.object({
  /** `real`: OpenAI; `fake`: deterministic images (CARBON_IMAGES=fake); `off`: no images. */
  mode: z.enum(['real', 'fake', 'off']),
  enabled: z.boolean(),
  reason: z.string().optional(),
  model: ImageModelSchema,
  quality: ImageQualitySchema,
  spend: z.object({ sessionUsd: z.number(), monthUsd: z.number() }),
  budget: z.object({ sessionUsd: z.number(), monthUsd: z.number() }),
  paused: z.boolean(),
  /** Paid calls in flight. */
  pending: z.number().int().min(0),
});
export type ImageStatus = z.infer<typeof ImageStatusSchema>;

export const ImageFileRequestSchema = z.object({
  entityId: EntityIdSchema,
  imageId: ImageIdSchema,
  /** `png`: the image (icons: 16×16); `src`: the provider's source; `thumb`: at most 256px, for lists. */
  variant: z.enum(['png', 'src', 'thumb']).default('png'),
});
export const ImageFileSchema = z
  .object({ dataUrl: z.string(), width: z.number().int(), height: z.number().int() })
  .nullable();

export const DeleteImageFilesRequestSchema = z.object({
  /** Limit to one entity; default every entity. */
  entityId: EntityIdSchema.optional(),
});
export const DeleteImageFilesResultSchema = z.object({
  /** Image files removed: only images no longer in the world (removed, or of deleted entities). */
  removed: z.number().int().min(0),
  bytes: z.number().int().min(0),
});

/** One image call in the AI log (`ai-log/images-<date>.jsonl`). */
export const ImageLogEntrySchema = z.object({
  id: z.string(),
  at: z.iso.datetime(),
  provider: z.enum(['openai', 'fake']),
  entity: EntityIdSchema,
  kind: ImageMetaKindSchema,
  endpoint: z.enum(['generate', 'edit']),
  model: z.string(),
  size: z.string(),
  quality: z.string(),
  outcome: z.enum(['ok', 'error', 'unknown', 'cancelled']),
  error: ImageErrorSchema.optional(),
  usage: ImageAttemptSchema.shape.usage,
  costUsd: z.number().min(0),
  costFrom: z.enum(['usage', 'estimate', 'none']),
  latencyMs: z.number().min(0),
  requestId: z.string().optional(),
  /** The image made: the AI log shows its thumbnail via `images:file`. */
  image: ImageIdSchema.optional(),
  batchId: z.string().optional(),
  /** Added by the agent socket (docs/MCP.md): an outside agent asked for this call. */
  via: z.enum(['agent']).optional(),
});
export type ImageLogEntry = z.infer<typeof ImageLogEntrySchema>;

export type ImagePromptRequest = z.input<typeof ImagePromptRequestSchema>;
export type ImageEstimateRequest = z.input<typeof ImageEstimateRequestSchema>;
export type ImageGenerateRequest = z.input<typeof ImageGenerateRequestSchema>;
export type IconFromConceptRequest = z.input<typeof IconFromConceptRequestSchema>;
export type BatchPlanRequest = z.input<typeof BatchPlanRequestSchema>;
export type BatchRunRequest = z.input<typeof BatchRunRequestSchema>;
export type SheetRunRequest = z.input<typeof SheetRunRequestSchema>;
export type SheetCropRequest = z.input<typeof SheetCropRequestSchema>;
export type SheetAcceptRequest = z.input<typeof SheetAcceptRequestSchema>;

/**
 * The gateway. Methods resolve to outcomes; they never throw for expected
 * failures.
 */
export interface ImageGateway {
  /** Claude writes a prompt for the entity (the `image_prompt` moment). Costs Claude tokens, not OpenAI. */
  prompt(req: ImagePromptRequest, signal?: AbortSignal): Promise<ImagePromptResult>;
  /** The estimated cost before anything is spent. Synchronous pricing, no call. */
  estimate(req: ImageEstimateRequest): ImageEstimate;
  /** One paid call (concept, or icon then the `item` filter), files written, then `image.add` (+ select). */
  generate(req: ImageGenerateRequest, signal?: AbortSignal): Promise<ImageResult>;
  /** An icon from the entity's concept through the `item` pixel filter. Free: no API call. */
  iconFromConcept(req: IconFromConceptRequest): Promise<ImageResult>;
  /** Prompts for every entity (skipping ones that have an image unless `replace`), and the estimate. No OpenAI call. */
  batchPlan(req: BatchPlanRequest, signal?: AbortSignal): Promise<BatchPlan>;
  /** Runs a confirmed plan, concurrency 2, with progress events. Stops starting new items on cancel or budget. */
  batchRun(req: BatchRunRequest, onProgress?: (p: BatchProgress) => void): Promise<BatchResult>;
  /** Icon sheets (IMAGES.md §2a): one paid call per sheet of ≤ 100, cropped and filtered for review. Nothing becomes an icon yet. */
  sheetRun(req: SheetRunRequest, onProgress?: (p: BatchProgress) => void): Promise<SheetRunResult>;
  /** Re-crops a kept sheet for review. Free. Null when the sheet or its file is gone. */
  sheetCrop(req: SheetCropRequest): Promise<SheetReview | null>;
  /** Turns accepted cells into icons (`origin.by: 'sheet'`), one undo step. Free. */
  sheetAccept(req: SheetAcceptRequest): Promise<SheetAcceptResult>;
  /** Cancels a `generate` (by requestId), a `batchPlan` (by requestId), or a `batchRun` or `sheetRun` (by batchId). */
  cancel(id: string): void;
  status(): ImageStatus;
  onStatus(listener: (s: ImageStatus) => void): () => void;
  /** Most recent image calls, newest last. */
  log(limit?: number): Promise<ImageLogEntry[]>;
}
