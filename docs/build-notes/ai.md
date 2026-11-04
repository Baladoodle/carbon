# Build notes: `ai` (W4)

Branch `claude/blissful-einstein-8u27ty-ai`. Everything in the W4 row of
`BUILD.md` §5 is built, and `npm run check` passes.

- **The contract for other packages:** §1. W5 should read §1.2; W1 and W6
  should read §1.4.
- **What was built:** §2.
- **Decisions:** §3.
- **Changes to shared contracts:** §4. All of them are additive.
- **Known gaps:** §5.
- **Tests, evals and API spend:** §6. API spend was **$0.00**, because
  `ANTHROPIC_API_KEY` isn't set here.

---

## 1. The contract

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
- **Budget split:** the digest may take 30% of the budget, then shrinks
  through 4 levels of detail. Taste may take 12% and focus 30%; both are
  clipped beyond that. Neighbours get what's left, full or summary.
- **Placement:** `src/core/context/placement.ts` is an **adapter**. It uses
  only explicit placement (the band itself, `biome.band`, `in_band` and
  `in_biome`), plus `found_in` and `lives_in` targets, marked inferred. When
  W2's `resolvePlacement` merges, `defaultPlacement` is the one line to change.
- **Tokens** are estimated locally at 2.8 characters per token plus 4 per
  block. That's conservative for Haiku 5.5's tokenizer, which counts about 30%
  more tokens than older ones. The gateway calls `count_tokens` above 80k (§1.3).

### 1.2 Prompt builders (`src/core/prompts/`)

```ts
interface PromptBuilder<M extends Moment> {
  moment: M;
  defaults: { effort: Effort; maxTokens: number; stream: boolean };
  build(world, request /* parsed by MOMENT_SCHEMAS */, options?): Result<BuiltPrompt>;   // errors: not_found | bad_request
  parse(rawJson, world, request): Result<{ result: MomentResult<M>; dropped: number }>;  // validate against the world, drop + count invalid items
  stream?: { arrayKey: 'candidates'; item(raw, index, world, request): MomentPartial<M> | null };  // streamed items
}
type AnyPromptBuilder = { [K in Moment]: PromptBuilder<K> }[Moment];  // what the registry holds
```

- `BuiltPrompt` is provider-neutral: `system: PromptBlock[]`, `user:
  PromptBlock[]` (each `{ label, text, cache? }`, where `cache: true` puts a
  breakpoint after the block, at most 4), a JSON Schema for structured
  outputs, `effort`, `maxTokens`, `stream`, `entity` (the entity it's about),
  `estimate` and the packer stats. The gateway maps it to the Messages API.
- **Build with `assemble()`** from `src/core/prompts/common.ts`. It packs the
  context and lays the prompt out as `role · digest⟂ · taste⟂ · instructions⟂ |
  focus · ask` (⟂ = cache breakpoint). Every moment shares the cached prefix
  `role · digest · taste`; only the moment's instructions and the user turn
  differ.
- **JSON Schema helpers** (`schema.ts`): `obj`, `arr`, `str`, `num`, `bool`,
  `enumOf`, `nullable`, `fieldJsonSchema(world, def)`, `validFieldValue(world,
  field, value)`, `writableField(world, kind, key)` and `duplicatesName(world,
  name)`. Every object is `additionalProperties: false` with all its keys
  required. Optional values are `anyOf [T, null]`. There are no numeric or
  length constraints, because zod checks those afterwards. `prompts.test.ts`
  asserts this for every moment's schema.
- **Registering (W5):** export your builders (typed `AnyPromptBuilder[]`) from
  your own folder and add **one line** to `PACKAGE_BUILDERS` in
  `src/core/prompts/registry.ts`: `...spreadPromptBuilders,`. A package builder
  replaces the built-in one for its moment. W4 ships simple **fallback**
  `spread` and `patterns` builders (`fallback-spread.ts`), so streaming, the
  evals and the dry runs work before W5 merges. W5's builders replace them.
- **Streaming:** `JsonArrayStreamer(arrayKey)` (`stream.ts`) yields each
  complete item of a top-level array as soon as its closing brace arrives. The
  gateway passes each item through `builder.stream.item(...)` and calls
  `onPartial` with the ones that validate. A property test checks it against
  arbitrary splits of the text.

### 1.3 The gateway (`src/main/ai/`)

`createAiGateway(getWorld)` (`index.ts`) chooses one of these:

| `CARBON_AI` | Gateway |
|---|---|
| `fake` | `FakeAiGateway` (foundation; `CARBON_AI_DELAY_MS`) |
| `off` | off |
| `replay` | **the real `ClaudeAiGateway`** over an offline API (`replay.ts`). Recorded fixtures from `CARBON_AI_FIXTURES` are matched by request hash; anything else gets answers generated from each request's own JSON schema, with emulated prompt caching. Used by `e2e/ai.spec.ts` |
| anything else | `ClaudeAiGateway` over the SDK if `ANTHROPIC_API_KEY` is set, otherwise off ("No API key: …") |

`ClaudeAiGateway.run` goes through these steps (`gateway.ts`):

1. Validate the request with `MOMENT_SCHEMAS`.
2. Check the off switch and the budget pause.
3. Build the prompt with the registry's builder (`effort`, `maxTokens` and
   `packBudget` come from settings).
