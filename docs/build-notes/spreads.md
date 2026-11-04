# Build notes: `spreads` (W5)

Branch `claude/blissful-einstein-8u27ty-spreads`. Everything in the W5 row of
`BUILD.md` §5 is built: spreads (spot, move, direction, streaming, the field,
triage, records) and Taste (rules, kill reasons, patterns, taste in requests),
plus the `spread` and `patterns` prompt builders in W4's `PromptBuilder`
shape. `npm run check` passes.

- **The contract for other packages:** §1
- **Decisions:** §2
- **Shared-contract changes:** §3
- **Integration steps:** §4
- **Status, tests, known gaps and spend:** §5

---

## 1. The contract

### 1.1 Starting a spread from another view (the hand-off)

A view starts a spread at its selection (`space`) by setting the spot in UI
state together with the view:

```ts
import { setUi } from '@renderer/state/ui';
setUi({ view: 'spread', spot: { type: 'cell', band: 'low-sky', lane: 'items' } });
// or, from inside the renderer: import { startSpread } from '@renderer/views/spread/start';
startSpread(spot, 'fill' /* optional move */);
```

| Spot | Shape |
|---|---|
| Column cell | `{ type: 'cell', band, lane }` |
| Climate region | `{ type: 'region', band, climate }` |
| Codex selection | `{ type: 'selection', entities }` |
| One entity | `{ type: 'entity', entity }` |
| A note (or a rule) | `{ type: 'note', note, entities }` |

The Spread view takes the spot, picks a move that can aim at it (it keeps the
current move if it can, else Fill for places, Alloy for a pair, Vary
otherwise), clears `ui.spot`, and waits for a move key or `enter`. With no
spot handed over, it aims at the selection (several → `selection`, one →
`entity`) or the entity on the Bench. Inside the view, `s` opens a spot picker
(every band × lane cell and every entity).

W1 and W2 built the same hand-off in parallel under other names (W1:
`ui.spreadRequest: { spot, seq }` with `startSpread` in `state/ui.ts`; W2:
`ui.spreadSpot` with `startSpreadAt`). The Spread view **accepts all three**
(`views/spread/handoff.ts`, tested) and clears whichever it took, so any
merge order works. See §4 for settling on one.

### 1.2 Core modules

```
src/core/spreads/
  moves.ts        MOVE_DEFS: the nine moves as data (key, asks, instructions, spots, minEntities,
                  output 'new' | 'about' | 'finding', default axes); MOVE_LIST, moveByKey, AXIS_LIBRARY
  spot.ts         spotEntities, spotBand, bandOf, spotKind, spotLabel, spotSlug, checkSpot(world, spot, move),
                  movesFor, defaultMove, spotFromUi, sameSpot
  similarity.ts   similarity(a, b) ∈ [0,1], nearDuplicates(items, threshold), diversity(items), leadVerb
  field.ts        layoutField(points, box) → no-overlap placement; neighbour(placed, key, dir); readingOrder
  record.ts       SpreadDataSchema (the spread file), readSpread, allSpreads, makeSpread, newSpreadId,
                  allJudgements, openCandidates
  commands.ts     spread.save (strict put), spread.judge
  triage.ts       keepCommands, killCommands, mergeCommands, followSpot; cleanFields/Attributes/Relations
  findings.ts     findingNotes(world): kept Break findings as notes
  prompt.ts       buildSpreadPrompt(world, req) → { system, digest, taste, focus, task }; worldDigest,
                  renderEntity, renderKind, neighbours, estimateTokens
  builders.ts     createSpreadPromptBuilders(assemble) → [spread, patterns] in W4's PromptBuilder shape;
                  spreadOutputSchema, parseSpreadCandidate, parseSpreadOutput, parsePatternsOutput
src/core/taste/
  commands.ts     taste.addRule / updateRule / removeRule, addReason / updateReason / removeReason /
                  countReason, learnPatterns, setPatternStatus
  context.ts      tasteContext(world, ruleIds?) + renderTaste: active rules, top patterns, kill examples
  patterns.ts     mergePatterns, patternsDue (every 25), judgedSinceRun, patternsRequest (last 80)
  prompt.ts       buildPatternsPrompt, PATTERNS_SYSTEM, PATTERNS_TASK
```

**What candidates become** (`triage.ts`, each one transaction = one undo step):

| Key | Commands |
|---|---|
| `k` new candidate | `entity.create` (state idea, `origin: { by: 'ai', moment: 'spread', spread }`, `ai_fields`, placed at the spot: `in_band` for a cell, `band` + `climate` for a biome from a region) + `spread.judge keep` |
| `k` Ground / Cost / Name (`about`) | `entity.update` (`source: 'ai'`) for valid fields (Name: the name) + `relation.add` per new relation (with its note) + `spread.judge keep` |
| `k` Break finding (`kind: null`) | `spread.judge keep` only; it shows as a note (source `spreads`) on the entities involved |
| `x` + reason | `spread.judge kill` (reason key, its label, typed words for "other") + `taste.countReason +1` |
| `m` | `entity.create` of the merged entity + `spread.judge merge` for each marked candidate |
| `→` + move | keeps a new candidate first (one step), then starts a spread on its entity (`parent` recorded) |
| `u` | undo (the same history as `ctrl+z`) |

