# Build notes: `images-core`

Branch `claude/blissful-einstein-8u27ty-images-core`. The non-UI half of
`docs/IMAGES.md`: the model, the store, the OpenAI provider, the gateway, the
budget and pricing, the `image_prompt` moment, art direction and export.

`npm run check` and the full `npm run test:e2e` (124 tests) pass on the
merged base (with critique). **Real OpenAI calls: 8 of the 12 allowed, all low quality,
$0.2815 in total** (§5).

- **The contract for images-ui:** §1
- **What was built:** §2
- **Decisions:** §3
- **Pricing, with its source and date:** §4
- **Real calls and spend:** §5
- **Tests:** §6
- **Shared files touched:** §7
- **Gaps:** §8

---

## 1. The contract (for images-ui)

### 1.1 Files

| File | What |
|---|---|
| `src/core/images/model.ts` | `ImageMeta`, `EntityImages`, `WorldImages`, `ArtDirection`, the kinds, models, qualities and sizes, `imagePaths()` |
| `src/core/images/gateway.ts` | `ImageGateway` (the interface), every request/response zod schema, `ImageError` codes, `ImageReceipt`, `ImageStatus`, `ImageLogEntry` |
| `src/core/images/pricing.ts` | `imageSettings(world.settings)` (model, quality, budget, pricing), the pricing table and `estimateNanos` |
| `src/shared/ipc.ts` | The `images:*` channels below |

### 1.2 The world

- `world.images?: Record<EntityId, { concept?: ImageId; icon?: ImageId; all: ImageMeta[] }>`.
  `ImageMeta.kind` is `'concept' | 'icon' | 'sheet'`. A **sheet** (IMAGES.md
  §2a) belongs to the entity in its first cell, carries `sheet: { cols, rows,
  gutter, canvas, cells: [{ index, entity }] }`, and is never selected. An icon
  accepted from a sheet has `origin: { by: 'sheet', sheet, cell, preset }`.
  **Absent when there are no images**, and an entity's entry is absent when
  it has none. Read it as `world.images?.[id]`. `all` is sorted by id (oldest
  first; ids are ULIDs).
- `world.settings.art?: { direction: string; kinds: Partial<Record<EntityKind, string>> }`.
- `imageSettings(world.settings)` gives `{ model, quality, budget: { sessionUsd, monthUsd }, pricing, pricingVerified }`
  with defaults (`gpt-image-2.6-flare`, `low`, $1 per session, $10 per month).
  Models: `gpt-image-2.6-flare` (default), `gpt-image-2.6-sunburst`, and
  `gpt-image-2.5-flare` (cheaper).

### 1.3 Commands (undoable, from the renderer with `dispatch(cmd(...))`)

| Command | Payload | Notes |
|---|---|---|
| `image.select` | `{ entity, image }` | Makes it the entity's concept or icon (by the image's kind) |
| `image.unselect` | `{ entity, kind }` | Files are kept |
| `image.remove` | `{ entity, image }` | Removes it from the world (and unselects it). Files are kept until "Delete image files" |
| `image.add` | `{ image: ImageMeta, select?: boolean }` | **Main only**, after it wrote the files. The renderer never sends it |
| `art.set` | `{ direction?: string, kinds?: { [kind]: string \| null } }` | Art direction; `null` (or `''`) clears a kind's note |
| `settings.set` | `{ key: 'images', value: {...} }` | Model, quality, budget (the existing command) |

### 1.4 IPC (`invoke(channel, request)`)

