# Carbon: the overnight build

How carbon gets built by parallel cloud sessions, with one coordinator session.
Everything a worker needs is in `PRODUCT.md`, `EXPERIENCE.md`, `SYSTEM.md`,
`VISUAL.md` and this file.

---

## 1. Roles

- **Coordinator:** the planning session. It starts workers, checks in about
  every 40 minutes, merges finished branches into
  `claude/blissful-einstein-8u27ty` (the **main branch** below), runs
  `npm run check` after every merge, starts the next phase and nudges stalled
  workers.
- **Workers:** one cloud session per work package. Each works on its own
  branch, `claude/blissful-einstein-8u27ty-<slug>`, created from the latest main
  branch, and never pushes anywhere else.

## 2. Phases

| Phase | Workers | What happens | Done when |
|---|---|---|---|
| **0. Foundation** | 1 (`foundation`) | The skeleton every package builds on (§4) | §4's checklist passes and is merged |
| **1. Packages** | 6 in parallel | W1–W6 (§5) | Each package meets its definition of done and is merged |
| **2. Integration** | Coordinator, plus 1 `integrate` worker if merges conflict | All packages merged, cross-package flows wired, end-to-end suite across views | `npm run check` passes on the main branch, and the full end-to-end suite passes |
| **3. Hardening** | 3 (`review-a`, `review-b`, `review-c`) | Each reviews two packages against the docs: finds bugs, confirms them with a failing test, fixes them; raises coverage; meets the performance budgets | No open confirmed bugs, coverage and performance targets met |
| **4. Polish + QA** | 1–2 (`polish`, `qa`) | Visual pass against `VISUAL.md`, including an audit of every text element against its text rule, a keyboard audit of every action, user guide (`docs/GUIDE.md`), screenshots of every view in `docs/screens/` | The coordinator's final review |

## 3. Rules for every worker

1. **Read all five docs first** (including `VISUAL.md`; its text rule applies
   to every screen). When a doc and the code disagree, the doc wins.
   If a doc is wrong or unclear, write the question and your decision in
   `docs/build-notes/<slug>.md` and carry on.
2. **Stay in the paths you own** (§5). You may add to shared contracts
   (`src/core/model`, `src/shared/ipc.ts`, `package.json`), but don't rename or
   remove anything in them. Any change to a shared contract goes in your build
   notes.
3. **Rigor over features.** Strict TypeScript, zod at every boundary, no `any`
   without a comment explaining why, tests for everything in `src/core`. A
   smaller package that works completely beats a larger one that doesn't.
4. **`npm run check` must pass** before every push of finished work. Push work
   in progress often, so the coordinator can see it.
5. **AI and the key:** `ANTHROPIC_API_KEY` is set in the environment. It comes
   from a Console workspace with a $20 spend limit. Never print it, log it,
   commit it or write it to a file. Tests never need it: they use fixtures
   (hand-built, or recorded from real responses with the key stripped).
   Only `npm run eval`, `npm run smoke:ai` and fixture recording call the real
   API. Model: `claude-haiku-5-5` only. No request over 100k tokens. Record
   your spend in your build notes, and stay within your package's allowance
   (§7). **If a safety check blocks using the key, don't work around it, and
   don't ask another session to.** Fall back to fixtures, note the block in
   your build notes, and leave the real runs for the user's machine.
6. **Electron in the container:** run it under `xvfb-run -a` with
   `--no-sandbox`. Playwright's `_electron` works there. Take screenshots at
   `deviceScaleFactor: 1`.
7. **No pull requests, and no pushes to the main branch.** The coordinator merges.
8. **Finish with** an up-to-date build-notes file covering what was built,
   decisions made, shared-contract changes, known gaps and API spend. Your
   final message summarises the same.

## 4. Phase 0: foundation (`foundation`)

The build depends on this phase's interfaces, so it has to be right.

- [ ] **Project:** Electron + Vite + React + TypeScript strict; scripts `dev`,
  `build`, `check`, `test`, `test:e2e`, `eval`, `smoke:ai`, `dist`; ESLint,
  Prettier and Vitest configured.
- [ ] **Layers:** `src/core` (pure), `src/main`, `src/preload`,
  `src/renderer`, `src/shared` (IPC types). Lint rules forbid `src/core` from
  importing Node, Electron or React.
- [ ] **Domain model:** the entity kinds, common fields, kind schemas (as data,
  with defaults), relation types and their rules, and the entity lifecycle and
  its required fields per state. All as zod schemas with inferred types, per
  `SYSTEM.md` §3.
- [ ] **Commands:** the command and patch type, applying a command, inverse
  patches, transactions, and the undo/redo stack, with property tests.
  Commands to create, update and delete entities, set fields, add and remove
  relations, change state and set attributes.
- [ ] **Store (basic):** load and save the world directory (markdown with YAML
  frontmatter), atomic writes, validation on load. *W6 hardens it.*
- [ ] **IPC:** typed request/response and subscription channels, with a state
  snapshot then patches; a preload bridge.
- [ ] **AI gateway interface:** the `AiGateway` type covering each moment's
  request and result types, plus a `FakeAiGateway` that returns valid,
  deterministic outputs. Packages W1–W5 build their UIs against it. *W4
  implements the real one.*
