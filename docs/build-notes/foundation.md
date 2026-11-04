# Build notes: `foundation` (Phase 0)

Branch `claude/blissful-einstein-8u27ty-foundation`. Everything in `BUILD.md` §4
is done, and `npm run check` passes.

- **Contract for package workers:** §1. Read it before you write code; the UI kit is §1.6a.
- **Decisions where I interpreted the docs:** §2.
- **Status, test counts, the API check and spend:** §3.

---

## 1. The contract

### 1.1 Where things live

```
src/
  core/                 PURE. No Node, Electron, React, SDK, clock or randomness (lint-enforced)
    model/              domain model: zod schemas + inferred types
      kinds.ts          ENTITY_KINDS, ENTITY_STATES, LANES, LANE_OF_KIND, ITEM_SUBKINDS
      fields.ts         FieldDef, field types, fieldValueSchema(def), Height, Climate, Step
      schema.ts         KindDef, AttributeDef, RelationTypeDef, WorldSchema, SchemaFile (schema.json), resolveSchema
      defaults.ts       DEFAULT_SCHEMA: the 8 kind schemas and 12 relation types, AS DATA
      entity.ts         EntitySchema (common fields), Relation, Origin, Killed
      world.ts          World (the whole document), Settings, Numbers, Taste, SpreadRecord, schemaOf(), emptyWorld()
      lifecycle.ts      TRANSITIONS, canTransition, requiredFor, missingFor, fieldValue
      validate.ts       entityProblems, referenceProblems, cycleProblems, validateWorld → Problem[]
      notes.ts          Note (shared by checks and critique)
    commands/           patch.ts (set/remove ops, inverses), define.ts, entity-commands.ts,
                        world-commands.ts, registry.ts (COMMANDS, Command, cmd), apply.ts
                        (applyCommand, applyCommands = transaction), history.ts (undo/redo), diff.ts
    files/              entity markdown ⇄ Entity; World ⇄ files; filesForPatch (only touched files)
    ai/                 moments.ts (per-moment request/result schemas), gateway.ts (AiGateway),
                        fake.ts (FakeAiGateway), off.ts (OffAiGateway)
    testing/            sampleWorld(), fast-check arbitraries (tests only)
    util/               Result, Json, deepEqual, stableStringify, hashValue, seededRandom
  shared/ipc.ts         THE IPC CONTRACT: INVOKE (request/response) and EVENTS tables, CarbonBridge
  main/                 index.ts (bootstrap), ipc.ts (handle/send/registerIpc), world-session.ts,
                        modules.ts (package hook), config.ts (world dir), store/ (basic), ai/index.ts
  preload/index.ts      window.carbon: allow-listed, typed bridge
  renderer/
    ui/                 THE COMPONENT KIT (VISUAL.md §5) + tokens.css, base.css, kit.css, tokens.ts, icons
    shell/              App, Rail, StatusLine, shell.css
    views/<id>/view.tsx one folder per view, found automatically (registry.ts, define.ts)
    bench/Bench.tsx     stub (W1 replaces)
    palette/Palette.tsx stub (W6 replaces)
    ai/client.ts        `ai`: the AiGateway over IPC; useAiStatus; ai/AiLog.tsx stub (W4 replaces)
    state/              store.ts (createStore/useStore), world.ts (mirror + dispatch), ui.ts, notes.ts
    actions.ts          action registry = keymap + palette source
    bridge.ts           invoke/on with zod validation
    components/         two superseded files, unused (see §3)
fixtures/worlds/sample/ the sample world (generated from src/core/testing/sample.ts)
e2e/                    harness.ts (launchCarbon), smoke.spec.ts
scripts/                run-e2e.mjs, smoke-ai.mjs, eval.mjs (stub for W4), dev-sample.mjs, ensure-electron.mjs
```

Path aliases: `@core/*`, `@shared/*`, `@main/*`, `@renderer/*`. They work in
the build, Vitest and Playwright.

**Layer rules (ESLint fails the build if broken):**

- `src/core` imports nothing from Node, Electron, React, the SDK or the outer
  layers. `Math.random`, `Date.now`, `new Date()`, `process`, `window` and
  `fetch` are banned there. Pass time in through `CommandContext.now` and
  seeds through `seededRandom(seed)`.
- `src/shared` uses only core and zod.
- `src/renderer` never imports Node, Electron or `src/main`. It talks to main
  only through `window.carbon`, via `renderer/bridge.ts`.
- `src/main` never imports the renderer.

### 1.2 Scripts