4. Check the token limit. If the local estimate is above 80k, call
   `count_tokens`. A count of 95k or more triggers one re-pack at a smaller
   budget. A count of 100k or more is refused as `too_large`.
5. Look up the content-hash cache (`hashValue({ moment, params })`). A hit
   replays a spread's candidates through `onPartial`.
6. One request per entity: a new one aborts the stale one.
7. Call the API (§1.3a).
8. Check `stop_reason`, then `JSON.parse`, then `builder.parse`, then the
   moment's zod schema.
9. Log the call and add its cost.

**§1.3a The call.** It's made with `client.messages.create`, or with
`client.messages.stream` (parsing incrementally) for streamed moments.
Retries are typed and the SDK's own retries are off.

**Request shape** (`request.ts`, typed against the SDK's own
`MessageCreateParamsNonStreaming`):

- `model: 'claude-haiku-5-5'`
- `max_tokens`
- `system` as text blocks with `cache_control: { type: 'ephemeral' }` after
  the digest, the taste and the instructions
- one `user` message with the focus and the ask
- `output_config: { effort, format: { type: 'json_schema', schema } }`
- **no** `temperature`, `top_p`, `top_k` or `thinking`, and **no** assistant
  prefill

Adaptive thinking is the model's default. The contract tests in
`gateway.test.ts` check all of this for every moment.

**Effort per moment** (defaults; override with `carbon.json` →
`ai.effort.<moment>`):

| Moments | Effort |
|---|---|
| `suggest_one`, `suggest_three`, `fill_entity`, `critique` | `low` |
| `spread`, `spec_draft`, `patterns` | `medium` |

**Errors** (`errors.ts`), mapped from the SDK's typed classes, most specific
first:

| Error | Code | Retried |
|---|---|---|
| `RateLimitError` | `rate_limited` | yes, honouring `retry-after` |
| `AuthenticationError` (401), `PermissionDeniedError` (403) | `no_key` | no |
| `BadRequestError` (400), 404, 422 | `bad_request` | no |
| `InternalServerError` (5xx, including 529) | `server` | yes |
| `APIConnectionTimeoutError`, `APIConnectionError` | `network` | yes |
| 413 | `too_large` | no |
| 408, 409 | `server` | yes |
| `APIUserAbortError`, or an aborted signal | `cancelled` | no |

Retries make 4 attempts in total, with exponential backoff and full jitter
(500 ms base, 8 s cap). A stream that has already shown candidates is never
retried, because retrying would show them twice.

**`stop_reason`:**

| Value | Code |
|---|---|
| `refusal` | `refused` |
| `max_tokens` | `truncated` |
| `model_context_window_exceeded` | `too_large` |

Each of these is still costed and logged.