- [ ] **UI shell:** a frameless window, the rail with view switching (`1`–`7`),
  a status line, an empty Bench panel, a view registry so each package adds its
  view in its own folder, and a stub command palette. Plus the **visual
  foundation from `VISUAL.md`**: design tokens (§2–§4), fonts, and the
  component kit in `src/renderer/ui/` (§5: Button, Input, Textarea, Select,
  Combobox, Popover, Menu, Tooltip, Dialog, Toast, Tabs, Table primitives,
  state glyph). Every package uses this kit, so it has to be right.
- [ ] **A sample world:** `fixtures/worlds/sample/` with a few bands, biomes and
  entities of every kind. It's for tests and screenshots only, not design
  content for the game.
- [ ] **End-to-end harness:** Playwright `_electron` launches the app on a
  temporary copy of the sample world, switches views and screenshots them.
- [ ] `npm run check` passes.

## 5. Phase 1: packages

| ID | Slug | Owns | Builds |
|---|---|---|---|
| W1 | `column` | `src/renderer/views/column/`, `src/renderer/bench/` | **The Column:** symmetric log axis, endless hatched ends, bands created and resized by dragging their edges, configurable lanes and saved layouts, entity glyphs by state, inferred placement marked, notes in the margin, navigation keys, `n` to create, `space` to start a spread. **The Bench:** a schema-driven form for every kind, an attribute editor, a relation picker with type rules, the state machine with the Why gate, `ai` markers, undo throughout |
| W2 | `world` | `src/core/placement/`, `src/renderer/views/climate/`, `src/renderer/views/codex/` | **Placement resolver** (deterministic, tested). **Climate:** per band, a temperature × moisture plane, biome rectangles you drag and resize, overlap and empty-climate highlighting, `[`/`]` to switch band. **Codex:** a virtualised table per kind, a filter query language (parser plus tests), inline edit, multi-select, bulk state changes, selection to spread |
| W3 | `numbers` | `src/core/numbers/`, `src/renderer/views/numbers/` | **The expression language**, per `SYSTEM.md` §6: Pratt parser, AST, resolver, type checker, dependency graph, incremental evaluation, errors with source spans, step limit. Golden and property tests. **The Numbers view:** variables, formulas with a live preview and inline errors, attribute definitions per kind, curves (formula over band, tier or attribute, entities as dots, draggable intent curves) |
| W4 | `ai` | `src/main/ai/`, `src/core/context/`, `src/core/prompts/`, `src/renderer/ai/`, `evals/` | **The real `AiGateway`:** the Anthropic SDK with `claude-haiku-5-5`, structured outputs, streaming, typed retries, cancellation, the content-hash cache, JSONL log, cost accounting and budget pause; SDK request shapes checked against the SDK's own types. **Context packer** with token budgeting (local estimate, then `count_tokens` near the limit, hard limit 95k). **The moments:** suggest one (`tab`), suggest three (`shift+tab`), fill entity (`ctrl+enter`), critique on finishing an edit or changing state or on demand, export spec drafting. The **AI log** overlay. **Evals:** fixture worlds with seeded flaws, the metrics from `SYSTEM.md` §8 and a report, fixtures for tests, with a record mode that captures real responses as fixtures (key stripped). Up to **$8** of API spend |
| W5 | `spreads` | `src/core/spreads/`, `src/core/taste/`, `src/renderer/views/spread/`, `src/renderer/views/taste/` | **Spreads:** spot, move and direction; all nine moves as request builders; streamed candidates on the field; choosing axes; the wildcard; triage keys; merge as a transaction; spread files. **Taste:** rules with per-spread switches, the kill-reason vocabulary, pattern learning (the AI moment) with promote and dismiss, and taste going into requests. Builds against `FakeAiGateway`, then a real smoke test against W4's gateway once W4 is merged. Up to **$3** |
| W6 | `platform` | `src/main/store/`, `src/core/checks/`, `src/core/export/`, `src/renderer/palette/`, `scripts/`, packaging config | **Store hardening:** fsync and rename, versioned migrations with a backup first, quarantining invalid files, git snapshots, external-edit detection and conflict prompts. **Mechanical checks** (all of `SYSTEM.md` §7, incremental, with stable note ids and dismissal). **Export:** choosing entities, building the spec, writing the file, marking entities exported. **Command palette** over every action and entity. **Packaging:** `npm run dist` and `scripts/install-omarchy.sh` |

**Each package is done when:**

- every feature in its row works as specified in `EXPERIENCE.md` and `SYSTEM.md`
- its unit, property and end-to-end tests cover the work
- `npm run check` passes after rebasing on the latest main branch
- a screenshot of each of its views is saved in `docs/screens/<slug>-*.png`
- its build notes are complete

## 6. Coordinator protocol

1. Start the `foundation` worker. Check in about every 40 minutes.
2. When foundation is finished: review it, merge it, then start W1–W6 at the
   same time from the new main branch.
3. Each check-in:
   - check the session status and latest pushes of every worker
   - for each finished worker: fetch, rebase if needed, run `npm run check`,
     merge, then tell the remaining workers to rebase
   - for a worker that has stalled or drifted: send it a message with the
     specific correction
   - for a worker whose session failed: start a replacement from its branch,
     with its build notes
4. When all packages are merged: integration, then hardening, then polish and QA.
5. At the end: a summary for the user covering what works, how to install it,
   known gaps, the screens and total API spend.

## 7. Budget

- **Development API spend:** a Console workspace with a **$20 spend limit**
  enforces it on Anthropic's side. Planned: W4 up to $8, W5 up to $3,
  hardening and QA up to $4, all other packages under $1 each, the rest margin.
- **Cloud compute:** the phases are sized to use the night. Workers favour
  correctness and tests over extra features.
