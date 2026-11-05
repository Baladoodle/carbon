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
 * $8, image output $30, for both models (cached input does not apply to the
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
};

/**
 * Image output tokens per image, for the estimate only (a finished call is
 * costed from its reported usage). Low is MEASURED on the 2.6 models
 * (2026-11-05, both flare and sunburst, see docs/build-notes/images-core.md):
 * 824 tokens at 1024×1024 and 664 at 1536×1024; 1024×1536 is assumed equal to
 * 1536×1024. Medium and high are extrapolated from OpenAI's published ratios
 * for the earlier GPT Image models (medium ≈ 3.9× low, high ≈ 15.4× low),
 * and are unmeasured. The sheet size (2880×2880, flare, low, an edit with
 * the guide) measured 2,768 output tokens; its medium and high use the same
 * ratios.
 */
export const OUTPUT_TOKENS: Record<ImageQuality, Record<ImageSize, number>> = {
  low: { '1024x1024': 824, '1024x1536': 664, '1536x1024': 664, '2880x2880': 2768 },
  medium: { '1024x1024': 3199, '1024x1536': 2603, '1536x1024': 2603, '2880x2880': 10746 },
  high: { '1024x1024': 12602, '1024x1536': 10305, '1536x1024': 10305, '2880x2880': 42333 },
};
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
    outputTokens: OUTPUT_TOKENS[e.quality][e.size],
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