### 1.3 The spread record (`spreads/<id>.json`)

`{ id, created, updated, spot, move, direction?, axes, count, ruleIds, status:
'done' | 'cancelled' | 'failed', parent?: { spread, key }, candidates,
judgements: { [key]: { verdict: 'keep' | 'kill' | 'merge', reason?, reasonLabel?,
note?, entity?, at } }, dropped, costUsd }`. Ids are
`<yyyymmdd-hhmmss>-<spot slug>`. A record is written once, when the stream
ends (through the foundation's `spread.put`), then judged with `spread.judge`.

### 1.4 Taste in requests

`tasteContext(world, ruleIds?)` gives the active rules (the per-spread switch,
or every enabled rule), the top 6 patterns (promoted first, then by strength;
never dismissed) and up to 3 recent examples per used kill reason.
`renderTaste` renders it. The pattern-run marker is `settings.patterns =
{ judged, at }` in `carbon.json`.

---

## 2. Decisions

1. **Moves aim at specific spots** (`MOVE_DEFS[m].spots`): Fill at cells,
   regions, notes and selections; Vary, Push, Ground, Cost, Name at entities
   and selections; Oppose also at notes (a rule is opposed through a note
   spot: `o` on a rule in Taste); Alloy at a selection of two or more; Break
   anywhere. The bar disables moves that can't aim at the spot, and the
   builder refuses them (`bad_request`).
2. **Triage keys only work once the stream has ended** (or been stopped with
   `escape`). The record is written once per run, so judgements always have a
   record to land on and a streaming run never adds undo steps. Streaming is
   seconds, and `escape` keeps what arrived.
3. **`→` on a candidate that isn't kept yet keeps it first** (a separate undo
   step), because a follow-up needs an entity to aim at. Findings follow as a
   note spot naming the entities involved.
4. **Merge** needs two or more marked (`space`) new candidates of one kind.
   The first marked gives the name and identity; fields and attributes take
   the first value offered; relations are the union; the description lists
   every merged candidate. About-candidates and findings can't be merged.
5. **Everything the AI proposes is sanitised in core before it reaches a
   command:** fields that don't parse, unknown fields, relations the rules
   forbid, dangling targets and out-of-range attributes are dropped, so keep
   never fails on a messy candidate (property-tested against arbitrary model
   output).
6. **Near-duplicates:** 0.45 × name-trigram Jaccard + 0.55 × Jaccard of stemmed
   content words of identity and description, rounded to 1e-6;
   threshold 0.42. Deterministic, symmetric, order-independent (property
   tests).
7. **The field layout** places cards in key order at their axis positions
   and moves a card whose spot is taken to the nearest free spot on a
   half-card grid. It never overlaps while there's room (property test).
8. **Field navigation:** `tab` / `shift+tab` in reading order, `↑ ↓ ←`
   spatially. `→` is follow, so there's no spatial right, and `k` is keep, so
   there's no vim up.
9. **The kill-reason and follow prompts handle their keys themselves**
   (a focused element that `preventDefault`s), not through the action
   registry: the shell's layer re-registers on top whenever its undo label
   changes (`useActions` re-registers on label changes), so a layer-based
   prompt would lose the digits to the view switches after the first
   command. See §5.
10. **Patterns** run automatically when 25 judgements have built up since the
    last run (checked while the Spread view is open, which is where
    judgements happen), or on demand in Taste (`shift+l`). One run at a time.
    Results merge deterministically: `updates: <id>` refines that pattern and
    keeps its status; the same text is the same pattern; a dismissed pattern
    stays dismissed. Promote is one transaction (`taste.addRule` with `from`
    + `taste.setPatternStatus promoted`).
11. **Kill reason "0" (other) can't be removed**; new reasons take free digit
    keys 1–9.
12. **Text rule:** no titles. The spot label, axis ends, counts (`11/12`
    open, `3/12` streaming, `4/25` judgements until patterns, `1/1 rules`)
    and column labels in Taste (three lists that look alike) are the only
    labels. Keys live in tooltips, the palette and the two choice prompts,
    which are themselves the choice. The one empty state: "Nothing to spread
    on. s to choose a spot."
13. **Colour:** the wildcard has an `--ai` border and a spark; the rationale
    and pattern strength are `--ai`; selection uses the accent glow; marked
    cards a dashed accent outline.

---

## 3. Shared-contract changes (all additive)

| File | Change |
|---|---|
| `src/core/commands/registry.ts` | Two lines: `...spreadCommands`, `...tasteCommands` (plus their imports) |
| `src/core/model/model.test.ts` | The "every command has a readable label" table needs a payload per command type, so it gained entries for my 11 commands. Every package adding commands has to touch this table: expect trivial merge conflicts there |
| `src/renderer/state/ui.ts` | `UiState.spot: Spot \| null` (default `null`): the hand-off (§1.1) |
| `carbon.json` (data, via `settings.set`-style patch) | `settings.patterns = { judged, at }`, through the loose settings schema; no schema change |

