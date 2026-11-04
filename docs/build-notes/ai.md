# Build notes: `ai` (W4)

Branch `claude/blissful-einstein-8u27ty-ai`. Work in progress; this file is
updated with every push.

## 1. The contract for other packages

### 1.1 Context packer (`src/core/context/`)

Pure, deterministic and property-tested.

```ts
import { packContext, rankEntities, renderFull, renderSummary, renderDigest, renderTaste,
         estimateTokens, clipToTokens, defaultPlacement, type Focus } from '@core/context';

const packed = packContext(world, { entities: ['glide'] /* or [] */, band: 'low-sky', lane: 'items' }, {
  budget: 60_000,          // default 60k; clamped to HARD_LIMIT = 95k
  reserved: 1_200,         // tokens your own instructions/ask will take (subtracted)
  taste: { ruleIds, withoutRules },   // a spread's rule switches; the wildcard has no rules
  fullTiers: [0, 1],       // tiers rendered in full when they fit (default: relations + same cell)
});
// packed.digest, packed.taste, packed.focus, packed.neighbours: strings
// packed.included [{ id, tier, rendering: 'full' | 'summary' }], packed.omitted, packed.tokens
```

- **Relevance tiers:** 0 a direct relation in either direction (relations, ref
  fields, route `needs`), 1 the same cell (band and lane), 2 the same band, 3
  the same kind, 4 the rest. Ties go to the most recently updated, then to the id.
- **Guarantees:** `tokens.total <= budget`; the same input gives byte-identical
  output; entities come in relevance order; nothing is rendered twice.
- **Placement:** `src/core/context/placement.ts` is an **adapter**. It uses
  only explicit placement (the band itself, `biome.band`, `in_band` and
  `in_biome`), plus `found_in` and `lives_in` targets, marked inferred. When
  W2's `resolvePlacement` merges, `defaultPlacement` is the one line to change.
- **Tokens** are estimated locally at 2.8 characters per token plus 4 per block.
  That's conservative for Haiku 5.5's tokenizer. The gateway calls
  `count_tokens` near the limit.

### 1.2 Prompt builders (`src/core/prompts/`)

```ts
interface PromptBuilder<M extends Moment> {
  moment: M;
  defaults: { effort: Effort; maxTokens: number; stream: boolean };
  build(world, request /* parsed by MOMENT_SCHEMAS */, options?): Result<BuiltPrompt>;   // errors: not_found | bad_request
  parse(rawJson, world, request): Result<{ result: MomentResult<M>; dropped: number }>;  // validate against the world, drop + count invalid items
  stream?: { arrayKey: 'candidates'; item(raw, index, world, request): MomentPartial<M> | null };  // streamed items
}
```

- `BuiltPrompt` is provider-neutral: `system: PromptBlock[]`, `user:
  PromptBlock[]` (each `{ label, text, cache? }`, where `cache: true` puts a
  breakpoint after the block, at most 4), a JSON Schema for structured
  outputs, `effort`, `maxTokens`, `stream`, `entity` (the entity it's about),
  `estimate` and the packer stats. The gateway maps it to the Messages API.
- **Build with `assemble()`** from `src/core/prompts/common.ts`. It packs the
  context and lays the prompt out as `role · digest⟂ · taste⟂ · instructions⟂ |
  focus · ask` (⟂ = cache breakpoint), so every moment shares the cached
  prefix.
- **JSON Schema helpers** (`schema.ts`): `obj`, `arr`, `str`, `num`, `bool`,
  `enumOf`, `nullable`, `fieldJsonSchema(world, def)`, `validFieldValue(world,
  field, value)`, `duplicatesName(world, name)`. Every object is
  `additionalProperties: false` with all keys required; optional values are
  `anyOf [T, null]`.
- **Registering (W5):** export your builders from your own folder and add
  **one line** to `PACKAGE_BUILDERS` in `src/core/prompts/registry.ts`:
  `...spreadPromptBuilders,`. A package builder replaces the built-in one for
  its moment. W4 ships simple **fallback** `spread` and `patterns` builders
  (`fallback-spread.ts`), so the streaming path, the evals and the smoke test
  work before W5 merges. W5's replace them.
- **Streaming:** `JsonArrayStreamer(arrayKey)` (`stream.ts`) yields each
  complete item of a top-level array as its closing brace arrives. The gateway
  passes each item through `builder.stream.item(...)` and calls `onPartial` with
  the ones that validate.
