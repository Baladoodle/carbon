import { z } from 'zod';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_IMAGE_QUALITY,
  DEFAULT_SIZE,
  IMAGE_MODELS,
  ImageModelSchema,
  ImageQualitySchema,
  type ImageKind,
  type ImageModel,
  type ImageQuality,
  type ImageSize,
} from './model';

/**
 * OpenAI image pricing and `settings.images` (docs/IMAGES.md §4).
 *
 * Prices are per million tokens, as OpenAI bills the GPT Image models. They
 * were verified on 2026-11-05 against OpenAI's pricing page
 * (https://developers.openai.com/api/docs/pricing) and the model pages for
 * gpt-image-2.6-flare and gpt-image-2.6-sunburst: text input $5, image input
 * $8, image output $30, for both models and for gpt-image-2.5-flare (cached input does not apply to the
 * Images API). OpenAI publishes no per-image prices for these models, so the
 * estimate uses output tokens per image by quality and size
 * (`OUTPUT_TOKENS`), calibrated from the real calls recorded in
 * docs/build-notes/images-core.md. The cost of a finished call comes from the
 * usage the response reports, never from the estimate, when usage is there.
 */

export const TokenPriceSchema = z.object({
  /** USD per million tokens. */
  textInput: z.number().min(0),
  imageInput: z.number().min(0),
  imageOutput: z.number().min(0),
});
export type TokenPrice = z.infer<typeof TokenPriceSchema>;

export const PRICING_VERIFIED = '2026-11-05';
export const PRICING_SOURCE = 'https://developers.openai.com/api/docs/pricing';

export const DEFAULT_IMAGE_PRICING: Record<ImageModel, TokenPrice> = {
  'gpt-image-2.6-flare': { textInput: 5, imageInput: 8, imageOutput: 30 },
  'gpt-image-2.6-sunburst': { textInput: 5, imageInput: 8, imageOutput: 30 },
  // Same per-token prices on the pricing page; it spends far fewer output tokens per image.
  'gpt-image-2.5-flare': { textInput: 5, imageInput: 8, imageOutput: 30 },
};

type TokenTable = Record<ImageQuality, Record<ImageSize, number>>;

/**
 * Image output tokens per image, for the estimate only (a finished call is
 * costed from its reported usage). M = measured, D = derived.
 *
 * gpt-image-2.6 (flare and sunburst, 2026-11-05):
 *  - low: 1024² 824 (M, both models), 1536×1024 664 (M, both), 2880² 2,768
 *    (M, flare, an edit with the sheet guide); 1024×1536 is taken as 664 (D)
 *  - medium: 1024² 1,449 (M, the coordinator's controlled run); the other
 *    sizes are low × 1.7585, the measured medium/low ratio (D)
 *  - high: UNMEASURED. Low × 15.3, OpenAI's ratio for the earlier GPT Image
 *    models, which errs high (D)
 *
 * gpt-image-2.5-flare:
 *  - low 1024² 196 (M), medium 1024² 439 (M)
 *  - other sizes scale like 2.6's measured low (1536×1024 × 0.806, 2880² ×
 *    3.359) (D); high is medium × 3.94, the earlier models' ratio, UNMEASURED (D)
 */
export const OUTPUT_TOKENS_BY_MODEL: Record<ImageModel, TokenTable> = {
  'gpt-image-2.6-flare': {
    low: { '1024x1024': 824, '1024x1536': 664, '1536x1024': 664, '2880x2880': 2768 },
    medium: { '1024x1024': 1449, '1024x1536': 1168, '1536x1024': 1168, '2880x2880': 4868 },
    high: { '1024x1024': 12602, '1024x1536': 10305, '1536x1024': 10305, '2880x2880': 42333 },
  },
  'gpt-image-2.6-sunburst': {
    low: { '1024x1024': 824, '1024x1536': 664, '1536x1024': 664, '2880x2880': 2768 },
    medium: { '1024x1024': 1449, '1024x1536': 1168, '1536x1024': 1168, '2880x2880': 4868 },
    high: { '1024x1024': 12602, '1024x1536': 10305, '1536x1024': 10305, '2880x2880': 42333 },
  },
  'gpt-image-2.5-flare': {
    low: { '1024x1024': 196, '1024x1536': 158, '1536x1024': 158, '2880x2880': 658 },
    medium: { '1024x1024': 439, '1024x1536': 354, '1536x1024': 354, '2880x2880': 1475 },
    high: { '1024x1024': 1729, '1024x1536': 1393, '1536x1024': 1393, '2880x2880': 5810 },
  },
};
/** gpt-image-2.6-flare's table (kept under its old name). */
export const OUTPUT_TOKENS: TokenTable = OUTPUT_TOKENS_BY_MODEL['gpt-image-2.6-flare'];