Nothing renamed or removed. `SpreadRecordSchema` and `TasteSchema` were not
changed: my extra keys ride on their loose objects (`TasteRule.from`,
`Pattern.strength`, `Pattern.updated`).

---

## 4. Integration steps

1. **W4's registry** (`src/core/prompts/registry.ts`):
   ```ts
   import { assemble } from './common';
   import { createSpreadPromptBuilders } from '../spreads/builders';
   export const PACKAGE_BUILDERS: readonly AnyPromptBuilder[] = [...createSpreadPromptBuilders(assemble)];
   ```
   I checked this in a scratch worktree of the `ai` branch: `tsc` passes and
   W4's replay test (the real gateway, offline, streaming a spread) passes
   with my builders. **One W4 test needs a one-line change:**
   `prompts.test.ts` builds a spread with `move: 'vary'` on a Column cell,
   which my builder refuses (Vary needs an entity); give it an entity spot or
   `move: 'fill'`.
2. **Kill-reason examples in W4's taste block.** W4's packer renders taste
   itself (`renderTaste` in `src/core/context/render.ts`) with reason counts
   but no examples. EXPERIENCE §6 asks for examples: have it add
   `tasteContext(world, ruleIds).kills[].examples` from `@core/taste`, or
   call `renderTaste(tasteContext(...))` from there.
3. **The hand-off name:** keep `ui.spot`, W1's `ui.spreadRequest` or W2's
   `ui.spreadSpot`, whichever merges first; the Spread view reads all three.
   Settling on one means dropping the others from `ui.ts` and
   `views/spread/handoff.ts`.
4. **W4's fallback builders** (`fallback-spread.ts`) can go once mine are
   registered.

---

## 5. Status

**Built:** everything in the W5 row. Spread: spot picker and hand-off, nine
moves, direction, axes, count, per-spread rules, streaming with the 140 ms
fade-and-rise, dot grid, near-duplicate hairlines, wildcard in `--ai`,
`k`/`x`/`m`/`space`/`→`/`u`, cards that leave toward the spot or fade, the
focused candidate in full under the field, earlier spreads from the history
menu, kept findings as notes, the AI-off state. Taste: rules (add, edit,
switch, remove, oppose), kill reasons (add, rename, remove, usage counts and
bars), patterns (learn now or every 25 judgements, promote, dismiss, show
dismissed). Prompt builders for `spread` (all nine moves) and `patterns`.

**Tests:**

- **Unit and property: 58** in 6 files (`src/core/spreads`, `src/core/taste`,
  `src/renderer/views/spread`). Property tests: the inverse of any merge
  restores exactly the starting state; similarity is symmetric, bounded,
  deterministic and order-independent; field layout never overlaps and
  doesn't depend on order; pattern merging is deterministic and idempotent;
  arbitrary model output always parses into candidates that every keep
  accepts. Also: every candidate the fake gateway gives, for every move and
  spot, can be kept and killed; prompts for all nine moves end with the
  diversity contract and stay under 30k tokens on a 2,000-entity world.
- Whole suite: 126 unit tests pass. Core coverage 97.6% lines (spreads 99%,
  taste 99%).
- **End to end: 14** in `e2e/spreads.spec.ts`, two `@smoke` (a Fill spread
  streamed and triaged with `k`, `x 3`, `u`, `u`; Taste rules and reasons with
  undo). The rest: the file on disk, "other" with typed words, merge as one
  undo step, follow, hairlines, Break finding → note → undo, Ground changes its
  entity, the automatic patterns run at 25, the AI-off state, streaming with
  `escape` keeping what arrived (`CARBON_AI_DELAY_MS=120`), learn/promote/
  dismiss, and `o` on a rule.

**Screens:** `docs/screens/spreads-field.png`, `spreads-kill.png`,
`spreads-streaming.png`, `spreads-taste.png` (sample world, device scale
factor 1).

**Known gaps:**

- Triage waits for the stream to end (decision 2).
- Changing the axes after a spread applies to the next run: positions come
  from the model for the axes it was asked about.
- The real smoke test against W4's gateway hasn't run: `ANTHROPIC_API_KEY`
  is not set in this container (checked by name only). Everything runs on
  `FakeAiGateway`; the builders were checked against W4's replay fixtures.
- The fake gateway's candidates carry no kind fields, so Ground and Cost keeps
  from the fake change nothing but the record; real output (and the property
  test) exercises the field and relation paths.
- **Foundation issue (not mine to fix):** `useActions` re-registers a layer
  when any label changes, which moves it to the top of the stack. The shell's
  undo label changes after every command, so the shell layer ends up above
  views and wins shared keys (`1`–`7`, `escape`). My prompts work around it
  (decision 9). A fix in `actions.ts` would keep a layer's position on
  re-registration.

**API spend: $0.00.**
