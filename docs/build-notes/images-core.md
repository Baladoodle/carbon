# Build notes: `images-core`

Branch `claude/blissful-einstein-8u27ty-images-core`. The non-UI half of
`docs/IMAGES.md`: the model, the store, the OpenAI provider, the gateway, the
budget and pricing, the `image_prompt` moment, art direction and export.

**Work in progress.** §1 (the contract for images-ui) comes first and is
stable. The rest of this file is filled in as the work lands.

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
  **Absent when there are no images**, and an entity's entry is absent when
  it has none. Read it as `world.images?.[id]`. `all` is sorted by id (oldest
  first; ids are ULIDs).
- `world.settings.art?: { direction: string; kinds: Partial<Record<EntityKind, string>> }`.
- `imageSettings(world.settings)` gives `{ model, quality, budget: { sessionUsd, monthUsd }, pricing, pricingVerified }`
  with defaults (`gpt-image-2.6-flare`, `low`, $1 per session, $10 per month).

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
| `images:batchPlan` | `{ kind, entityIds, replace?, model?, quality?, size?, requestId? }` → `{ items: [{ entityId, name, prompt?, skip?, error? }], calls, estimate, claudeCostUsd, model, quality, size, kind }`. Writes every prompt; no OpenAI call |
| `images:batchRun` | `{ batchId, kind, items: [{ entityId, prompt }], model?, quality?, size?, select? }` → `{ batchId, items: [{ entityId, result: ImageResult }], costUsd, cancelled }`. Concurrency 2; progress on the `images:progress` event |
| `images:cancel` | `{ id }` (a generate's `requestId`, a plan's `requestId` or a `batchId`) → `{ ok: true }` |
| `images:status` | `null` → `ImageStatus` = `{ mode: 'real' \| 'fake' \| 'off', enabled, reason?, model, quality, spend: { sessionUsd, monthUsd }, budget, paused, pending }` |
| `images:file` | `{ entityId, imageId, variant?: 'png' \| 'src' \| 'thumb' }` → `{ dataUrl, width, height } \| null`. `thumb` is at most 256px. The CSP allows `data:` images |
| `images:deleteFiles` | `{ entityId? }` → `{ removed, bytes }`. Purges the files of images no longer in the world. Confirm first |
| `images:log` | `{ limit? }` → `ImageLogEntry[]` (provider, model, size, quality, usage, cost, latency, outcome, image id) |

**Events:** `images:status` (ImageStatus), `images:progress` (`{ batchId, total, done, running, item?, costUsd }`),
`images:logged` (a new `ImageLogEntry`).

**Errors** (`error.code`): `disabled`, `no_key`, `budget`, `cancelled`,
`rate_limited`, `server`, `network`, `timeout`, `refused`, `bad_request`,
`not_found`, `invalid_output`, `prompt_failed`, `io`, `unknown`.
`error.unknownOutcome: true` means a request was sent and its outcome is
unknown (it may have been charged); say so, and never retry it automatically.

### 1.5 The fake

`CARBON_IMAGES=fake` (the e2e harness sets it) runs the whole pipeline over a
deterministic provider: the same prompt gives the same image (a gradient and
shapes seeded by the prompt hash), with fake usage and costs, so spend, the
budget pause, the log, batches and progress all behave as with OpenAI.
`CARBON_IMAGES_DELAY_MS` adds latency (to see progress);
`CARBON_IMAGES_FAIL=<code>` makes every paid call fail with that code. Prompts
come from the AI gateway (`CARBON_AI=fake` writes a deterministic prompt).