**Budget:** the spend for the session, and the month (loaded from this
month's JSONL files), is checked against `carbon.json` → `ai.budget`. At the
limit, status is `paused` with a reason, and runs fail with `budget`. Raising
the budget (`settings.set`) unpauses it: the `ai` main module calls
`refresh()` on every settings patch.

**Log:** each call writes a line to `<world>/ai-log/<YYYY-MM-DD>.jsonl` holding
the moment, entity, trigger, outcome, error, usage, cost, latency, attempts,
`stopReason`, estimate, exact count, results and dropped. With `ai.debug` the
line also holds the full request params. The request text of this session's
calls is served over `ai:request` for the AI log.

**Settings** (`settings.ts`, `carbon.json` → `ai`, all optional):

| Key | Default |
|---|---|
| `budget` | `{ sessionUsd: 2, monthUsd: 20 }` |
| `effort` | per moment, as above |
| `maxTokens` | per moment |
| `pricing` | per model |
| `packBudget` | 60000 |
| `debug` | false |

**The pricing table** (`DEFAULT_PRICING`, per million tokens):

| | Price |
|---|---|
| Input | $0.10 |
| Output | $0.50 |
| Cache read | $0.01 (0.1× input) |
| Cache write, 5 minutes | $0.125 (1.25× input) |
| Prompts over 100k tokens | 5× all of the above |

### 1.4 Renderer (`src/renderer/ai/`)

For W1's Bench and W6's Export, use `src/renderer/ai/moments.ts`. It builds in
one request per entity, so the UI never shows a stale answer:

```ts
import { suggest, suggestThree, fill, critique, cancelFor } from '@renderer/ai/moments';
const out = await suggest(entityId, 'tradeoff', alreadyShown);   // tab;      out.ok → out.result.suggestion.value
const out = await suggestThree(entityId, 'name');                // shift+tab
const out = await fill(entityId);                                // ctrl+enter; out.result.proposals [{ field, value, note? }]
await critique(entityId, 'on_demand');                           // publishes notes as `ai:<entityId>` (Column margin, Bench, status line)
```

Accepting a value is a command: `cmd('entity.setField', { id, field, value,
source: 'ai' })`.

**Critique triggers are already wired** (`triggers.ts`, mounted with the
status line):

- focus leaves an entity whose `updated` changed while it was on the Bench
  (`finish_edit`)
- `ctrl+s` (`finish_edit`)
- any state change made in carbon (`state_change`); not into the graveyard,
  and not on load
- `?` (`on_demand`, which shows a toast when there are no notes)

The automatic triggers stay quiet while the AI is off or paused. **W1 doesn't
need to call critique for these.**

**The AI log** (`AiLog.tsx`, `ctrl+l`):

- Moment tabs, shown only when more than one moment is present.
- Totals: cost, calls, cached hits and the cache read rate.
- Columns: time, moment (with the trigger), entity, result (count and number
  dropped, or the error code), input, cache read, output, cost and ms.
- `j`/`k` (or ↑/↓) move the cursor and `enter` opens the request that was sent.
- `escape` closes the request, then the log.
- It's drawn in `--ai` only; errors use `--danger`.

**The status line** (`AiStatus.tsx`, which keeps `data-testid="status-ai"`):

| State | Shows | `data-state` |
|---|---|---|
| Normal | `$0.42 / $2.00` in `--ai`, with a glowing dot while pending. The tooltip has the month spend and the model | `idle` / `pending` |
| Paused | `AI paused: Session budget of $2.00 reached` in `--warn`; click it to open the budget dialog | `paused` |
| Off | `AI off: <reason>` | `off` |

The palette has "Set the AI budget".

---

## 2. What was built

- **Context packer** with relevance ranking, a token budget, full and summary
  renderings, a degrading digest, taste rendering (rule switches and a version
  without rules for the wildcard) and the placement adapter.
- **Prompt builders** for `suggest_one`, `suggest_three`, `fill_entity`,
  `critique` and `spec_draft`, plus fallback `spread` and `patterns` builders.
  Each one builds a schema from the kind schema (enum options, ref targets as
  enums when there are 200 or fewer, steps, climate…) and validates the output
  against the world:
  - field values go through the field's zod schema
  - refs and route `needs` must exist
  - suggested names must not duplicate existing names
  - a suggestion must not repeat a shown or current value
  - critique notes need existing `entities` and `ruleId`s, `rule_clash` needs
    a rule, `duplicate` needs the other entity, and there's one note per kind
  - spread relations must obey the relation-type rules, and there's exactly
    one wildcard
  
  Everything invalid is dropped and counted in `meta.dropped`.
- **The real gateway** as in §1.3, with the JSONL log, the result cache,
  pricing, the budget, the off switch and cancellation.
- **`replay` mode:** the real gateway, fully offline, in the app and the evals.
- **Renderer:** the AI log overlay, the status-line pieces, the budget
  dialog, the critique triggers, and moment helpers for the Bench.
- **Evals** (`src/main/ai/evals/`, with data in `evals/`):
  - **The world:** `evals/worlds/flawed/`, generated from `evalWorld()`, is the
    sample world plus 5 seeded flaws:
    - **pure number:** Brass Band, "+10% damage"
    - **duplicate:** Lumen Spores, a copy of Lumen Spore
    - **rule break:** Mending Draught, free full healing against the rule
      `no-free-healing`
    - **dangling relation:** Frost Wisp, `lives_in` a biome that doesn't exist
    - **contradicted relation:** Magma Eel, a lava eel that `lives_in` a sky reef
    
    It also has 4 clean controls: Updraft Kite, Lantern Moth, Echo Reading and
    Heat Glass.
  - **The cases:** 21, covering every moment.
  - **The metrics** from SYSTEM §8, with thresholds:
    - schema validity 100%
    - references resolve 100%
    - no duplicate names ≥ 95%
    - critique recall on seeded flaws ≥ 0.9
    - critique precision on clean entities ≥ 0.8
    - spread diversity: mean pairwise name overlap < 0.15 and identity/verb
      overlap < 0.3, on the worst spread
    - largest request < 100k tokens, with the cache read rate reported
    
    They're computed on the **raw** model output, before the gateway drops
    anything, so filtering can't flatter them.
  - **The report:** markdown and JSON in `evals/reports/`, plus
    `latest-<mode>.md`.
  - **The modes:**

    | Command | What it does |
    |---|---|
    | `npm run eval` | live |
    | `npm run eval -- --record` | live, and saves fixtures to `evals/fixtures/recorded/` |
    | `npm run eval -- --replay` | offline, from the recordings |
    | `npm run eval -- --dry` | offline, checks the pipeline only |

    `--only <substring>` filters the cases, and `--max-usd <n>` sets the spend
    cap (default $1). A live run fails (exit 1) if any metric misses its target.
  - **Recording:** request headers, where the key lives, are never captured.
    Every fixture is also scanned for `sk-ant-…` and for the actual key value
    before it's written, and refused if either is found.
- **`npm run smoke:ai`** makes two real critiques through `ClaudeAiGateway`
  and prints the outcome, usage, cost, and the cache read on the second call.
  Without a key, it and `npm run eval` print a clear message and exit 0.

## 3. Decisions

1. **The order is `role · digest · taste · instructions`, not SYSTEM §8's
   "role and the moment's instructions" first.** Putting the static per-moment
   instructions after the slow-changing world parts makes the cached prefix
   (`role · digest · taste`) shared by **every** moment. The instructions get
   their own breakpoint. That uses 3 of the 4 breakpoints.
2. **Requests are canonical for the cache.** The cache key is the hash of the
   exact SDK params, so any change to the entity, its neighbourhood, the
   digest or the taste is a new key. The cache is in memory for the session
   (LRU, 500 entries). It isn't persisted, because spend is the concern and a
   restart rarely re-asks the same thing.
3. **Effort:** `low` for `fill_entity` too, because it's a per-field
   suggestion. `medium` for `patterns`. All of it is configurable.
4. **`max_tokens` per moment:**

   | Moment | `max_tokens` |
   |---|---|
   | `suggest_one` | 4k |
   | `suggest_three`, `critique` | 6k |
   | `patterns` | 8k |
   | `fill_entity` | 12k |
   | `spec_draft` | 16k |
   | `spread` (streamed) | 32k |

   Thinking counts towards it. Non-streamed moments stay at 16k or below, so
   the SDK's non-streaming timeout guard doesn't fire.
5. **Fill has nothing to fill:** when an entity has no empty fields, it
   returns `bad_request` with a clear message rather than calling the API.
6. **Retries are the gateway's, not the SDK's** (`maxRetries: 0`), so they're
   typed, abortable, visible in the log (`attempts`) and testable with an
   instant clock.
7. **`count_tokens` failing is not fatal.** The local estimate is
   conservative, so the call goes ahead on it.
8. **One request per entity.** The gateway keys in-flight requests by entity,
   following EXPERIENCE §5 ("one request at a time per entity"), across
   moments. A critique triggered on leaving an entity can't collide with a
   suggestion for it, because the user has moved away.
9. **Critique precision over recall in the prompt.** The instructions tell
   the model to return nothing for a sound entity and to raise at most one
   note per kind, because the designer reads every note. The parser enforces
   one note per kind as well.
10. **The status line follows VISUAL over EXPERIENCE**, as foundation did. It
    shows spend against budget (`$0.42 / $2.00`) because that changes what
    you do. The month spend and the model go in the tooltip.
11. **Pricing for cache reads and writes** uses the standard multipliers
    (0.1× and 1.25× input). The task's API facts gave only the input and
    output prices, so these are documented as overridable in settings.
12. **The eval library lives in `src/main/ai/evals/`, not `evals/`.** That way
    it's typechecked, linted and unit-tested by the normal config. `evals/`
    holds the data (worlds, recordings, reports) and the runner's Vitest
    config. The live runner files are named `*.eval.ts`, so `npm test` never
    calls the API.
13. **Spread and patterns fallback builders.** These moments are W5's, but
    the gateway, the streaming path and the diversity metric needed a builder
    to exist. They're deliberately simple, and W5's builders replace them
    through the registry (§1.2).
14. **The flawed eval world** is generated from code and checked against
    `evals/worlds/flawed/` by a test, like foundation's sample world.
    Regenerate it with `UPDATE_FIXTURES=1 npx vitest run src/main/ai/evals`.

## 4. Changes to shared contracts (all additive)

| File | Change |
|---|---|
| `src/core/ai/gateway.ts` | `AI_ERROR_CODES` gained `refused` and `truncated`. `AiLogEntrySchema` gained optional `trigger`, `attempts`, `stopReason`, `estimate` and `counted` |
| `src/shared/ipc.ts` | New channel `ai:request` (`{ id }` → `{ text, params }` or `null`) |
| `src/renderer/shell/StatusLine.tsx` (foundation) | The AI `<span>` was replaced by `<AiStatus />`, which keeps `data-testid="status-ai"` and `data-mode` and adds `data-state` |
| `e2e/smoke.spec.ts` (foundation) | The fake-AI status expectation is now `'$0.00 / $2.00'` (spend against budget) |
| `scripts/eval.mjs`, `scripts/smoke-ai.mjs` | Rewritten as foundation invited ("W4 makes it run evals/", "W4 may route it through the real gateway") |
| `src/main/ai/module.ts` | Uses `import type { MainModule }` and a plain object, not `defineMainModule(...)` |

**A foundation bug for every package with a main module:**
`src/main/modules.ts` loads `./*/module.ts` with an eager `import.meta.glob`.
That runs **before** `modules.ts` defines `defineMainModule`, so a module that
calls `defineMainModule(...)` at import time crashes with "defineMainModule is
not a function". I worked around it in my module rather than editing
`modules.ts`. W6 (store) and anyone else adding a module should do the same,
or the coordinator can move `defineMainModule` into its own file.

## 5. Known gaps

- **No real API run yet** (§6). The prompts are written carefully and the
  pipeline is tested end to end offline, but recall, precision and diversity
  against Haiku 5.5 are unmeasured until someone runs `npm run eval` with a
  key. Then run `npm run eval -- --record` to save fixtures, so `--replay`
  becomes a meaningful offline regression check.
- **The system keyring** (SYSTEM §10) isn't read; the key comes only from
  `ANTHROPIC_API_KEY`.
- **Placement is the adapter (§1.1)** until W2's resolver merges.
- **Results aren't persisted:** the result cache and the "open the request"
  text last for the session. Older calls show the log line only, unless
  `ai.debug` was on, in which case the JSONL holds the full request.
- **Fallback builders drop invalid relations silently:** the fallback spread
  builder removes invalid relations from otherwise valid candidates without
  counting them in `dropped`. W5's builder should decide that.
- **Bench integration is W1's:** suggestions in fields (`tab` / `shift+tab`),
  fill proposals (`ctrl+enter`) and the `ai` markers are Bench UX. They call
  `src/renderer/ai/moments.ts`. Spread UX is W5's.
- **Other packages are untested against the merged app:** the e2e specs focus
  entities through the palette (foundation's stub). Once W6's palette and W1's
  Bench land, the coordinator should re-run `e2e/ai.spec.ts`.

## 6. Tests, evals and API spend

- **Vitest:** 165 tests in 20 files overall, `npm test`. W4's share is about
  115 tests in 9 files:

  | File | Covers |
  |---|---|
  | `packer.test.ts` | Unit and property tests: the budget is never exceeded for any world, focus, budget and reserve; the ranking is a deterministic total order regardless of key order; output is byte-identical for the same input; the relevance order holds; the hard-limit clamp |
  | `prompts.test.ts` | Every moment's schema is strict, the cache layout and determinism, parse and drop rules, a stream-splitting property test |
  | `gateway.test.ts` | 29 tests over SDK-shaped HTTP fixtures driving the **real SDK**: per-moment request-shape contract tests; a shared cached prefix across moments; the cost of `cache_read_input_tokens`; the content-hash cache; dropped counts; 429 with `retry-after`; 5xx/529 backoff; connection errors; no retry on 400; 401 and 413; refusal; `max_tokens` truncation; invalid JSON; streaming with incremental validated partials; cached spread replay; no retry after partials; per-entity cancellation; `AbortSignal`; the off switch; the budget pause and resume; `count_tokens` with a re-pack, a refusal over 100k, and a fallback when counting fails |
  | `replay.test.ts` | The offline API |
  | `errors.test.ts` | Error classification, backoff, pricing, settings, the LRU cache |
  | `evals.test.ts` | Metrics, the report, a dry runner, record → replay, the credential refusal, SSE reconstruction, the world fixture |
  | `ai.test.ts` (renderer) | Log totals, critique notes |
- **Core coverage:** about 97% of lines overall. `context/` is 95% of lines and
  `prompts/` is 99%.
- **Playwright:** `e2e/ai.spec.ts` has 8 tests, 2 tagged `@smoke`. They run
  the real gateway in the app via `CARBON_AI=replay`:
  - critique with `?`, the AI log, the request pane, and the JSONL on disk
  - the off switch
  - the content-hash cache
  - `finish_edit` and `state_change` triggers
  - spread streaming over IPC
  - the log across moments
  - the budget pause, the dialog and resuming
  - the no-key off state
- **Screenshots:** `docs/screens/ai-log.png`, `ai-log-request.png`,
  `ai-budget.png` and `ai-status.png`.
- **Eval status:** a dry run passes end to end; `evals/reports/latest-dry.md`
  has 21 cases with a cache read rate of about 50% under emulated caching. Its
  quality metrics are meaningless by design. **No live eval has run.**
- **API spend: $0.00.** `ANTHROPIC_API_KEY` is **not set** in this container
  (checked by name only, never printed), so no real call was made. On your
  machine:
  1. `npm run smoke:ai` costs well under $0.01.
  2. `npm run eval -- --record` runs 21 cases and should cost about $0.01–0.03
     at Haiku 5.5's prices. It's capped at $1 by `--max-usd`.
  3. Commit `evals/fixtures/recorded/`.