| Channel | Request → response |
|---|---|
| `images:prompt` | `{ entityId, kind, requestId? }` → `{ ok, prompt, claudeCostUsd } \| { ok: false, error }`. Claude (Haiku) writes the prompt. Costs Claude tokens, not OpenAI |
| `images:estimate` | `{ kind, model?, quality?, size?, calls?, promptChars? }` → `{ model, quality, size, calls, perCallUsd, totalUsd, remainingUsd }` |
| `images:generate` | `{ requestId, entityId, kind, prompt, model?, quality?, size?, reference?, select? }` → `ImageResult` = `{ ok: true, image: ImageMeta, receipt } \| { ok: false, error, receipt? }`. Files written, `image.add` dispatched (one undo step, selected unless `select: false`) |
| `images:iconFromConcept` | `{ entityId, from?, select? }` → `ImageResult`. Free: the `item` pixel filter over the concept, no API call |
| `images:batchPlan` | `{ kind, entityIds, replace?, model?, quality?, size?, requestId? }` → `{ items: [{ entityId, name, prompt?, line?, skip?, error? }], calls, estimate, claudeCostUsd, model, quality, size, kind, sheets? }`. No OpenAI call. **Concepts:** Claude writes each prompt (`prompt`); run with `images:batchRun`. **Icons:** `sheets: [{ index, cols, rows, size, items: [{ entityId, name, line }], estimateUsd }]`, each item gets a deterministic `line` (no Claude call), `calls` counts sheets; run with `images:sheetRun` |
| `images:batchRun` | `{ batchId, kind, items: [{ entityId, prompt }], model?, quality?, size?, select? }` → `{ batchId, items: [{ entityId, result: ImageResult }], costUsd, cancelled }`. Concurrency 2; progress on the `images:progress` event |
| `images:sheetRun` | `{ batchId, items: [{ entityId, line }], model?, quality? }` → `{ batchId, sheets: [{ ok: true, review, receipt } \| { ok: false, error, receipt?, entityIds }], costUsd, cancelled }`. **Icon batches (IMAGES.md §2a).** Main splits the items into sheets of ≤ 100 (as even as possible), one paid call each (2880×2880, the guide as the reference), one after another. Each sheet is kept in the world (kind `sheet`); **its cells are not icons yet.** Progress on `images:progress` (`total`/`done` count sheets) |
| `images:sheetCrop` | `{ entityId, imageId }` (the sheet) → `SheetReview \| null`. Re-crops a kept sheet. Free |
| `images:sheetAccept` | `{ entityId, imageId, cells: number[], select? }` → `{ ok: true, images: ImageMeta[] } \| { ok: false, error }`. Accepted cells become icons, **one undo step** ("Accept N icons"). Free |
| `images:cancel` | `{ id }` (a generate's `requestId`, a plan's `requestId` or a `batchId`) → `{ ok: true }` |
| `images:status` | `null` → `ImageStatus` = `{ mode: 'real' \| 'fake' \| 'off', enabled, reason?, model, quality, spend: { sessionUsd, monthUsd }, budget, paused, pending }` |
| `images:file` | `{ entityId, imageId, variant?: 'png' \| 'src' \| 'thumb' }` → `{ dataUrl, width, height } \| null`. `thumb` is at most 256px. The CSP allows `data:` images |
| `images:deleteFiles` | `{ entityId? }` → `{ removed, bytes }`. "Delete image files": purges the pixels of images no longer in the world, and first removes from the world the images of entities that no longer exist (one undo step, which brings back their metadata but not their pixels). Confirm first |
| `images:log` | `{ limit? }` → `ImageLogEntry[]` (provider, model, size, quality, usage, cost, latency, outcome, image id) |

`SheetReview` = `{ sheet: ImageMeta, preview: { dataUrl, width, height } (≤ 1024px), cells: [{ index, entityId, row, col, flags, crop: {…} \| null (≤ 128px), icon: {…} \| null (16×16) }] }`.
Flags: `empty`, `background_only`, `touches_edge`, `fragmented`. "Regenerate flagged" is a new
`images:sheetRun` with just those items. `images:batchRun` still works for icons (one call each), but
the batch dialog should use sheets.

**Events:** `images:status` (ImageStatus), `images:progress` (`{ batchId, total, done, running, item?, costUsd }`),
`images:logged` (a new `ImageLogEntry`).