/** Estimated output tokens for one image; an unknown model uses the default's table. */
export function outputTokens(model: string, quality: ImageQuality, size: ImageSize): number {
  const table = (IMAGE_MODELS as readonly string[]).includes(model)
    ? OUTPUT_TOKENS_BY_MODEL[model as ImageModel]
    : OUTPUT_TOKENS_BY_MODEL[DEFAULT_IMAGE_MODEL];
  return table[quality][size];
}
/** Input image tokens a reference adds to an edit (measured: 1,024 for 1024², 1,521 for the 2880² guide). */
export const REFERENCE_IMAGE_TOKENS = 1_024;

export const ImageSettingsSchema = z.looseObject({
  model: ImageModelSchema.default(DEFAULT_IMAGE_MODEL),
  quality: ImageQualitySchema.default(DEFAULT_IMAGE_QUALITY),
  budget: z
    .looseObject({
      sessionUsd: z.number().min(0).default(1),
      monthUsd: z.number().min(0).default(10),
    })
    .default({ sessionUsd: 1, monthUsd: 10 }),
  /** Overrides per model; missing models use `DEFAULT_IMAGE_PRICING`. */
  pricing: z.partialRecord(z.string(), TokenPriceSchema).default({}),
  /** The date the pricing table was checked against OpenAI's documentation. */
  pricingVerified: z.string().default(PRICING_VERIFIED),
});
export type ImageSettings = z.infer<typeof ImageSettingsSchema>;

/** `settings.images` with defaults applied; an invalid value falls back to the defaults. */
export function imageSettings(settings: { images?: unknown } | undefined): ImageSettings {
  const r = ImageSettingsSchema.safeParse(settings?.images ?? {});
  return r.success ? r.data : ImageSettingsSchema.parse({});
}

export function priceOf(settings: ImageSettings, model: string): TokenPrice {
  const known = (IMAGE_MODELS as readonly string[]).includes(model)
    ? DEFAULT_IMAGE_PRICING[model as ImageModel]
    : DEFAULT_IMAGE_PRICING[IMAGE_MODELS[0]];
  return settings.pricing[model] ?? known;
}

/** Integer nano-dollars, so budget sums are exact (review-b §1.9). */
export const usdToNanos = (usd: number): number => Math.round(usd * 1e9);
export const nanosToUsd = (n: number): number => n / 1e9;

export interface TokenUsage {
  inputTextTokens?: number | undefined;
  inputImageTokens?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/**
 * The cost of a call from its usage, in nano-dollars. Input tokens without a
 * text/image split count as text, unless `hasReference`, when the part
 * beyond the text estimate counts as image input.
 */
export function costNanos(price: TokenPrice, u: TokenUsage): number {
  const out = u.outputTokens ?? 0;
  let text = u.inputTextTokens;
  let image = u.inputImageTokens;
  if (text === undefined && image === undefined) {
    text = u.inputTokens ?? 0;
    image = 0;
  } else {
    text ??= Math.max(0, (u.inputTokens ?? 0) - (image ?? 0));
    image ??= Math.max(0, (u.inputTokens ?? 0) - text);
  }
  // price per 1M tokens × tokens → USD × 1e6; × 1000 → nanos. Prices with ≤ 3 decimals stay exact.
  return Math.round(
    text * price.textInput * 1000 +
      image * price.imageInput * 1000 +
      out * price.imageOutput * 1000,
  );
}

/** Rough prompt tokens for the estimate: about 4 characters per token, at least 1. */
export const promptTokens = (chars: number): number => Math.max(1, Math.ceil(chars / 4));

export interface EstimateInput {
  model: ImageModel;
  quality: ImageQuality;
  size: ImageSize;
  promptChars?: number | undefined;
  reference?: boolean;
}

/** The estimated cost of one call, in nano-dollars. */
export function estimateNanos(settings: ImageSettings, e: EstimateInput): number {
  return costNanos(priceOf(settings, e.model), {
    inputTextTokens: promptTokens(e.promptChars ?? 600),
    inputImageTokens: e.reference ? REFERENCE_IMAGE_TOKENS : 0,
    outputTokens: outputTokens(e.model, e.quality, e.size),
  });
}

/** The call options with settings applied. */
export function resolveCall(
  settings: ImageSettings,
  kind: ImageKind,
  o: {
    model?: ImageModel | undefined;
    quality?: ImageQuality | undefined;
    size?: ImageSize | undefined;
  },
): { model: ImageModel; quality: ImageQuality; size: ImageSize } {
  return {
    model: o.model ?? settings.model,
    quality: o.quality ?? settings.quality,
    // An explicit size wins (icon sheets ask for SHEET_SIZE); otherwise the kind's default.
    size: o.size ?? DEFAULT_SIZE[kind],
  };
}
