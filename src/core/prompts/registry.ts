import { MOMENTS, type Moment } from '../ai/moments';
import { critiqueBuilder } from './critique';
import { fallbackPatternsBuilder, fallbackSpreadBuilder } from './fallback-spread';
import { fillBuilder } from './fill';
import { specBuilder } from './spec';
import { suggestOneBuilder, suggestThreeBuilder } from './suggest';
import type { PromptBuilder } from './types';

/**
 * The prompt-builder registry: one builder per AI moment. The real gateway
 * (`src/main/ai`) looks builders up here; nothing else builds prompts.
 *
 * ── For other packages (W5: `spread`, `patterns`) ─────────────────────────
 * Export your builders from your own folder, e.g.
 *
 *   // src/core/spreads/prompts.ts
 *   export const spreadPromptBuilders: PromptBuilder[] = [spreadBuilder, patternsBuilder];
 *
 * and add ONE line to `PACKAGE_BUILDERS` below: `...spreadPromptBuilders,`.
 * A package builder replaces the built-in builder for its moment. Build your
 * prompt with `assemble()` from `./common` so it shares the cached layout, and
 * pack context with `packContext()` from `src/core/context`.
 */

/** Builders owned by W4 (`ai`), plus fallbacks for `spread` and `patterns`. */
export const BUILTIN_BUILDERS: readonly PromptBuilder[] = [
  suggestOneBuilder,
  suggestThreeBuilder,
  fillBuilder,
  critiqueBuilder,
  specBuilder,
  fallbackSpreadBuilder,
  fallbackPatternsBuilder,
] as PromptBuilder[];

/** Builders registered by other packages; each replaces the built-in one for its moment. */
export const PACKAGE_BUILDERS: readonly PromptBuilder[] = [];

export class PromptRegistry {
  private readonly builders = new Map<Moment, PromptBuilder>();

  /** Registers a builder. A builder for a moment that already has one replaces it. */
  register(builder: PromptBuilder): this {
    this.builders.set(builder.moment, builder);
    return this;
  }

  get<M extends Moment>(moment: M): PromptBuilder<M> | undefined {
    return this.builders.get(moment) as PromptBuilder<M> | undefined;
  }

  has(moment: Moment): boolean {
    return this.builders.has(moment);
  }

  /** Moments with no builder (should be empty). */
  missing(): Moment[] {
    return MOMENTS.filter((m) => !this.builders.has(m));
  }
}

/** A registry with the built-in builders, then every package's. */
export function createPromptRegistry(extra: readonly PromptBuilder[] = []): PromptRegistry {
  const r = new PromptRegistry();
  for (const b of [...BUILTIN_BUILDERS, ...PACKAGE_BUILDERS, ...extra]) r.register(b);
  return r;
}