| Script | What it does |
|---|---|
| `npm run dev` | `electron-vite dev` on your world (`--world <dir>`, `CARBON_WORLD_DIR`, `<userData>/settings.json`, or `~/infinite-bible`) |
| `npm run dev:sample` | dev on a scratch copy of the sample world, with the fake AI |
| `npm run build` | builds main, preload and renderer into `out/` |
| `npm run check` | lint, prettier check, `tsc --noEmit`, unit tests, then the build plus the `@smoke` e2e tests. **Must pass before every push.** |
| `npm test` | Vitest (unit and property tests). `npm run test:coverage` enforces ≥90% lines and functions on `src/core` |
| `npm run test:e2e` | builds, then the full Playwright suite (under `xvfb-run -a` when there's no display). Extra args go to Playwright, e.g. `npm run test:e2e -- --grep column` |
| `npm run fixtures:sample` | regenerates `fixtures/worlds/sample/` from `sampleWorld()` |
| `npm run smoke:ai` | one tiny real call to `claude-haiku-5-5` (needs the key). W4 may route it through the real gateway |
| `npm run eval` | stub. W4 makes it run `evals/` |
| `npm run dist` | build plus electron-builder (AppImage + dir). W6 owns packaging |

### 1.3 The domain model in 60 seconds

- **`World`** (`core/model/world.ts`) is one JSON document:
  `{ settings, schema, entities, numbers, taste, spreads }`. The main process
  holds the truth. The renderer holds a mirror.
- **`Entity`** has the common fields from SYSTEM §3 (`id`, `kind`, `name`,
  `identity`, `description`, `state`, `why`, `tags`, `attributes`,
  `relations`, `origin`, `ai_fields`, `created`, `updated`, plus an optional
  `killed`). **Kind-specific values live in `entity.fields[key]`**, keyed by the
  kind schema. An absent key means empty.
- **Kind schemas are data:** `DEFAULT_SCHEMA` merged with the world's
  `schema.json` gives the effective schema. Always read it with
  `schemaOf(world)`, which is memoised. Every Bench form, Codex column and AI
  prompt should be driven from `schemaOf(world).kinds[kind].fields` and
  `.attributes`, never from hard-coded field lists.
- **Relations** are stored on the source entity as `{ type, target, note? }`.
  The rules live in `schemaOf(world).relations[type]`: `from`, `to`,
  `symmetric` and `acyclic`. Symmetric relations are stored on both ends, and
  the commands keep both ends in sync.
- **Validation:** `validateWorld(world)` returns `Problem[]`, each with a
  severity. Errors are invalid. Warnings (a dangling relation, an unknown
  field, a missing symmetric end) are tolerated on load, but **a command may
  never introduce one**.
- **Lifecycle:** `TRANSITIONS`, `canTransition` and `missingFor(schema,
  entity, state)` (the Why gate and required fields). `entity.setState`
  enforces them.

### 1.4 Commands, undo and transactions

Every change is a command `{ type, payload }`. A command is applied in main,
recorded for undo, persisted, and pushed to the renderer as a patch.

**Dispatching from the renderer:**

```ts
import { cmd } from '@core/commands/registry';
import { dispatch, transact } from '@renderer/state/world';

const r = await dispatch(cmd('entity.create', { kind: 'item', name: 'Glass Lung', fields: { subkind: 'accessory' } }));
if (!r.ok) flash(r.error.message, 'error');               // r.error.code is stable, e.g. 'state.missing_fields'

// Several commands = one undo step (a transaction):
await transact('Merge 3 candidates', [cmd(...), cmd(...), cmd(...)]);
```

**Built-in commands:**

| Type | Payload (abridged) |
|---|---|
| `entity.create` | `{ kind, name, id?, identity?, description?, why?, tags?, fields?, attributes?, relations?, origin?, ai_fields? }`. Kind field defaults are applied. Always starts as `idea` |
| `entity.update` | `{ id, set: { [commonOrKindField]: value \| null }, source?: 'user' \| 'ai' }`. `null` clears. `source: 'ai'` adds the `ai` marker; `user` removes it |
| `entity.setField` | `{ id, field, value, source? }`. One field |
| `entity.delete` | `{ id }`. Cascades: removes inbound relations and clears `ref` fields pointing at it |
| `entity.setState` | `{ id, state, why?, killed? }`. Enforces transitions and required fields; graveyard needs `killed: { reason, note? }` |
| `entity.setAttribute` | `{ id, key, value: number \| null, source? }` |
| `relation.add` / `relation.remove` | `{ from, type, to, note? }`. Enforces kinds, no self relations, no duplicates and acyclicity; mirrors symmetric relations |
| `schema.setKind` | `{ kind, override \| null }`. Replaces that kind's `schema.json` override |
| `schema.setAttributeDef` | `{ kind, def }` (W3) |
| `schema.setRelationType` | `{ type, def \| null }` |
| `numbers.setVariable` / `numbers.setFormulas` | `{ name, value \| null }` / `{ source }` (W3) |
| `settings.set` | `{ key, value }`. One top-level key of `carbon.json` (`format` excluded) |
| `taste.set` | `{ rules?, reasons?, patterns? }`. Replaces whole lists (W5 can add finer commands) |
| `spread.put` / `spread.remove` | `{ record }` / `{ id }` (W5) |

Editing an `exported` entity moves it back to `decided` automatically
(EXPERIENCE §8). Schema changes that would make any entity invalid are refused.

**Adding a command (in your own folder):**

```ts
// src/core/spreads/commands.ts
import { z } from 'zod';
import { defineCommand } from '../commands/define';
import { ok, err } from '../util/result';

export const spreadCommands = {
  'spread.keep': defineCommand({
    payload: z.object({ spreadId: z.string(), key: z.string() }),
    label: (p) => `Keep ${p.key}`,
    plan(world, p, ctx) {          // pure: (world, payload, {now}) → Result<Patch>
      return ok([{ op: 'set', path: ['spreads', p.spreadId], value: { ...world.spreads[p.spreadId]!, kept: [p.key], updated: ctx.now } }]);
    },
  }),
} as const;
```

Then add **one line** to `src/core/commands/registry.ts`:
`...spreadCommands,`. That line is the only shared edit. `applyCommand` does the
rest: it validates the payload, applies the patch, computes the inverse and
checks the world is still valid. Prefer composing existing commands in a
transaction over writing new ones that touch entities directly.

**Patch rules (`commands/patch.ts`):** ops are `{ op: 'set', path, value }`
and `{ op: 'remove', path }`. Paths are object keys only, so arrays are
replaced whole, and every intermediate object must exist. Inverses are exact:
the property tests prove `apply(inverse(apply(w)))` deep-equals `w`.

**Undo/redo:** they live in the main process (`WorldSession`). The shell binds
`ctrl+z` and `ctrl+shift+z`/`ctrl+y`. Accepting an AI suggestion is just a
command with `source: 'ai'`, so it undoes like any other. From the renderer,
call `undo()` and `redo()` in `state/world.ts`.

### 1.5 Subscribing to state (renderer)

```ts
import { useWorld, useEntity, useWorldMeta, currentWorld } from '@renderer/state/world';
import { useUi, setUi, focusEntity } from '@renderer/state/ui';
import { useNotes, publishNotes } from '@renderer/state/notes';

const bands = useWorld((w) => entitiesOfKind(w, 'band'));   // re-renders only when the result changes (shallow)
const e = useEntity(focusId);                                // one entity
const { history, issues, dir, rev } = useWorldMeta();
const focus = useUi((s) => s.focus);                         // view, benchOpen, focus, selection, overlay
setUi({ selection: ['glide'] });  focusEntity('glide');
```

- `useWorld` returns `undefined` while the world is loading. Selectors may be
  inline closures. If a selector builds new arrays or objects, the default
  shallow equality keeps re-renders down; pass your own `equal` for deeper
  structures.
- `currentWorld()` reads the world in event handlers without subscribing.
- **Notes** (Column margin, Bench, status line): producers call
  `publishNotes(source, notes)`. Checks (W6) use `source = 'checks'` and AI
  critique (W4) uses `'ai:<entityId>'`. Readers call `useNotes(entityId?)`.
  `dismissNote(id)` exists, but its persistence (until the inputs change) is
  W6's.
- `createStore` and `useStore` (`state/store.ts`) are there for package-local
  stores.

### 1.6 Adding a view

Create `src/renderer/views/<id>/view.tsx`. Its default export is found
automatically, and no shared file changes:

```tsx
import { defineView } from '../define';
function ClimateView(): ReactNode { … }
export default defineView({ id: 'climate', label: 'Climate', key: '2', order: 2, glyph: '◫', component: ClimateView });
```

`id` must equal the folder name. The rail key `1`–`7` comes from `key`. The
seven placeholder views already exist, so **replace your folder's
`view.tsx`**, keeping the id, key and order. The view root renders inside
`<main data-testid="view-<id>">`. Owners: column → W1; climate and codex → W2;
numbers → W3; spread and taste → W5; export → W6.

**Keys and actions:** register what your view can do. Each action is both a
key binding and a palette entry:

```ts
useActions([
  { id: 'column.new', label: 'New entity here', group: 'Column', keys: ['n'], run: () => … },
  { id: 'column.down', label: 'Move down', keys: ['j', 'arrowdown'], run: …, hidden: true },
  { id: 'bench.suggest', label: 'Suggest one', keys: ['tab'], inInputs: true, enabled: () => !!field, run: … },
]);
```

The newest-mounted layer wins a key (overlay > view > shell). While you're
typing in an input, only keys with `ctrl`, `alt` or `meta`, `escape`, or
actions marked `inInputs: true` fire. Key syntax: `ctrl+shift+z`, `space`,
`tab`, `shift+tab`, `enter`, `escape`, `[`, `?` (shifted symbols have no
`shift+`).

The shell already binds: `1`–`7`, `b` (Bench), `ctrl+k` (palette), `ctrl+l`
(AI log), `ctrl+shift+a` (AI off), `ctrl+z`, `ctrl+shift+z`/`ctrl+y`, and
`escape` (close overlay). Status line messages: `flash(text, 'info' | 'error')`.

**Overlays:** set `setUi({ overlay: '<name>' })`. The shell renders `palette`
and `ai-log`. A package overlay renders itself when `useUi(s => s.overlay) ===
'<name>'`, inside its own view or component.

**Text rule (VISUAL.md §1):** a view shows only its content and controls: no
title, no subtitle, no key legends (keys go in `Tooltip keys=…`, `Menu` items
and the palette). With nothing to show, show nothing, or what's missing plus
the one key that fixes it. Look and components: §1.6a below.

### 1.6a The UI kit (`src/renderer/ui/`)

Build every UI from the kit and the tokens. **Never use raw hex colours.**

```tsx
import { Button, IconButton, Input, Textarea, Field, Select, Combobox, Popover, Menu, Tooltip,
         Dialog, toast, Tabs, Table, THead, TBody, TR, TH, TD, StateGlyph, Kbd, cx, IconPlus } from '@renderer/ui';
```

| Component | Use |
|---|---|
| `Button` | `variant`: `primary` (one per surface), `secondary` (default), `ghost` or `destructive`; `size`: `sm` or `md` |
| `IconButton` | Icon-only, with a required `label`, which becomes its tooltip and accessible name. Optional `keys` (shown in the tooltip) and `active` (the accent glow) |
| `Input`, `Textarea` | `invalid` and `mono`. **`suggestion`** shows the AI's suggestion inline in `--ai` at 70%: the part after a matching prefix, or `→ suggestion`. Accepting it (`tab`) is yours: set the value, then clear the suggestion |
| `Field` | Wraps one control with an optional `label` (only when it isn't obvious) and an `error` shown underneath. It wires `id`, `aria-invalid` and `aria-describedby` |
| `Select` | A short fixed list (`options: [{ value, label }]`), using Radix Select |
| `Combobox` | **The entity picker:** `items: [{ value, label, hint?, glyph? }]`, `value`, `onChange`. Type to filter; ↑/↓, enter and escape work |
| `Popover`, `Menu`, `Tooltip`, `Dialog` | Radix underneath, with overlay depth and blur from the tokens. `Dialog` needs a `title` (visually hidden unless `showTitle`) and takes a `footer`. `Menu` items: `{ label, onSelect, keys?, destructive?, disabled? }` or `'separator'` |
| `toast(text, { tone: 'info' \| 'error' \| 'ai', action? })` | Transient results (an error, an undo). `flash()` in `state/ui.ts` forwards to it |
| `Tabs` | Underline tabs: `tabs: [{ value, label, count? }]` |
| `Table` + `THead`/`TBody`/`TR`/`TH`/`TD` | Hairline rows and a sticky header (put the table in a scrolling container). `TR selected` gets the accent rule and `TR current` the cursor. `TH`/`TD numeric` are mono, tabular and right-aligned |
| `StateGlyph` | `state`, `size?`, `tooltip?`. The state is always this shape, never the word |
| `icons.tsx` | 16px stroke icons on `currentColor`. Add yours there |

**Tokens** (`ui/tokens.css`, mirrored in `ui/tokens.ts` for canvas and
computed SVG; a test keeps them in sync):

- surfaces: `--bg`, `--surface-1/2/3`, `--line`, `--line-strong`
- text: `--text`, `--text-2`, `--text-3`
- accent: `--accent`, `--accent-fg`
- states: `--state-idea/shaped/decided/exported`
- semantic: `--danger`, `--warn`, `--ai` (the AI's colour, and nothing else)
- type: `--font-ui`, `--font-mono`, `--text-meta/dense/body/name/title`
- shape: `--radius-control/card/overlay`, `--highlight`, `--shadow-overlay`,
  `--blur-overlay`, `--glow` (soft accent light for selection and the current
  position), `--ring`
- motion: `--ease`, `--dur-hover/panel/stream`; all are 0 under
  `prefers-reduced-motion`

`depthTint(y)` gives the Column's band tint (warm below, cool above, `--bg`
at 0).

**Utility classes:** `.mono`/`.num` (tabular), `.t-2`, `.t-3`, `.t-meta`,
`.t-dense`, `.t-ai`, `.t-danger`, `.t-warn`, and `.section-label` (11px
uppercase, Bench only).

**Fonts:** Inter Variable and Geist Mono Variable, bundled through
`@fontsource-variable`.

**Your own styles:** put them in a CSS file in your folder, imported from your
component, built from the tokens, with class names prefixed by your package
(`.column-…`).

**The gallery:** in dev and e2e builds, the palette's **UI kit** entry shows
every component in every state. `e2e/ui-kit.spec.ts` drives it, and
`docs/screens/foundation-ui-kit.png` is a screenshot of it.

### 1.7 IPC

`src/shared/ipc.ts` is the whole contract: `INVOKE` (`channel → { request,
response }` zod schemas) and `EVENTS` (`channel → payload`). State flows as a
`world:snapshot` once, then `world:patch` events numbered by `rev`; on a gap,
the renderer re-fetches the snapshot. The renderer calls
`invoke(channel, request)` and `on(channel, listener)` from
`renderer/bridge.ts`, which validate everything with zod.

**Adding a channel:**

1. Add it to `INVOKE` or `EVENTS` in `src/shared/ipc.ts`. Only add; never
   rename or remove.
2. Handle it in your main module (below) with `ctx.handle('x:y', (req) => …)`.
   The request arrives already validated.
3. Call it from the renderer with `invoke('x:y', req)`.

### 1.8 Main-process modules (packages that need main)

Create `src/main/<package>/module.ts`. It's found automatically and started
after IPC is registered:

```ts
import { defineMainModule } from '../modules';
export default defineMainModule({
  name: 'store',
  start({ session, ai, handle, send, window, info }) {
    const stopWatcher = watch(...);          // e.g. W6: external edits → session.applyExternal(world, issues)
    return async () => { stopWatcher(); };   // awaited on quit, before the final save
  },
});
```

`WorldSession` (`main/world-session.ts`) provides `world`, `snapshot()`,
`dispatch(commands, label?)`, `undo()`, `redo()`, `onPatch(fn)`,
`onSaveStatus(fn)`, `flush()` and `applyExternal(world, issues?)`. The last one
is for changes made outside carbon: it sends a minimal patch with cause
`external`, doesn't write back, and clears undo history.

**The store (`main/store/`, W6 hardens it):** `loadWorldDir` (creates the
layout if new), `readWorldFiles`, `writeChanges`, `writeWorldDir` and
`writeFileAtomic` (tmp + fsync + rename + dir fsync). The pure mapping lives in
`core/files/world-files.ts`: `PATHS`, `worldFromFiles` (invalid files are
reported as `LoadIssue`s and left out, never silently dropped),
`worldToFiles`, and `filesForPatch` (only touched files). Load issues show in
the status line ("N unreadable files"). **Quarantine, migrations, git
snapshots and the watcher are W6's.**

### 1.9 The AI: `AiGateway` and the fake

`src/core/ai/gateway.ts`:

```ts
interface AiGateway {
  run<M extends Moment>(moment: M, request: MomentRequest<M>, options?: { signal?: AbortSignal; onPartial?: (p: MomentPartial<M>) => void }): Promise<AiOutcome<M>>;
  status(): AiStatus;            onStatus(fn): () => void;
  setEnabled(on: boolean): void; log(limit?): Promise<AiLogEntry[]>;
}
type AiOutcome<M> = { ok: true; result: MomentResult<M>; meta: AiCallMeta } | { ok: false; error: AiError; meta?: AiCallMeta };
```

**Moments** (`moments.ts`, the single table `MOMENT_SCHEMAS`):

| Moment | Request | Result |
|---|---|---|
| `suggest_one` | `{ entityId, field, avoid? }` | `{ suggestion: { value, note? } }` |
| `suggest_three` | same | `{ suggestions: [3] }` |
| `fill_entity` | `{ entityId }` | `{ proposals: [{ field, value, note? }] }` |
| `critique` | `{ entityId, trigger: 'finish_edit' \| 'state_change' \| 'on_demand' }` | `{ notes: [{ kind, text, entities, field?, ruleId? }] }` |
| `spread` | `{ spot, move, direction?, count?, axes?, ruleIds? }` | `{ axes, candidates: Candidate[] }`. **Streams** candidates through `onPartial` |
| `patterns` | `{ judgements: [{ candidate, verdict, reason? }] }` | `{ patterns: [{ text, examples, strength, updates? }] }` |
| `spec_draft` | `{ entityIds, name }` | `{ title, markdown }` |

**Requests carry ids, not prompts.** The gateway in main builds the prompt from
the world (W4's context packer).

**Using it from a UI (W1, W2, W5, W6):**

```ts
import { ai, useAiStatus } from '@renderer/ai/client';
const ac = new AbortController();                       // one request per entity: abort the stale one
const out = await ai.run('spread', { spot: { type: 'cell', band: 'low-sky', lane: 'items' }, move: 'fill' },
                         { signal: ac.signal, onPartial: (c) => addToField(c) });
if (!out.ok) show(out.error.code /* disabled | no_key | budget | cancelled | rate_limited | … */);
```

Every result is already zod-validated. Turn a result into world changes with
commands, e.g.
`cmd('entity.update', { id, set: { [field]: value }, source: 'ai' })` or
`cmd('entity.create', { …candidate, origin: { by: 'ai', moment: 'spread', spread: id } })`.

**`FakeAiGateway`** (`core/ai/fake.ts`) is deterministic: same world and
request, same answer. Its output is schema-valid, references resolve, and
every proposal is accepted by the commands (the tests prove all three).
Spreads stream with one wildcard. Options: `delayMs` (latency) and `failWith`
(error UI). In the app it runs when `CARBON_AI=fake`, which `dev:sample` and
the e2e harness set; add `CARBON_AI_DELAY_MS=300` to see streaming. In unit
tests, use `new FakeAiGateway({ getWorld: () => world })`.

**For W4:** replace the real branch of `createAiGateway` in
`src/main/ai/index.ts`, keeping the `fake` and `off` branches. The
renderer-side `ai` client and the IPC (`ai:run`, `ai:cancel`, `ai:partial`,
`ai:status`, `ai:setEnabled`, `ai:log`) already forward everything. The off
switch, spend and pending count show in the status line, from `ai.status()`.

### 1.10 Fixtures

- `fixtures/worlds/sample/`: 24 entities, every kind and state, every relation
  type, numbers and a taste rule. It's **generated** from
  `src/core/testing/sample.ts` (`sampleWorld()`). To change it, edit
  `sample.ts` and run `npm run fixtures:sample`. A test fails if the two
  disagree.
- A new fixture world (e.g. W4's seeded-flaw worlds): add
  `fixtures/worlds/<name>/` (or put eval worlds under `evals/`). The easiest
  way to build one is in code, written with `writeWorldDir(dir, world)`.
- In unit tests, start from `sampleWorld()`. For property tests, use
  `commandArb(ids)` from `@core/testing/arbitraries`, which produces random
  valid and invalid commands.

### 1.11 End-to-end tests

```ts
import { expect, test } from '@playwright/test';
import { launchCarbon, type CarbonApp } from './harness';

let carbon: CarbonApp;
test.beforeAll(async () => { carbon = await launchCarbon(); });   // { world: 'sample' | '<fixture>' | null, env: {...} }
test.afterAll(async () => { await carbon.close(); });

test('column creates an entity with n', async () => {
  await carbon.gotoView('column', '1');
  await carbon.page.keyboard.press('n');
  …
  await carbon.screenshot('column-new');            // test-results/screens/; UPDATE_SCREENS=1 also copies to docs/screens/
});
```

- Each launch runs on a temporary copy of the fixture, with
  `CARBON_AI=fake`, a private userData directory and no Omarchy theme (Tokyo
  Night). `carbon.worldDir` is the copy, so you can assert on files.
- `carbon.dispatch(...commands)` and `carbon.invoke(channel, req)` drive the
  main process directly, which is handy for setup.
- Put your specs in `e2e/<package>.spec.ts`. Tag a fast test or two with
  `@smoke` in its title: `npm run check` runs only `@smoke`, and
  `npm run test:e2e` runs everything.
- Use stable selectors: `data-testid` (`shell`, `rail-<id>`, `view-<id>`,
  `bench`, `bench-entity`, `status-line`, `status-entities`, `status-ai`,
  `status-save`, `palette`, `ai-log`). Add your own in your views.
- Screenshots for `docs/screens/<slug>-*.png`: run
  `UPDATE_SCREENS=1 npm run test:e2e -- --grep <yours>`. The screen is
  1920×1080 under xvfb, the window 1440×900, at device scale factor 1.

### 1.12 Shared files: who may change what

| File | Rule |
|---|---|
| `src/core/model/*`, `src/shared/ipc.ts`, `package.json` | Add only; never rename or remove. Note it in your build notes |
| `src/core/commands/registry.ts` | Add your one `...yourCommands` line |
| `src/renderer/views/<id>/` | Owned by that view's package |
| `src/renderer/bench/` (W1), `palette/` (W6), `ai/` (W4), `src/main/store/` (W6), `src/main/ai/` (W4) | Owned; replace the stubs freely, keeping their exports (`Bench`, `Palette`, `AiLog`, `ai`, `createAiGateway`, `loadWorldDir`, `writeChanges`) |
| `src/renderer/shell/`, `state/`, `actions.ts`, `bridge.ts`, `main/index.ts`, `main/ipc.ts`, `world-session.ts` | Foundation's. Avoid edits: use `useActions`, view folders and main modules instead. If you must change one, keep it additive and note it |

---

## 2. Decisions where I interpreted the docs

1. **Kind-specific fields live in `entity.fields`, not flat on the entity.**
   This keeps "adding a field never needs new code" true and avoids collisions
   with common fields (the schema rejects a kind field that shadows one).
   `description` is the markdown body of the entity file. Everything else is
   YAML frontmatter, in a fixed key order for small git diffs.
2. **Fields that duplicate relations.** `biome.band` is a `ref` field, because
   a biome belongs to exactly one band and Climate is per band. Other
   entities use the `in_band` relation. `creature.drops`, `feat.unlocks` and
   `capability.gates` are text fields describing in words what the `drops` and
   `unlocks` relations hold structurally.
3. **Relation targets that aren't kinds.** `unlocks: feat → capability or
   slot`: a slot unlock is modelled as a capability ("Fourth accessory
   slot"), so the targets are capability or item. `counters: → creature or
   hazard`: hazards belong to bands and biomes, so the targets are creature,
   band or biome. Both are data in `DEFAULT_SCHEMA` and can be overridden in
   `schema.json`.
4. **Requirements per state accumulate** (`decided` needs everything `shaped`
   needs), and `decided`/`exported` always need `why`. Item: idea needs
   `subkind`; shaped needs `identity`, `change` and `tradeoff` (as the doc
   says); decided needs `moment` and `route`. The other kinds' lists are my
   choice, in `defaults.ts`.
5. **Lifecycle is exactly the diagram.** `decided → graveyard` and
   `shaped → idea` aren't allowed. Editing an `exported` entity (fields or
   attributes) moves it back to `decided`. I didn't add a persistent "flagged"
   marker; W6 can derive it from its export records if it wants the flag.
6. **An extra common field, `killed?: { reason, note? }`.** It records the
   kill reason when an entity goes to the graveyard, and is removed on
   resurrection.
7. **Ids are global slugs**, unique across kinds, so a relation is just a
   target id. `entity.create` derives a unique id from the name
   deterministically.
8. **Dangling references:** a warning on load (W6's checks report them) but an
   error if a command would introduce one. `entity.delete` cascades, removing
   inbound relations and clearing `ref` fields, so its inverse restores
   everything.
9. **Spreads are part of `World`** (`spreads: Record<id, SpreadRecord>`, loose
   records, one file each). Saving a spread, keeping candidates and merging
   can then be one transaction with one undo. W5 defines the record's shape
   beyond `id` and `created`.
10. **`carbon.json` settings are loose** (unknown keys kept), so packages can
    add settings (W1's saved layouts, W6's snapshot interval) without a
    migration. The budget defaults are $2 per session and $20 per month.
11. **AI requests carry ids and choices, never prompts.** Building the prompt
    from the world is the gateway's job, in main. Candidates have
    `kind: null` for findings (the Break move) and `about: <id>` for moves that
    change an existing entity (Ground, Cost, Name). `AiGateway.status()` is
    synchronous with `onStatus` for updates; `log()` is async.
12. **Notes live in a renderer store** (`publishNotes` and `useNotes`), not in
    the world, so mechanical checks can run on the renderer's mirror and
    critique results can be shown without persisting them.
13. **Undo history lives in main** (500 steps) and doesn't survive restarts.
    An external change clears it.
14. **Visual design (VISUAL.md, which arrived mid-build):** the Omarchy theme
    reading and Tokyo Night are gone, along with `core/theme`, `main/theme.ts`
    and the `theme:get`/`theme:changed` IPC channels. Nothing had merged yet,
    so no package depends on them. Carbon has one theme of its own, in
    `ui/tokens.css`. `ViewDef.glyph` became `ViewDef.icon` (a component). The
    shell follows the text rule:
    - The rail is icons only, with the name and key in a tooltip.
    - Views have no title.
    - The empty Bench and the unbuilt views show nothing.
    - The status line shows the entity count (the world directory is in its
      tooltip), notes and unreadable files only when there are some, AI spend
      in `--ai` (or "AI off: <reason>"), and the save state only while saving
      or after a failure. This is where EXPERIENCE §1's list and VISUAL §1
      differ: I followed VISUAL for the world directory and "saved".
    - Turning the AI off shows no toast, because the status line already
      changes.
15. **Tool versions:** Electron 45.2.2, electron-vite 6, Vite 8, React 19,
    zod 4, Vitest 5, fast-check 4. TypeScript is **6.0**, not 7, because
    typescript-eslint supports `<6.1`. `@playwright/test` is 1.63.0, matching
    the browser pre-installed in the container; Electron doesn't need it, but
    it avoids two Playwrights.
16. **`npm run check` runs the `@smoke` e2e subset**, as SYSTEM §9 ("the
    end-to-end smoke test"). `npm run test:e2e` runs the whole suite.
17. **Security:** `contextIsolation`, `sandbox: true`, no `nodeIntegration`, a
    CSP in `index.html`, external links open in the browser, and navigation is
    blocked. The preload is a single sandbox-safe CJS bundle.
18. **Single instance:** a second launch focuses the existing window
    (`requestSingleInstanceLock`). This is skipped under e2e.
19. **Placeholders:** Column lists the bands and Codex is a plain table that
    sets focus. They exist so the e2e flows and screenshots have something
    real; W1 and W2 replace them.

---

## 3. Status

**Checklist (BUILD.md §4):** project and scripts ✓; layers with lint
boundaries ✓; domain model ✓; commands, inverse patches, transactions,
undo/redo and property tests ✓; basic store ✓; IPC with a snapshot then
patches, plus the preload bridge ✓; `AiGateway` with `FakeAiGateway` ✓; UI
shell (frameless, rail `1`–`7`, status line, Bench panel, view registry,
palette stub, Omarchy tokens) ✓; sample world ✓; Playwright `_electron`
harness ✓; `npm run check` ✓.

**Tests:** 68 Vitest tests in 13 files, including property tests for patch
inverses, command validity and invertibility, transactions, undo/redo
sequences, files written only for a patch versus a full rewrite, and world
diffs. Core coverage is about 97% of lines and functions, and 90% of
branches. 7 Playwright e2e tests, all `@smoke` (including the UI kit:
inline AI suggestion, combobox by keyboard, dialog and escape, toast and
tooltip keys): launch, views 1–7 with
screenshots, Bench and focus, commands over IPC with persistence and undo,
the palette, and fake AI with the AI log and the off switch. `npm run check`
takes about 30 seconds.

**API check:** `ANTHROPIC_API_KEY` is **not set** in this container (checked by
name only; nothing printed). `npm run smoke:ai` exits with "not set", so no
call was made, no status code exists, and usage is zero. **API spend for this
package: $0.00.** W4 and W5 should check for the key before planning real
calls. Every test runs without it.

**Known gaps (for the packages):**

- The store's quarantine (invalid files are reported but left in place),
  migrations, git snapshots and external-edit detection are W6's.
- Notes dismissal persistence is W6's.
- The Bench, palette and AI log are stubs (W1, W6 and W4).
- The command palette lists actions and entities, but has no ranking (W6).
- `npm run dist` is configured (`electron-builder.json`). I verified that
  `electron-builder --linux dir` produces `dist/linux-unpacked/carbon` and
  that it opens the sample world. The AppImage target, the launcher and
  `install-omarchy.sh` are W6's.
- In this container Electron runs as root, so `npm run dev` needs
  `npm run dev -- --noSandbox` (and `xvfb-run -a`). On a normal desktop,
  plain `npm run dev` works.
- In dev only, the renderer's CSP also allows inline scripts, because React
  Refresh injects one (`carbon-dev-csp` in `electron.vite.config.ts`). Built
  and packaged apps keep `script-src 'self'`.
- Two superseded files are left in place, unused:
  `src/renderer/components/Placeholder.tsx` and `components/Kbd.tsx` (now
  `ui/Kbd`). A safety check in this environment blocked the command that
  would have removed them. Delete them by hand; nothing imports them.
- The Combobox renders its list only while open. Radix kept a closed list
  mounted as the top dismissable layer, which swallowed the next escape (an
  e2e test found this). Keep this in mind if you build popovers with Radix
  directly.
- The renderer bundle is about 830 kB (zod and the core schemas). That's fine
  for a local app, and could be split later if cold start needs it.