**Errors** (`error.code`): `disabled`, `no_key`, `budget`, `cancelled`,
`rate_limited`, `server`, `network`, `timeout`, `refused`, `bad_request`,
`not_found`, `invalid_output`, `prompt_failed`, `io`, `unknown`.
`error.unknownOutcome: true` means a request was sent and its outcome is
unknown (it may have been charged); say so, and never retry it automatically.

### 1.5 The fake

`CARBON_IMAGES=fake` (the e2e harness and `npm run dev:sample` set it) runs
the whole pipeline over a deterministic provider: the same prompt gives the
same image (a gradient and a disc seeded by the prompt's hash; for a sheet
prompt, one disc per cell on transparency), with usage shaped like the real
calls' (§4), so spend, the budget pause, the log, batches, sheets and progress
all behave as with OpenAI.
`CARBON_IMAGES_DELAY_MS` adds latency (to see progress);
`CARBON_IMAGES_FAIL=<code>` makes every paid call fail with that code. Prompts
come from the AI gateway (`CARBON_AI=fake` writes a deterministic prompt).

**Realistic fixtures for screenshots** are in `fixtures/images/`: two concept
images (1536×1024, flare and sunburst), a 1024² concept, four icon sources
(transparent, 1024²) with their 16×16 icons, an icon made by editing the
concept, and a real 100-icon sheet (stored at 1440², half size) with its
review. `calls.json` holds each call's prompt, usage, cost and latency.

---

## 2. What was built

| Area | Where |
|---|---|
| **Model** (IMAGES.md §3): `ImageMeta`, `world.images` (canonical: sorted, no empty entries, absent when empty), `settings.art`, `settings.images` | `src/core/images/model.ts`, `pricing.ts`; additive keys in `src/core/model/world.ts` |
| **Commands**: `image.add`, `image.select`, `image.unselect`, `image.remove`, `art.set`, and `imagesProblems` (the canonical-form check, run by `checkPatched` on every patch to `images`) | `src/core/images/commands.ts` |
| **Store**: `images/<entity>/<id>.json` and `selected.json` are world files (read, written per patch, quarantined when invalid, applied from external edits); PNGs are written atomically by main, before `image.add`; `.gitattributes` gets `*.png binary` with the first image | `src/core/images/files.ts`, hooks in `core/files/world-files.ts`, `main/store/world-dir.ts`, `main/store/apply-files.ts`; `ensureGitAttributes` in `main/images/gateway.ts` |
| **Provider** (§4): `ImageProvider`, `OpenAiImageProvider` (official `openai` SDK 7.51: `images.generate`, `images.edit` with the reference; PNG; transparent background for icons and sheets; SDK retries off), typed errors, `FakeImageProvider` | `src/main/images/provider.ts` |
| **The key**: keyring (`secret-tool`, service `carbon`, account `openai-api-key`), then `OPENAI_API_KEY`; `CARBON_KEYRING=off` skips the keyring. Never logged or written | `src/main/images/key.ts` |
| **Gateway**: prompt, estimate, generate, icon from concept (free), batch plan and run (concurrency 2, cancellable, progress), sheets (run, crop, accept), files as data URLs (thumbnails cached), "Delete image files", the log, the budget and status | `src/main/images/gateway.ts`, `module.ts` (IPC), `index.ts` (mode) |
| **Icon sheets** (§2a): deterministic item lines, splitting into sheets of ≤ 100, the sheet prompt; one call per sheet with the guide as the reference; crop, flags, filter, review; accept as one undo step | `src/core/images/sheet.ts`, gateway, `src/main/images/pixel.ts` (adapter) |
| **Pixel adapter**: `filterImage`, `sheetLayout`, `drawGuide`, `cropSheet` with pixel's exact names and shapes | `src/main/images/pixel.ts` |
| **`image_prompt`** (Haiku, through the existing gateway and registry): builder, schema, parse, fake answer | `src/core/images/prompt.ts`, one line each in `core/ai/moments.ts`, `core/prompts/registry.ts`, `core/ai/fake.ts` |
| **Export** (§6): the spec gets an "Images" section listing each entity's icon and concept paths; the files are copied to `exports/<spec>/images/<entity>.<kind>.png`; undo removes them, redo copies them again | `src/core/images/export.ts`, `main/store/exports.ts` |
| **Budget**: an OpenAI meter separate from Claude's (session and month, month read back from the log), exact in nano-dollars, pauses at the limit, resumes when `settings.images.budget` is raised | gateway |
| **The log**: `ai-log/images-<date>.jsonl`, one line per attempt: provider, model, size, quality, usage, cost (and whether from usage or estimated), latency, outcome, request id, image id, batch id | `src/main/images/log.ts` |
| **Smoke test**: `npm run smoke:images` (real calls; `-- --proxy` where the network injects the key) with a ledger that refuses to pass 12 calls | `scripts/smoke-images.mjs`, `src/main/images/smoke.eval.ts` |

