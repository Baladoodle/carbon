# Build notes: `review-b` (Phase 3, hardening)

Branch `claude/blissful-einstein-8u27ty-review-b`, from
`claude/blissful-einstein-8u27ty` at `829c669`. Main didn't move during the
review, so no rebase was needed. Scope: **numbers** (W3) and **ai** (W4):
`src/core/numbers/`, `src/renderer/views/numbers/`, `src/main/ai/`,
`src/core/context/`, `src/core/prompts/`, `src/core/ai/`,
`src/renderer/ai/`, `evals/`, `scripts/eval.mjs`, `scripts/smoke-ai.mjs`,
and their e2e specs.

**API spend: $0.00.** No key is available in the container (checked by name
only). The bad-key path was exercised once against the real endpoint with an
obviously fake key; it was a 401, which costs nothing.

- **Defects found and fixed, each with its test:** §1
- **Gaps filled (integrate §10):** §2
- **Measurements:** §3
- **Decisions:** §4
- **Shared files touched:** §5
- **Out of scope (for the coordinator):** §6
- **Still open:** §7

---

## 1. Defects found and fixed

Each one was first shown by a failing test. No test was weakened, skipped
or deleted.

### Numbers (the expression language)

1. **Deep nesting crashed the parser and the whole analysis with a stack
   overflow.** At about 10,000 levels of `(`, `-`, `not`, `[`, nested calls,
   a long `1 + 1 + …` or a long `.a.a.a` chain, it threw `RangeError`. That
   breaks the parser's "never throws" contract: the Numbers view and the
   main process's checks would both throw on such a file.
   - **Fix:** `MAX_DEPTH = 256` in the parser, on both its recursion and the
     depth of the AST it builds (left-associative chains too). Past it, the
     line gets one precise `parse.depth` error. Every recursive pass after
     the parser (checker, evaluator, printer, rename) is bounded by it.
   - **Tests:** `hardening.test.ts` › "deep nesting never overflows the
     stack" (8 shapes at 20,000 levels, plus a test that nesting just under
     the limit still evaluates).
2. **A long chain of function calls overflowed at evaluation.** For example,
   `f9999(x) = f9998(x) + 1 …`.
   - **Fix:** `MAX_EVAL_DEPTH = 1000` nested evaluations, then
     `eval.depth`, reported at the outermost call in the definition. Other
     definitions are unaffected.
   - **Test:** "a long chain of function calls stops with an error".
3. **A chain of definitions written callers-first overflowed the type
   checker.** `ensure` recursed once per link (20,000 links).
   - **Fix:** the checker visits definitions dependencies-first (a
     syntactic Tarjan order via `buildGraph`, which is iterative). Results
     are identical, and the golden suites are unchanged.
   - **Tests:** "a long chain of constants/functions defined in reverse
     order".
4. **The step limit bounded nodes, not time.**
   `count(entities where count(entities where count(entities) > 0) > 0)`
   over 2,000 entities took **27 s**: each `entities` rebuilt and sorted
   the whole collection for one step. `contains` over a big list and list
   `==` had the same problem.
   - **Fix:** building a collection, scanning a list, and comparing lists
     now charge steps for their size. Collections are built once per
     evaluation. The same query now stops at the limit in milliseconds.
   - **Tests:** the "step limit bounds time" block (four queries, each under
     1.5 s and ending in `eval.steps`), and a property: for random programs
     and limits, steps never exceed the limit plus one collection.
5. **`min`/`max` over a long list overflowed the argument stack**
   (`Math.max(...xs)`). Fixed with a loop. Test: `max([…200,000 values])`.
