import { z } from 'zod';
import { MOMENTS, type Moment } from '@core/ai/moments';
import { EFFORTS, type Effort } from '@core/prompts/types';
import type { Settings } from '@core/model/world';
import type { Usage } from '@core/ai/gateway';

/**
 * The AI's settings, read from `carbon.json` → `ai` (a loose object, so these
 * keys need no migration). Everything has a default; a world without any of
 * them behaves exactly as documented in docs/SYSTEM.md §8.
 *
 * ```json
 * "ai": {
 *   "budget": { "sessionUsd": 2, "monthUsd": 20 },
 *   "effort": { "spread": "high" },
 *   "maxTokens": { "spec_draft": 12000 },
 *   "pricing": { "claude-haiku-5-5": { "inputPerMTok": 0.1, … } },
 *   "packBudget": 60000,
 *   "debug": false
 * }
 * ```
 */

/** The only model carbon uses. */
export const MODEL = 'claude-haiku-5-5';

export const PriceSchema = z.object({
  /** US dollars per million uncached input tokens. */
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  /** Reading a cached prefix. */
  cacheReadPerMTok: z.number().min(0),
  /** Writing a cache entry (5-minute TTL). */
  cacheWritePerMTok: z.number().min(0),
  /** Prompts whose total input exceeds this are billed at `longContextMultiplier`×. */
  longContextThreshold: z.number().int().min(0),
  longContextMultiplier: z.number().min(1),
});
export type Price = z.infer<typeof PriceSchema>;

/**
 * Haiku 5.5's list prices (Anthropic first-party API). Input and output are
 * $0.10 and $0.50 per million tokens for prompts up to 100k tokens, and 5×
 * above that. Cache reads and 5-minute cache writes use the standard prompt
 * caching multipliers: 0.1× and 1.25× the input price. Check
 * https://www.anthropic.com/pricing before relying on them; override any of
 * them in `carbon.json` → `ai.pricing`.
 */
const HAIKU_PRICE: Price = {
  inputPerMTok: 0.1,
  outputPerMTok: 0.5,
  cacheReadPerMTok: 0.01,
  cacheWritePerMTok: 0.125,
  longContextThreshold: 100_000,
  longContextMultiplier: 5,
};
export const DEFAULT_PRICING: Record<string, Price> = { [MODEL]: HAIKU_PRICE };

const EffortSchema = z.enum(EFFORTS);

export const AiSettingsSchema = z.looseObject({
  budget: z
    .looseObject({
      sessionUsd: z.number().min(0).default(2),
      monthUsd: z.number().min(0).default(20),
    })
    .default({ sessionUsd: 2, monthUsd: 20 }),
  effort: z.partialRecord(z.enum(MOMENTS), EffortSchema).default({}),
  maxTokens: z.partialRecord(z.enum(MOMENTS), z.number().int().min(256).max(64_000)).default({}),
  pricing: z.record(z.string(), PriceSchema.partial()).default({}),
  /** Default packer budget (tokens); clamped to the hard limit. */
  packBudget: z.number().int().min(1_000).max(95_000).default(60_000),
  /** Write the full request text into the JSONL log. */
  debug: z.boolean().default(false),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** The AI settings of a world, with defaults; invalid values fall back to defaults. */
export function aiSettings(settings: Settings): AiSettings {
  const parsed = AiSettingsSchema.safeParse(settings.ai);
  return parsed.success ? parsed.data : AiSettingsSchema.parse({});
}

export function priceFor(settings: AiSettings, model: string): Price {
  const base = DEFAULT_PRICING[model] ?? HAIKU_PRICE;
  return { ...base, ...settings.pricing[model] };
}

export function effortFor(settings: AiSettings, moment: Moment): Effort | undefined {
  return settings.effort[moment];
}

/** Cost in US dollars of one call's usage. */
export function costOf(usage: Usage, price: Price): number {
  const totalInput = usage.input + usage.cacheRead + usage.cacheWrite;
  const mult = totalInput > price.longContextThreshold ? price.longContextMultiplier : 1;
  const usd =
    (usage.input * price.inputPerMTok +
      usage.output * price.outputPerMTok +
      usage.cacheRead * price.cacheReadPerMTok +
      usage.cacheWrite * price.cacheWritePerMTok) /
    1_000_000;
  return usd * mult;
}