## 3. Decisions

1. **`world.images` is optional and canonical.** Absent when empty, no empty
   entity entries, versions sorted by ULID. Adding it as optional kept every
   existing `World` literal valid, and the canonical form makes save → reload
   exact (the store's round-trip property now covers images).
2. **Images of a deleted entity stay in the world.** `entity.delete` is
   foundation's and doesn't know about images. Keeping them means undoing the
   delete brings the images back, and "Delete image files" removes them.
3. **Selections live in `images/<entity>/selected.json`,** separate from each
   image's `.json`, so choosing an image rewrites one small file. A selection
   naming a missing image is reported (`image.selection`) and ignored, never
   quarantined.
4. **A concept has no `.src.png`.** Its `.png` is the provider's image, so a
   copy would be identical. Icons keep the provider image (or the sheet crop)
   as `.src.png`, so re-filtering is free.
5. **No automatic retry, except a 429.** A rate limit is known not to have
   run, so it waits (`retry-after`, capped at 30 s) and tries again, at most
   twice. Nothing else is retried: 5xx, refusals, timeouts and dropped
   connections are typed errors. A timeout, a reset connection or an abort
   after sending is `unknownOutcome: true`, and **its estimate is counted
   against the budget**, because it may have been charged. A refused
   connection (`ECONNREFUSED`, DNS) is known never to have been sent.
6. **Costs come from the response's usage.** OpenAI reports
   `input_tokens_details.{text_tokens,image_tokens}` and `output_tokens` for
   the 2.6 models; the estimate is used only when no usage comes back. Spend is
   summed in integer nano-dollars, as review-b did for Claude.
7. **Sheet lines are written by carbon, not Claude.** A 100-icon sheet would
   otherwise need 100 Haiku calls before anything is shown. The line is the
   name, the subkind and materials, and the identity; the dialog can edit it.
   Concepts still get Claude's prompt per entity.
8. **Sheets run one at a time.** Each is already up to 100 icons, and a second
   concurrent 2880² call buys little.
9. **A sheet belongs to the entity in its first cell** (`ImageMeta.entity`
   must be an entity id), and it's never selected. Its grid is stored with
   it, so `sheetCrop` re-crops it for free at any time.
10. **The sheet size is 2880×2880**: the guide says custom sizes are multiples
    of 16 up to 8,294,400 pixels, so 2880² is the largest square, and the
    real call (§5) accepted it as an edit with the guide.
11. **The crop keeps what's centred in the cell.** On the real sheet the
    model keeps its own even grid (288 px pitch), which drifts up to about
    28 px from the layout's (gutter 58, cell 224). Cutting at half a gutter
    flagged 54 of 100 perfect sprites. The adapter now searches a full gutter
    around the cell, labels connected parts, and keeps those whose centre lies
    in the cell: 0 flags on the real sheet, in 0.7 s. **For pixel:** the same
    rule would help `cropSheet`; the regression test is in `sheet.test.ts`
    ("the recorded real sheet").
12. **Files cross IPC as data URLs.** The CSP already allows `data:` images,
    and a custom protocol would mean editing foundation's bootstrap.
    Thumbnails (≤ 256 px) are cached in main.
13. **Export appends its own "Images" section** to the spec rather than
    relying on the `spec_draft` model to list paths, so the paths are always
    exact.
14. **A key-shaped string in a prompt is refused** before anything is sent,
    as review-b does for Claude.

## 4. Pricing (verified 2026-11-05)

**Source:** <https://developers.openai.com/api/docs/pricing> (from
`platform.openai.com/docs/pricing`) and the model pages for
`gpt-image-2.6-flare` and `gpt-image-2.6-sunburst`, read on **2026-11-05**.
`openai.com/api/pricing` answered 403. Recorded in the code as
`PRICING_VERIFIED` / `PRICING_SOURCE` and in `settings.images.pricingVerified`.