6. **Diagnostic spans could split a character.**
   - An emoji gave two `lex.char` errors, one per UTF-16 half, each with a
     lone surrogate in its message. An escaped astral character had the same
     problem.
   - A line with a lexer error also got a misleading parse error ("x has no
     value"), because unknown characters leave no token.
   - **Fix:** a run of unknown characters is one error over whole code
     points; escapes take whole characters; the "one error per line" check
     looks at the whole line.
   - A non-ASCII letter in a name now says how names are written. The
     decision was to keep names ASCII, as `variables.json` names are; §4.
   - **Tests:** the "unicode" block, and a property over arbitrary binary
     strings: every span is drawable and no message carries half a
     character.
7. **An error inside a function called from a curve had a span in the wrong
   source.** It pointed into `formulas.carbon`, but the curve's `y` is its
   own text.
   - **Fix:** in a standalone expression, an error from a called function is
     reported at the call, in that expression.
   - **Test:** "an error inside a function a curve calls is reported at the
     call".

### AI

8. **Requests could go far over 100k tokens.** A single `suggest_one` on a
   world with large non-ASCII text came to about **1.5M tokens** by a
   pessimistic bound. There were three causes:
   - The local estimate counted every character at 2.8 per token, so emoji
     and CJK (several tokens each) were undercounted by up to 4×.
   - The output JSON schema, which is billed as input, wasn't counted at
     all.
   - The "ask" text was unbounded: the current value, "already shown"
     values, a spread's judgements.

   **Fix:**
   - ASCII still counts at 2.8 characters per token; anything else counts
     at its UTF-8 byte length, a true upper bound for a byte-level
     tokenizer.
   - `clipToTokens` never cuts a character.
   - The schema is counted in each prompt's estimate and in the packer's
     reserve.
   - `assemble` caps the ask at `ASK_LIMIT` (15k tokens), keeping its final
     instruction paragraph.

   **Test:** `prompts/limits.test.ts`. It builds every moment over huge
   worlds (up to 2,500 entities, 300k-character emoji, CJK and accented
   fields, 2,000 taste rules, 500 patterns, 300 "already shown" values, 400
   spec entities), at pack budgets of 60k and 95k. Each request must stay
   **≤ 95k** by the pessimistic bound, and the prompt's own estimate must
   never fall below that bound.
9. **The budget pause wasn't exact.** Spend was added up in floats. Five
   calls of $0.0006 against a $0.003 budget came to 0.0029999999999999996,
   so the AI didn't pause and a sixth call went out.
   - **Fix:** spend is added up in integer nano-dollars (`costNanos`;
     prices per million tokens × 1000 are exact), and the pause compares
     integers.
   - **Tests:** `main/ai/hardening.test.ts` › "the budget pause is exact"
     (the pause case, and 30 calls summing to exactly $0.012207).
10. **An error that arrives inside a stream was misclassified.** The SSE
    `error` event has no HTTP status, so an `overloaded_error` mid-spread was
    classed `unknown` and not retried, even with no candidates shown yet.
    - **Fix:** errors without a status are classified by the API's error
      type: overloaded and api errors → `server` (retried); rate limit →
      `rate_limited`; invalid request → `bad_request` (not retried); auth →
      `no_key`; too large → `too_large`. This happens inside the typed,
      most-specific-first chain.
    - **Tests:** four, in "errors that arrive inside a stream". The
      existing rule, that a stream which has already shown candidates is
      never retried, still holds.
11. **Nothing stopped a request that contained the API key.** For example, a
    key pasted into an entity description.
    - **Fix:** `secrets.ts`. Before anything is sent (`count_tokens`
      included), the request is scanned for the client's key, for
      `ANTHROPIC_API_KEY`, and for anything shaped like `sk-ant-…`. A match
      is refused as `bad_request`. Neither the key nor the request text is
      logged.
    - **Tests:** two, in "a request never contains the API key".
12. **An eval run where no case reached the model reported PASS and exited
    0.** All 401s, with every metric n/a, gave a green first run. Cases
    stopped by the `--max-usd` cap simply vanished from the report.
    - **Fix:** a case that failed for any reason other than invalid output
      (which is measured, by schema validity) or never started fails the
      run. The report lists them.
    - **Tests:** five, in `evals.test.ts` › "a run that could not reach the
      model never passes".
13. **Spec drafts were slow** for many entities: 8.5 s for 400 entities and
    300 formulas. `specNumbers` summarised every formula once per entity,
    and each summary rescanned the source for its line number.
    - **Fix:** `relevantFormulas` takes several ids and summarises once;
      line numbers come from a cached line index.
    - **Test:** "a spec draft over hundreds of entities and formulas builds
      quickly" (< 1.5 s).

### Checked and found sound, now covered by tests

- **The streaming partial-JSON parser.** `stream.test.ts`: arbitrary JSON
  items, decoy `candidates` keys at other depths, strings full of brackets,
  quotes, escapes and astral characters, pretty or compact output, every
  chunking down to single characters. It also checks that each item comes
  out as soon as it closes, and that a truncated stream yields only the
  complete items. 1,800 runs, no defect.
- **Incremental evaluation always equals evaluation from scratch,** with
  random programs over a shared name pool (functions calling functions,
  queries, cycles, errors) mixed with variable, attribute, state and band
  edits. `fuzz.test.ts`, 200 sequences.
- **Parse → print → parse** (existing tests), plus a random-token-stream
  fuzz: no throw, spans in range, under 2 s, and printing is a fixed point
  for anything that parsed.
- **Cancellation doesn't leak.** Every listener the gateway adds to a
  caller's signal is removed. A request superseded while it waits to retry
  stops at once and frees its slot.
- **Request shape**, checked against the current API docs (the claude-api
  skill):
  - `claude-haiku-5-5`, `output_config.format` json_schema and
    `output_config.effort` (`low`/`medium`; Haiku 5.5 supports
    `low`–`max`, default `medium`)
  - no `temperature`, `top_p`, `top_k` or `thinking`; no prefill
  - 3 of 4 `cache_control` breakpoints, with the stable prefix first
  - `stop_reason` `refusal`, `max_tokens` and
    `model_context_window_exceeded`
  - the pricing table, including the 5× rate over 100k tokens and the cache
    multipliers

  The existing contract tests cover these for every moment.

## 2. Gaps filled (integrate §10)

| Gap | What now exists |
|---|---|
| **Intent curves: add and delete points, not only move them vertically** | `editIntent` and `nextIntentX` in core, pure and property-tested: points stay sorted and unique, in range, and on ticks for bands and tiers. On the plot: drag moves a point in x and y (snapping on bands and tiers, never past a neighbour); double-click adds one; on a focused point ←/→ move it, `+` adds a point beside it, and delete removes it. Removing the last point removes the intent. The palette has "Add an intent point" and "Remove an intent point" (for the last focused point). Covered by an e2e test |
| **Name autocomplete in the formula editor** | `completions()` in core, pure and tested. It offers the enclosing function's parameters first, then definitions with their types, variables with their values, built-ins with their usage, collections and keywords; after a dot, only entity properties; nothing in strings, comments or numbers. The editor shows it at the caret as you type a name; `ctrl+space` opens it (also in the palette). ↑/↓ choose, tab or enter accept, escape closes it without leaving the editor. Covered by an e2e test, with screen `docs/screens/numbers-complete.png` |
| **The key from the system keyring, with an env-var fallback** | `src/main/ai/key.ts` (app) and `scripts/lib/api-key.mjs` (scripts): Secret Service via `secret-tool lookup service carbon account anthropic-api-key`, then `ANTHROPIC_API_KEY`. `CARBON_KEYRING=off` skips the keyring. The scripts say only where the key came from. Unit-tested |

**The scripts, ready for the first real run.**

- **`npm run smoke:ai`** now makes two critiques (the second should read the
  cache) and one streamed spread. It prints one line per call with usage,
  cost and latency, the cache read, a verdict, and a hint per error code.
  It exits 1 on a failure.
- **Without a key,** both scripts explain how to add one and exit 0.
- **The guide,** with exact commands, what each output means and the
  expected cost: [`docs/AI-FIRST-RUN.md`](../AI-FIRST-RUN.md). The whole
  first run should cost well under $0.10.

## 3. Measurements

- **Unit and property tests:** see the final count in the check run below.
  The review added 11 test files (`hardening`, `fuzz`, `intent`, `complete`
  and `perf` in numbers; `limits` and `stream` in prompts; `hardening` and
  `key` in main/ai) and new blocks in `evals.test.ts`.
- **Coverage of `src/core` in my areas** (lines / functions):
  - numbers: 96.9% / 95.1%
  - context: 98.1% / 100%
  - prompts: 99.0% / 95.9%
  - ai: 98.2% / 100%

  The whole of core is 98.0% lines and 97.0% functions.
- **End to end:** the full suite passed, **92 tests** (the 90 before plus 2
  new numbers tests), in 1.9 minutes.
- **Performance:**
  - SYSTEM §9 gives 16 ms for a command round trip. The Numbers view
    re-analyses the draft on every keystroke in the renderer, so I held that
    to the same frame. On the 2,000-entity stress world: **median 3.9 ms,
    max 6.8 ms** per keystroke. Completion takes **0.3 ms**. Both are
    enforced in `perf.test.ts`.
  - The pathological nested query: from 27 s to under 1.5 s (it stops at
    the step limit).
  - A spec draft for 400 entities: from 8.5 s to under 1.5 s.
- **The offline eval** (`npm run eval -- --dry`) still runs all 21 cases end
  to end. Its quality metrics are meaningless by design.

## 4. Decisions

1. **Names stay ASCII.** Variable names are ASCII in `variables.json`, and
   formulas would otherwise accept names that variables can't have. A
   non-ASCII letter gets one error with a hint ("Names use the letters a–z
   and A–Z, digits and _"). Strings take any unicode.
2. **The limits:**
   - `MAX_DEPTH = 256`, for nesting within one expression
   - `MAX_EVAL_DEPTH = 1000`, for nested evaluation through calls
   - collection and list work is charged against the existing step limit
     (200,000 per definition)

   Real formulas are nowhere near any of these.
3. **The estimate is pessimistic for non-ASCII text** (its UTF-8 byte
   length). An English world estimates exactly as before. A world full of
   emoji packs less context, which is the price of a hard 100k guarantee.
4. **`ASK_LIMIT` is 15k tokens.** The cap is central, in `assemble`, so it
   covers W5's spread and patterns asks too, without touching their files.
5. **Budget concurrency.** The pause is exact against completed spend.
   Requests already in flight when the budget is reached still finish and
   are costed, so a session can end slightly over budget by the cost of
   those calls (cents at most). Refusing to start a call by its worst-case
   cost would pause the AI before the budget is reached, which is
   confusing.
6. **The keyring comes first, the environment second,** as the task asked
   ("keyring with an env-var fallback"). SYSTEM §10 lists both without an
   order.
7. **Palette intent actions** work on the last intent point that had focus.
   Opening the palette moves focus away, so they can't use the current one.
   On the plot itself, `+` and delete act on the focused point.

## 5. Shared files touched

Every change is minimal and additive.

| File | Change | Why |
|---|---|---|
| `e2e/harness.ts` | `CARBON_KEYRING: 'off'` in the launch environment | So a key in a developer's keyring never reaches a test run (with the keyring read, the "no key" e2e test would otherwise find a real key) |
| `e2e/ai.spec.ts` | The no-key status text | Its reason now names both sources |

No IPC channels, settings keys or commands were added. The new exports in
`@core/numbers` are `editIntent`, `nextIntentX`, `completions` and their
types. `relevantFormulas` also accepts an array of ids; a single id works as
before.

## 6. Out of scope: for the coordinator

- **`IpcAiGateway.run` (renderer) returns an `ok` result after the caller's
  signal aborted,** if the main process finished first. The Bench
  controller guards with its own request slots, so I saw no visible effect.
  A one-line `if (signal?.aborted) return cancelled()` after the `invoke`
  would make it match the real gateway's contract. It's in `src/renderer/ai`
  (mine), but small and behaviour-neutral, so I left it for the polish pass.
  It's listed here so it isn't lost.
- **Nothing found outside my packages** that needs fixing. The W5
  spread and patterns asks were unbounded, but the central `ASK_LIMIT`
  covers them without editing `src/core/spreads`.

## 7. Still open

- **The first real API run**, on your machine:
  [`docs/AI-FIRST-RUN.md`](../AI-FIRST-RUN.md). Recall, precision and
  diversity against Haiku 5.5 are still unmeasured. Recorded fixtures will
  make `--replay` a real regression check.
- **Go-to-definition in the formula editor** (the other half of W3's editor
  gap) isn't built. Hovering a value shows its type, and completion shows
  each name's type.
- **ASCII estimates** remain empirical (2.8 characters per token). Pathological
  ASCII such as long random strings could tokenize denser. Near the limit,
  the gateway's `count_tokens` check backs the estimate; above 80k it always
  counts.
