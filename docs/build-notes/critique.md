# Build notes: `critique`

Branch `claude/blissful-einstein-8u27ty-critique`. Fixes the report "the AI
critique/fill … literally conflicts with itself sometimes. An AI-generated
description gets critiqued by the AI." Designed in `SYSTEM.md` §8a and
`IMAGES.md` §7.

`npm run check` passed twice and the full `npm run test:e2e` passed twice
(122 tests), after merging the latest `origin/claude/blissful-einstein-8u27ty`.
There are 750 unit tests, up from 728. API spend was **$0.00**: there is no key
here, so everything ran on fixtures.

## 1. The diagnosis: confirmed, with one correction

| Claim | Verdict |
|---|---|
| The critic's criteria exist only in `critique.ts`; suggest, fill and spread never see them | **Confirmed.** `CRITIQUE_INSTRUCTIONS` held the five kinds. The writers had only the `ROLE` line "Identity over numbers", and spreads had a sentence in `SPREAD_SYSTEM`. Neither mentioned weak identity, contradicted relations or "same role under another name" |
| Accepting an AI proposal changes `updated`, so `finish.ts` treats it as your edit | **Confirmed.** `finish()` compared only the `updated` stamp. Fill, then Accept all, then leaving the entity sent a `finish_edit` critique of nothing but AI text. The new e2e reproduces it: against the old `finish.ts` it fails with 1 critique sent where 0 were expected |
| The critic doesn't know which fields the AI wrote, and offers no way to act on a note | **Confirmed.** `ai_fields` was in the world, but the critique ask never mentioned it. A note had only Dismiss |
| *(correction)* The duplicate-name half of the self-check is new | **Partly wrong.** Fill, suggest and spread already dropped duplicate names at parse time. What was missing was the identity side of `duplicate` (another entity's identity line) and any deterministic `just_a_number` check |

## 2. The changes, each with its tests

### 2.1 One quality bar: `src/core/prompts/quality.ts`

- `QUALITY` is typed `Record<CritiqueKind, …>` over `CRITIQUE_KINDS`, so a new
  critique kind doesn't compile without both of its lines.
- Each criterion has a `rubric` line (the critic's view) and a `must` line
  (the writer's view).
- `critiqueRubric()` renders the critic's list in `CRITIQUE_INSTRUCTIONS`.
  It's word for word the old list.
- `qualityConstraints(subject, exception?)` renders the block
  "# Quality bar (must satisfy)". These prompts now carry it:
  - `suggest_one` and `suggest_three`
  - `fill_entity`
  - `SPREAD_SYSTEM`, which is every move, through both the registered builder
    and `buildSpreadPrompt`. It adds one exception line: the wildcard may
    ignore rule_clash, and a Break finding is held to duplicate and
    contradicts_relation only.
- `image_prompt` doesn't exist on the merged base, so there was nothing to
  wire there. When it lands, add `qualityConstraints(...)` to its
  instructions and one line to `generatingPrompts()` in the test.

**Test:** `quality.test.ts › the critic judges by exactly the criteria every
generating prompt must satisfy`. It reads the kinds back from the **built
prompts**, not from the table: the critic's list after "these kinds:", and
the writer's list after the quality-bar heading. It covers all 21 generating
prompts:

- suggest one and three
- fill
- each of the 9 moves, through both spread paths

It asserts each list equals `CRITIQUE_KINDS` and contains every `must` and
`rubric` string. A criterion added by hand to one side, or missing from one,
fails it.

### 2.2 Provenance-aware triggers: `src/renderer/ai/finish.ts`

- The baseline is now `{ updated, fields: fieldSnapshot(e) }`.
- `fieldSnapshot` hashes:
  - the common fields
  - every kind field (keyed like `ai_fields`)
  - every attribute (`attributes.<key>`)
  - the relations, as one pseudo-field
- `userChangedFields(base, e)` lists the keys that differ from the baseline
  and aren't in `ai_fields` now.
- `finish()` critiques only when that list isn't empty.
- A field you edit after the AI wrote it leaves `ai_fields` (the commands do
  that), so it counts.
- State changes and `?` are unchanged.

**Tests:** in `finish.test.ts`, pure, on the real commands:

- accepting AI values (fields and an attribute) and leaving, or `ctrl+s`,
  sends nothing
- an AI field you then edit counts
- your edit beside AI ones counts
- an AI attribute doesn't count and yours does
- a state change still critiques
- `userChangedFields` itself, including a cleared field

### 2.3 The critic knows the provenance, and a note can be acted on

- **Prompt:** the critique ask adds "Fields written by the AI and not edited
  since: …" when there are any. The instructions say AI-written fields meet
  the same bar, and to name the field in a note about one.
- **Schema:** `SuggestRequestSchema` gains an optional `guidance` (≤ 500
  characters). It's additive: requests without it parse as before. `fieldAsk`
  quotes the note and asks for a value it no longer applies to. The
  instructions add "If the ask quotes a critique note, the value must fix
  exactly that problem".
- **Bench:**
  - After a critique, `benchAi` records `rewrites[noteId] = { entity, field,
    text }` for each note whose field is AI-written. A `weak_identity` note
    with no field counts as `identity`.
  - The notes list shows **Rewrite** on such a note while its field is still
    AI-marked (`rewritableNote` checks live). `r` runs it for the first such
    note, and the palette lists one "Rewrite <field>: <note>" entry per note.
  - Rewrite focuses the field and runs `suggest_one` with the note as
    `guidance`. The rewrite waits in the field as a ghost: `tab` accepts and
    `esc` dismisses.
  - Accepting is one `entity.setField` with `source: 'ai'`, so one undo step.
    It withdraws the note.

**Tests:**

- `quality.test.ts`: the AI-field line in the critique ask; `guidance` in the
  ask; a request without guidance is unchanged.
- `bench.test.ts`, on `FakeAiGateway`:
  - the note is rewritable
  - the gateway receives `guidance` = the note's text
  - accepting writes one command, keeps the `ai` marker and dismisses the note
  - a field you edit is no longer rewritable
  - a note on your own field never is

### 2.4 A deterministic self-check on generation

`selfCheck(world, field, value, except)` and `selfCheckCandidate(...)` in
`quality.ts`:

| Criterion | What the program decides |
|---|---|
| `duplicate` | A name equal to another entity's, normalised. Also an identity equal to another live entity's, normalised, 8+ characters |
| `just_a_number` | An identity that has a number and no word outside a stat vocabulary ("+10% damage", "Grants 5 extra defense", "×2 speed"). "Lasts 10 seconds…" and "+10% damage while you are falling" pass |
| `rule_clash` | **Not checked.** `TasteRuleSchema` is `{ id, text, enabled }`: free prose with no keywords, so the rule format doesn't support it. Only the critic judges rules. If taste rules ever gain e.g. `forbid: string[]`, it's one more branch in `selfCheck` |

A proposal that fails is dropped at parse time and counted in `dropped`:

- `fill.ts` (`parseFill`, which `fillBuilder.parse` uses)
- `suggest.ts` (`validSuggestions`, both moments)
- `spreads/builders.ts` (`parseSpreadCandidate`; not findings; `about`
  candidates exempt their own entity)

There are no extra AI calls.

**Tests:** in `quality.test.ts`:

- `isJustANumber` positives and negatives
- `selfCheck` and `selfCheckCandidate`
- fill drops a "+10% speed" identity (dropped 1)
- suggest one refuses a pure number and another entity's identity
- suggest three drops one of four (dropped 1)
- a spread drops a pure-number candidate and another entity's identity

The existing fast-check spread property (`kept + dropped = all`) still holds.

### 2.5 End to end: `e2e/critique.spec.ts` (fake AI)

1. **Accept all, then leave: no critique; your edit, then leave: one
   critique.** On Sky Coral: `ctrl+enter`, Accept all, leave, then `ctrl+s`.
   The AI log has no new critique. Then typing an identity and leaving gives
   exactly one.
2. **Rewrite, then undo.** An AI-written "Odd." identity, then `?`, shows a
   weak-identity note with Rewrite, also listed in the palette.
   - `r` asks for the rewrite: one `suggest_one` in the log and a ghost in
     the focused field. `esc` dismisses it and the note stays.
   - The note's button asks again. `tab` accepts the rewrite: the field and
     the file update, the note goes and the `ai` marker stays.
   - One `ctrl+z` restores "Odd.".

## 3. The eval: self-consistency

**Code:**

- `src/main/ai/evals/consistency.ts`: the cases, the runner and the metric
- `consistency.test.ts`
- `evals/fixtures/consistency/*.json`
- Wired into `eval.eval.ts`, and `buildReport` takes the extra metric and its
  spend.

**How it runs:**

- For each case: fill, accept every proposal except the name (as Accept all
  does), then critique `on_demand`.
- **Metric:** the share of critique notes whose field is one the fill just
  wrote (`weak_identity` with no field counts as identity). The target is
  ≤ 10%. A case that didn't run fails it.
- **Live:** both calls go through `ClaudeAiGateway`.
- **Offline** (`--replay`, `--dry`): through the real builders. Each prompt
  is built, then each fixture answer goes through the moment's parse.
- **Fixture keys:** each critique answer is keyed by the entity's AI-written
  fields, because the critic sees a different entity when the parse drops a
  proposal.

**Cases:**

| Case | What it covers |
|---|---|
| `consistency-thermal-charm` | A blank accessory added to the eval world |
| `consistency-high-drift` | |
| `consistency-frost-wisp` | Its dangling relation gives a note with no field |

**The fixture pair that reproduces the conflict** (`thermal-charm.json`):

- The fill proposes the identity "+10% speed".
- Keyed with identity among the AI fields, the critic answers `just_a_number`
  on identity.
- Keyed without it, the critic answers `weak_identity`: the identity is still
  empty, so that note isn't on a just-filled field.

**Result:**

| Parse | Notes on just-filled fields | |
|---|---|---|
| Today's, without the self-check (`parseFill(..., { selfCheck: false })`) | **50%** (1 of 2: `just_a_number` on identity) | fail |
| With the fix | **0%** (0 of 2; the identity proposal dropped and counted) | pass |

`consistency.test.ts` asserts both. `npm run eval -- --dry` reports
"Self-consistency: critique notes on just-filled fields | 0.0% | ≤ 10% |
pass" (`evals/reports/latest-dry.md`). `docs/AI-FIRST-RUN.md` §2 now
describes the metric.

**Measured offline only.** The offline result shows what the deterministic
half does. What the prompt half (the quality-bar block) does to a real model
is only measured by a live `npm run eval`, about 6 more calls, well under
$0.01. `npm run eval -- --replay` already failed before this change, because
`evals/fixtures/recorded/` is empty: references, recall and precision run on
synthesised answers. The new metric passes there too.

## 4. Outside the listed paths

| File | Why |
|---|---|
| `src/main/ai/evals/*` | The task asks for the eval there: the eval library lives in `src/main/ai/evals/` (`ai.md` decision 12) |
| `src/main/ai/replay.ts` | **Test infrastructure.** The synthesiser drew `suggest_three` values from 7 phrases, so 3 suggestions collided about 39% of the time, depending on the request's seed. The new prompt text re-rolled the seed for `replay.test.ts › answers every moment` into a collision. Alternatives are now re-drawn until distinct (up to 20 tries). The test is unchanged |
| `e2e/critique.spec.ts` | The new e2e, in its own file to stay clear of the images workers' specs |
| `docs/AI-FIRST-RUN.md`, `evals/reports/latest-dry.md` | As asked; the committed dry report regenerated |

No image-related files were touched.

## 5. Known gaps

- The self-check is conservative on purpose. It catches identities that are
  only a stat change, not "a faster version of X" in prose. The critic still
  owns those, and the prompt block asks the writer not to write them.
- A dismissed Rewrite ghost leaves the note in place. Pressing Rewrite again
  avoids values already shown (`avoid`), like `tab`.
- `r` acts on the first rewritable note. With several, use the palette or
  the buttons.

## 6. Follow-up: `k` then `x` dropped in the acceptance walk

**Cause:** the coordinator's hypothesis was right, with one detail added.

- After a keep (or a kill or merge), the focus moved only once `transact`
  resolved. In between, the world patch had already marked the card judged,
  so the focused card was no longer open. `canTriage` went false and the next
  key was disabled and dropped.
- There was a second, smaller window: the triage actions captured `focusKey`
  from the last render.

**Fix**, in `src/renderer/views/spread/`:

- `actions.ts`: `advance()` now moves the focus to the next open card
  **before** the transaction is sent. It puts the focus back if the world
  refuses the transaction, unless you've moved it since.
- New `triageTarget()`: `k`, `x` and space read their target from the stores
  when pressed. It is never a card that is judged, queued while streaming,
  or missing.
- `view.tsx` uses `triageTarget()`.

**Reproduced without load:**

- `actions.test.ts` holds the transaction open: 4 of its first 5 tests fail
  on the old code.
- `spreads.spec.ts › k then x with no wait` dispatches `k` and `x` in one JS
  task: it failed 2 of 2 on the old code.

**A second, unrelated flake** turned up under load in `spreads.spec.ts ›
after 25 judgements`. Radix Toast also renders its text in a hidden live
region for a moment, so `getByText(/patterns? to review/)` matched 2
elements, and the next test failed in turn. The assertion now targets
`getByTestId('toast')`: the same check, made strict.

**Stability:**

- spreads + acceptance: 5 of 5, under parallel unit-test load
- `npm run check`: passes
- the full `npm run test:e2e`: 123 passed, twice