| Per 1M tokens | 2.6-flare | 2.6-sunburst | 2.5-flare |
|---|---|---|---|
| Text input | $5.00 | $5.00 | $5.00 |
| Image input | $8.00 | $8.00 | $8.00 |
| Image output | $30.00 | $30.00 | $30.00 |

Cached input ($1.25 text, $2 image) applies only to the Responses API, not
the Images API, so it isn't used. OpenAI publishes **no per-image prices** for
these models, so the estimate uses output tokens per image
(`OUTPUT_TOKENS_BY_MODEL`). **M** marks a measured value and **D** a derived one.

**gpt-image-2.6-flare and 2.6-sunburst** (the same table):

| Output tokens | 1024² | 1536×1024 / 1024×1536 | 2880² (sheet) |
|---|---|---|---|
| low | **824 M** (both models) | **664 M** (both models; 1024×1536 taken as equal) | **2,768 M** (flare, an edit with the guide) |
| medium | **1,449 M** (the coordinator's controlled run) | 1,168 D | 4,868 D |
| high | 12,602 D | 10,305 D | 42,333 D |

Medium at the other sizes is low × 1.7585, the measured medium/low ratio.
**High is unmeasured:** it is low × 15.3, OpenAI's ratio for the earlier GPT
Image models, which errs high.

**gpt-image-2.5-flare** (selectable, the cheaper option):

| Output tokens | 1024² | 1536×1024 / 1024×1536 | 2880² |
|---|---|---|---|
| low | **196 M** | 158 D | 658 D |
| medium | **439 M** | 354 D | 1,475 D |
| high | 1,729 D | 1,393 D | 5,810 D |

The other sizes scale like 2.6's measured low (× 0.806 and × 3.359). High is
medium × 3.94 (the earlier models' ratio) and is **unmeasured**.

A reference adds 1,024 image input tokens at 1024², and the 2880² guide added
1,521.

**So, per image at 1024²:** 2.6 low ≈ $0.025, 2.6 medium ≈ $0.044, 2.5-flare
low ≈ $0.006, 2.5-flare medium ≈ $0.013. A 1536×1024 concept on 2.6 low is
≈ $0.020, an edit ≈ $0.034, and a 100-icon sheet ≈ $0.106 (about a tenth of a
cent per icon). The defaults stay **gpt-image-2.6-flare, low**. Every price
can be overridden per model in `settings.images.pricing`, and a finished
call's cost always comes from its reported usage.

**Icons always send `background: 'transparent'`** explicitly, for generated
icons, edits from a concept and sheets, on every model. Without it, 2.5-flare
paints a fake checkerboard into the pixels, while 2.6 returns real alpha. Tests
check this at the gateway (for each model) and on the wire through the SDK.

## 5. Real calls and spend

The network proxy injected the key for `api.openai.com/v1/`; the SDK got the
placeholder `sk-proxy` (`npm run smoke:images -- --proxy`). The real key was
never read or printed. No safety check blocked anything. Every call went
through the real gateway and `OpenAiImageProvider`.

| # | Call | Model | Size | Endpoint | Usage (in / out) | Cost | Latency |
|---|---|---|---|---|---|---|---|
| 1 | Cloud Anklet icon | flare | 1024² | generate | 120 / 824 | $0.025320 | 7.3 s |
| 2 | Cloud Reef concept | flare | 1536×1024 | generate | 67 / 664 | $0.020255 | 8.5 s |
| 3 | Spore Lantern icon | flare | 1024² | generate | 119 / 824 | $0.025315 | 7.2 s |
| 4 | Spore Lantern concept | flare | 1024² | generate | 66 / 824 | $0.025050 | 6.7 s |
| 5 | Spore Lantern icon from the concept | flare | 1024² | edit | 129 text + 1,024 image / 824 | $0.033557 | 7.7 s |
| 6 | Glowmoss Caverns concept | sunburst | 1536×1024 | generate | 69 / 664 | $0.020265 | 28.0 s |
| 7 | Cinder Sting icon | sunburst | 1024² | generate | 120 / 824 | $0.025320 | 19.9 s |
| 8 | 100-icon sheet (10×10) | flare | 2880² | edit (guide) | 2,237 text + 1,521 image / 2,768 | $0.106393 | 30.0 s |
| | **Total: 8 calls, all low quality, all succeeded** | | | | | **$0.281475** | |

What they showed:

- `quality: 'low'` and `background: 'transparent'` are accepted by both 2.6
  models; icon sources came back about 60% transparent.
- Usage is reported with the text/image split, so every cost above is from
  usage, not an estimate.
- The 10×10 sheet came back with **all 100 items recognisable, each in its
  own cell** (the user's "about 99%" held here), at about $0.001 per icon.
- sunburst took 2–4× longer than flare at the same price.

The ledger is `fixtures/images/ledger.json` (8 of 12; the script refuses to go
past 12).

## 6. Tests

- **Core** (`src/core/images/images.test.ts`, 12): property tests that image
  commands (with entity deletes mixed in) keep `world.images` canonical and
  the world valid, with every inverse exact; that writing only a patch's files
  equals a full write, and save then load gives the world back; bad files and
  their quarantine codes; pricing in exact nano-dollars; the prompt ask
  (conventions, palette words, art direction); export paths; the
  `image_prompt` builder and parse.
- **Store**: the store's own round-trip property (`roundtrip.test.ts`, any
  sequence of every command kind with undo/redo, saved and reopened) now
  includes the image and art commands; `files.test.ts` adds a property that
  external edits of image files applied incrementally equal reading every file.
- **Gateway** (`gateway.test.ts`, 24): concept and icon end to end on disk,
  icon from concept for free, an edit sends the reference, files and
  thumbnails, timeout counted at its estimate and not retried, 5xx / refusal /
  bad request / no key not retried and free, 429 retried with `retry-after`,
  a non-PNG answer, a key in the prompt, off, cancel, the exact budget pause
  and resume, the month spend read back, batch plan and run (concurrency 2,
  ordered results, progress), cancel and budget mid-batch, "Delete image
  files", `.gitattributes`.
- **Provider** (`provider.test.ts`, 12): the real SDK over a stubbed `fetch`,
  answering with the **recorded real PNGs and usage**: the generate and edit
  request shapes, recorded cost equals the pricing table, real icon sources
  are transparent and filter to hard-alpha 16×16; 429 with `retry-after`, 5xx,
  content-policy refusals (`moderation_blocked` and a safety message), 401/403,
  a timeout, refused vs reset connections, an empty 200, aborts before and
  after sending.
- **Sheets** (`sheet.test.ts`, 9): splitting, lines, the prompt, plan → run
  (one edit call with a 2880² guide) → review → accept as one undo step →
  reload → undo → free re-crop; two sheets and cancel; refusals; the budget;
  and the **real 100-icon sheet** crops to 100 sprites, centred, with ≤ 5
  flags (it failed with 53 before the crop fix).
- **Export** (`export.test.ts`, 2): copied images, the spec's section, undo
  and redo.
- **e2e** (`e2e/images-core.spec.ts`, 2, one `@smoke`): status, prompt,
  estimate, generate, the metadata on disk, icon from concept, thumbnails, the
  log, spend, undo; concept batch; icon sheet run, review and accept.

Unit tests overall: 813 after merging the base (812 passed, 1 skipped as before). Core coverage stays
above the threshold: `src/core/images` is 98.8% of lines.

## 7. Shared files touched (all additive)

| File | Change |
|---|---|
| `src/core/model/world.ts` | `World.images?`, `Settings.art?`, `Settings.images?` |
| `src/core/model/model.test.ts` | Labels for the five new commands |
| `src/core/commands/registry.ts` | `...imageCommands` |
| `src/core/commands/apply.ts` | `checkPatched` runs `imagesProblems` on patches to `images` |
| `src/core/files/world-files.ts` | Image files in `worldFromFiles`, `worldToFiles`, `filesForPatch` |
| `src/core/ai/moments.ts`, `src/core/ai/fake.ts`, `src/core/prompts/registry.ts` | The `image_prompt` moment, its fake answer and builder |
| `src/core/prompts/prompts.test.ts`, `limits.test.ts` | The new moment in the per-moment tests (including the 100k limit with a maximal art direction) |
| `src/core/testing/arbitraries.ts` | Image and art commands in `everyCommandArb`; `imageMetaArb`, `IMAGE_ID_POOL` |
| `src/main/store/world-dir.ts`, `apply-files.ts` | Reading `images/*/` JSON; external edits of image files |
| `src/main/store/exports.ts` | Images copied beside the spec, with the undo effect |
| `src/main/store/roundtrip.test.ts` | Images in the start world, so selects and removes land |
| `src/renderer/ai/AiLog.tsx` | One label for the new moment (the `Record<Moment, string>` needed it) |
| `src/shared/ipc.ts` | The `images:*` channels and events |
| `e2e/harness.ts`, `scripts/dev-sample.mjs` | `CARBON_IMAGES=fake` |
| `package.json` | `openai`, `pngjs`, `@types/pngjs`; `smoke:images` |
| `.gitattributes` | `*.png binary` (the repo's fixtures) |

## 8. Gaps

- **The pixel filters are an adapter** (`src/main/images/pixel.ts`) until the
  pixel branch merges. The 16×16 icons from it are recognisable but mushy:
  box averaging with no outline or palette work. Swapping in `@core/pixel` is
  one file; the gateway uses only `filterImage`, `sheetLayout`, `drawGuide`
  and `cropSheet`. Pixel's `iconPrompt` and `sheetPrompt` aren't used yet: the
  icon conventions and the sheet prompt are in `src/core/images/prompt.ts`
  and `sheet.ts`, with the same house style. Merging should move to pixel's
  prompts, but keep this branch's centred-in-cell crop rule (§3.11) or its
  test will fail.
- **Medium and high quality are unmeasured** (§4); their estimates are
  extrapolated. The first medium call will show the real number, and the cost
  will come from its usage either way.
- **No content-policy refusal was triggered for real** (deliberately); the
  refusal shapes are from OpenAI's documented error and tested through the
  SDK.
- **The guide isn't stored** with a sheet: it's drawn again from the stored
  grid, deterministically, whenever it's needed.
- **"Delete image files" can't be undone for pixels.** Undoing a removal after
  a purge brings the metadata back, and `images:file` returns `null` for it.
- **No `count_tokens`-style check for prompts:** prompts are capped at 32,000
  characters by the schema (OpenAI's limit), which is all the Images API needs.
- **The keyring needs `secret-tool`,** as for Claude's key; without it, only
  `OPENAI_API_KEY` works.
