# Build notes: `platform` (W6)

Branch `claude/blissful-einstein-8u27ty-platform`, from main at `8159815`
(main hasn't moved since). `npm run check` passes.

- **What was built:** §1
- **Decisions:** §2
- **Shared-contract changes:** §3
- **Integration with W2 and W3:** §4
- **Known gaps:** §5
- **Tests, screenshots and API spend:** §6

---

## 1. What was built

### 1.1 The store (`src/main/store/`)

| File | What it does |
|---|---|
| `atomic.ts` | `writeFileAtomic` (temp file in the same directory, fsync, rename, directory fsync; keeps the old file's permission bits), `removeFileDurable`, and `cleanTempFiles`, which removes stray `.<name>.<pid>.<n>.tmp` files a crash left behind (run on every open) |
| `world-dir.ts` | `loadWorldDir`: initialise, clean temp files, recover an interrupted migration, migrate, load, quarantine. `writeChanges` refuses to write to a read-only world. `quarantineFile`, `quarantineDir` |
| `meta.ts` | `.carbon/`, carbon's bookkeeping inside the world: `quarantine/<stamp>/…`, `backups/<stamp>-format-<n>/…`, `migration.json` (exists only while a migration runs), `dismissals.json`, and a `.gitignore` that keeps backups and quarantine out of snapshots. It's created only when something needs it |
| `migrations.ts` | Pure migrations over the file map: `Migration { from, to, up, down? }`, `planMigrations` (both directions), `migrateFiles`, `formatOf`, `withFormat`. `MIGRATIONS` is empty, because format 1 is the first format |
| `migrate.ts` | Runs a migration on disk: a full backup with a `manifest.json`, then the marker, then the migrated files (`carbon.json` last), then the marker is removed. `recoverMigration` restores the backup exactly if the marker is still there on the next open |
| `git.ts` / `snapshot-message.ts` | `Snapshotter`: the system `git` through `execFile` (no shell, an argument array, a timeout, no prompts, no hooks, no signing, an identity only when none is configured). It `git init`s a world that isn't in any repository and leaves alone one that sits inside another repository. Missing git, nothing to commit and a locked index all return results instead of throwing. Snapshots run one at a time. Commit messages are generated from `git status --porcelain -z`, e.g. `Add Glass Lung; edit Low Sky and numbers`; removed entities get their names from `HEAD` |
| `disk-state.ts` | Per world directory: what carbon last read or wrote for each file (so its own writes are recognised), the settle window and its base content, and the read-only reason |
| `merge.ts` | Three-way merge of one file. Entity files merge field by field; other files merge as a whole |
| `apply-files.ts` | Applies changed files to a world without re-reading the rest (a property test shows it equals a full re-read) |
| `watcher.ts` | `WorldWatcher`: recursive `fs.watch` with a debounce, falling back to polling. Each `scan()` takes external changes, merges them and calls `session.applyExternal`. It raises conflicts and resolves them (`resolve(id, 'ours' \| 'theirs')`) |
| `dismissals.ts` | `.carbon/dismissals.json`: note id → the inputs hash it was dismissed for |
| `exports.ts` | `writeExport` (the file and the marking as one transaction) and `listExports` |
| `module.ts` | The main module that wires the watcher, the idle and quit snapshots, notices, dismissals, export and IPC together |

**Settings** (loose keys in `carbon.json`):

- `snapshot.idleMinutes` (default 10, already in the foundation's schema)
- `snapshot.enabled` (default true)
- `watch.conflictSeconds` (default 15)

The environment variables `CARBON_WATCH=off` and `CARBON_SNAPSHOTS=off` turn off the watcher and snapshots for the session.

### 1.2 Mechanical checks (`src/core/checks/`)

These are pure and incremental. Each note has a stable id (`check:<kind>:<key>`) and an `inputsHash`. The renderer publishes them with `publishNotes('checks')`.

| Kind | Rule |
|---|---|
| `lane-empty` | In a lane that has something somewhere, two or more neighbouring bands with nothing in that lane |
| `lane-imbalance` | Entities per band below Y 0 against above it (bands that straddle 0 count for neither; each entity counts once). Flagged when there are at least 4 entities and one side is 3× denser |
| `material-nowhere` | A material that no biome or band yields and that nothing drops |
| `creature-nowhere` | A creature that lives nowhere |
| `item-unreachable` | A route that needs something that doesn't exist, something in the graveyard, or an unreachable item (route cycles included) |
| `relation` | Every `referenceProblems` result: dangling, wrong kinds, duplicates, a missing symmetric end, dangling `ref` fields |
| `cycle` | One note per cycle in an acyclic relation type (`supersedes`), with the same text from every member |
| `required-missing` | Fields the entity's state requires, listed by their labels |
| `duplicate-name` / `near-duplicate-name` | Names compared after normalising, by normalised edit distance ≤ 0.25 (both names at least 4 characters). Graveyard entities are left out |
| `formula-error` / `off-curve` | Come through the `NumbersAdapter` |

**Incremental:** `createCheckRunner()` caches per-entity checks by object identity (the entity, the schema and its targets). Names are an index with a histogram prefilter and a banded edit distance. Cycles are recomputed only when an acyclic relation changes. A property test shows that after any sequence of commands, the incremental result equals a fresh run. On 2,000 entities a full run takes about 300 ms and one edit a few ms; the benchmark is a test.

**Placement:** `localPlacement` is a deterministic stand-in for W2's resolver. It uses stated places first, then infers through the route, `drops`, `made_from`, `unlocks`, `requires` and `counters` until nothing changes. `fromResolver` adapts a per-entity resolver (§4).

### 1.3 Export

`src/core/export/spec.ts` is pure:

- `selectForExport` (by kind ∩ band, plus hand-picked; decided or exported only)
- `buildSpec`, the deterministic spec: a summary; each entity with its fields, route, attributes, relations and why; the formulas it depends on; acceptance questions as a checklist
- `exportPath`: `exports/YYYY-MM-DD-<slug>.md`, adding `-2`, `-3` and so on when the name is taken
- `withExportHeader` / `readExportHeader`: a small YAML header recording the name, date and entity ids
- `exportCommands`, which marks the entities exported
- `changedSinceExport`, the "edited after export" flag from EXPERIENCE §8

**The view (`views/export/`):**

- On the left: kind and band toggles, and the list of decided entities. Keys: `j`/`k`, `space` to toggle, `enter` to send to the Bench. A warn dot marks entities changed since they were exported.
- On the right: the name (suggested from the choice), Draft (`ctrl+enter`), the editable spec and Export (`ctrl+s`).
- Draft runs `ai.run('spec_draft', …)`. The text carries the `--ai` marker until you edit it. When the AI is off, or the call fails, the deterministic spec is used instead. "Use the spec template" is in the palette.
- Writing goes through `export:write` in main: the file is written atomically, then the entities are marked exported in one transaction (one undo step, labelled `Export <name>`). If marking fails, the file is removed.

### 1.4 The command palette (`renderer/palette/`)

- `fuzzy.ts`: a dynamic-programming subsequence aligner, with bonuses for word starts, runs and exact or prefix matches, and penalties for gaps. Words in the query can also match an item's terms (its kind, state or group) at half weight.
- `Palette.tsx` searches every enabled action and every entity. Recent use (stored in `localStorage`) breaks ties, and the graveyard sinks to the bottom. Results are grouped as actions plus one group per kind, ordered by best match; group labels show only when there's more than one group. Matched letters are highlighted.
- Keys: ↑/↓ or ctrl+n/ctrl+p, page up/down, tab and shift+tab between groups, ctrl+home/end, enter, escape or ctrl+k.

### 1.5 The renderer runtime (`renderer/palette/Platform.tsx`)

`PlatformRuntime` is mounted once by the shell. It:

- runs the checks, coalescing bursts of patches into one run
- reconciles dismissals: a note dismissed with `dismissNote` is persisted with its hash; when the note comes back with a different hash it shows again and the stale entry is dropped
- shows the store's notices as toasts (migrated, read-only, snapshots unavailable or failed)
- shows the **conflict dialog**: per file, carbon's value against the file's for each conflicting field, with "Keep carbon's" or "Keep the file's"; per file when there are several. It can't be dismissed without choosing.
- registers the palette actions "Open the quarantine folder", "Snapshot the world to git now" and "Show dismissed notes again"

### 1.6 Packaging

- **`npm run dist`** builds `dist/carbon-0.1.0-x86_64.AppImage` (about 134 MB) and `dist/linux-unpacked/`. Both were built in the container, and the AppImage started under xvfb and initialised a world.
- `desktopName: carbon.desktop` and `syncDesktopName` make the Wayland app id `carbon`, which matches the window rule.
- **`scripts/install-omarchy.sh`** installs the app under `~/.local/share/carbon/`, the launcher `~/.local/bin/carbon`, `carbon.desktop`, and `~/.config/hypr/carbon.conf` (the window rule).
  - The launcher focuses a running carbon with `hyprctl dispatch focuswindow class:^(carbon)$`, and otherwise starts the app. Electron's single-instance lock would focus it too, but without moving to its workspace.
  - Flags: `--appimage F`, `--dir D`, `--hypr` (adds one marked `source =` line to `hyprland.conf`), `--uninstall` (removes only files that carry its marker), `--dry-run`.
  - Running it again gives the same files. Tests: `tests/install-omarchy.test.ts`, in a throwaway home with a fake AppImage and a fake `hyprctl`.

## 2. Decisions

1. **What "unsaved in-app edits" means.** Every command is saved at once, so the only edits the outside can't have seen are carbon's writes from the last few seconds. Carbon treats its own write as unsaved to the outside for a settle window (`watch.conflictSeconds`, default 15 s).
   - An external edit to that file inside the window is merged three ways against the content from before the window.
   - Fields that only one side changed merge silently. Fields both sides changed differently ask the user.
   - Outside the window, an external edit simply wins, so editing a file in vim that carbon wrote earlier never raises a false conflict.
   - Text a Bench input holds but hasn't committed (W1) isn't covered (§5).
2. **Invalid external edits aren't quarantined while you edit.** Carbon keeps its version in memory, reports the file as "changed outside carbon; carbon kept its version", and applies it once it's valid again. Files are quarantined only on open, so a half-saved file in an editor never moves under your feet.
3. **Quarantine** moves the file to `.carbon/quarantine/<stamp>/<path>`: it's written there first and removed from the world second, so a crash leaves a copy in both places, never in neither.
   - A quarantined root file (for example `taste/rules.json`) is replaced by its default, so the world stays complete.
   - The issue's message names the destination. The status-line item ("N unreadable files") opens the folder on click when there is one, and so does the palette action.
4. **A world from a newer carbon opens read-only.** Its files are never quarantined, because they may be valid for the carbon that wrote them. Writes fail with the reason, and a notice says so. With no migration path (a gap in the list), the world also opens read-only.
5. **Migrations** work on the file map and are pure, so they can be tested in both directions. There's no format 2 yet, so `MIGRATIONS` is empty, and the tests use a two-step synthetic chain:
   - up and down round-trip, including a property test
   - a simulated crash after every possible write recovers to exactly the clean result
   - a test runs every shipped migration's `down(up(x))` against the sample world, so the first real migration is covered automatically
6. **Git:** carbon initialises a world directory that isn't in any repository (SYSTEM §4 says the world is its own repo). It doesn't snapshot one inside another repository; it reports this once and carries on.
   - Snapshots ignore hooks and signing, because a snapshot must never prompt or block.
   - The quit snapshot gets 8 s before quitting continues.
   - Idle means no patch for `snapshot.idleMinutes`.
7. **Dismissal storage** is `.carbon/dismissals.json`, kept per world and committed with it. Dismissing isn't an undoable command; it isn't a world edit. Notes without an `inputsHash` (an AI critique, for example) are stored with `''` and stay dismissed while their id is the same.
8. **Lane checks** skip lanes with nothing in them at all: the Column already shows an empty lane, and flagging all seven lanes in a new world is noise. Runs must cover at least 2 bands.
9. **Export marks only `decided` entities.** Re-exporting an `exported` one rewrites its spec without a state change. Undoing an export reverts the states but leaves the file (§5).
10. **The palette's empty query** shows actions, recent ones first, plus up to 8 recently used entities.
11. **The Export empty state** is "Nothing decided to export. `d` decides the entity on the Bench." It follows the text rule's one allowed form: what's missing plus the key that fixes it.

## 3. Shared-contract changes (all additive)

- **`src/shared/ipc.ts`:**
  - schemas `StoreConflictSchema`, `StoreNoticeSchema`, `SnapshotResultSchema`, `DismissalsSchema`, `ExportWriteRequestSchema`/`ResultSchema` and `ExportRecordSchema`
  - INVOKE: `store:notices`, `store:conflicts`, `store:resolveConflict`, `store:openQuarantine`, `store:snapshotNow`, `notes:dismissals`, `notes:setDismissal`, `export:write`, `export:list`
  - EVENTS: `store:conflicts`, `store:notice`
- **`package.json`:** `desktopName`.
- **`src/renderer/shell/App.tsx`** (foundation's): one import and `<PlatformRuntime />`. Nothing of W6's is otherwise always mounted.
- **`src/renderer/shell/StatusLine.tsx`** (foundation's): the issues item gets `data-testid="status-issues"`, and opens the quarantine folder on click or enter when there's one.
- **Main module pattern (a note for everyone):** `src/main/modules.ts` loads `*/module.ts` eagerly with `import.meta.glob`. A module that value-imports `defineMainModule` from `../modules` is a circular import. In the built app, `defineMainModule is not a function` crashes the main process before the window opens. `store/module.ts` uses `import type { MainModule }` and a plain object instead. **Other packages with a main module should do the same**, or foundation's docs should change.
- New fixture `fixtures/worlds/broken/` (two bad files) for the quarantine e2e test.
- New `tests/install-omarchy.test.ts`; `tests/**` was already in Vitest's include.

## 4. Integration with W2 and W3

I read both branches without merging them.

**W2 placement:** `resolvePlacement(world): Record<id, Placement>`, where `Placement` has `mode` (`'pinned' | 'inferred' | 'unplaced'`) and `bands`. In `src/renderer/palette/Platform.tsx`:

```ts
import { resolvePlacement } from '@core/placement';
CHECK_ADAPTERS.placement = (w) =>
  new Map(Object.values(resolvePlacement(w)).filter((p) => p.bands.length > 0)
    .map((p) => [p.id, { bands: [...p.bands].sort(), inferred: p.mode === 'inferred' }]));
```

**W3 numbers:** `analyzeNumbers(world)`, `formulaErrors(analysis)`, `intentDeviations(analysis, world)` and `relevantFormulas(...)`. Note that W3's `tolerance` is relative.

```ts
import { analyzeNumbers, formulaErrors, intentDeviations, relevantFormulas } from '@core/numbers';
CHECK_ADAPTERS.numbers = {
  formulaProblems: (w) => formulaErrors(analyzeNumbers(w)).filter((e) => e.severity === 'error')
    .map((e) => ({ message: e.message, ...(e.def ? { name: e.def } : {}) })),
  curveDeviations: (w) => intentDeviations(analyzeNumbers(w), w).map((d) => ({
    entity: d.entity, attribute: d.curve, value: d.value, expected: d.intent,
    tolerance: Math.abs(d.tolerance * d.intent) })),
  dependencies: (w, ids) => [...new Set(ids.flatMap((id) =>
    relevantFormulas(analyzeNumbers(w), w, id).map((f) => f.text)))],
};
```

The export view already passes `CHECK_ADAPTERS.placement` to `selectForExport`. Pass `CHECK_ADAPTERS.numbers` to `buildSpec` too. `NumbersEngine` is incremental, so keeping one instance in the adapter would be cheaper than `analyzeNumbers` on each call.

## 5. Known gaps

- **Renderer drafts.** Text typed in a Bench input but not committed isn't part of conflict detection. W1 could report dirty fields, and the watcher could treat those entities as in-window.
- **Undoing an export** reverts the states but leaves `exports/<file>.md` in place. Making file writes part of undo needs a hook in `WorldSession`'s history.
- **An unresolved conflict** keeps carbon's values in memory. An in-app edit of that entity before choosing writes carbon's version; the dialog is modal, which makes this unlikely.
- **First check run on very large worlds** (~2,000 entities) takes ~300 ms on the renderer thread. Later runs are incremental. A Web Worker would remove even that.
- **Hyprland rule syntax.** The snippet uses the `windowrule = …, class:^(carbon)$` form from Hyprland 0.48+, with the `windowrulev2` form commented. Newer Hyprland versions changed rule syntax again; check against the installed version on the Omarchy machine.
- **Not tested in the container:** `hyprctl` against a real Hyprland, `update-desktop-database`, desktop launchers and the app id under Wayland. These were tested with fakes.
- **No app icon:** electron-builder uses the default Electron icon.
- **`MIGRATIONS` is empty.** The machinery is tested with synthetic migrations.

## 6. Tests, screenshots, spend

- **Unit and property tests:** 117 tests in W6's 9 test files, in `src/main/store` (atomic, world-dir, git, watcher, exports), `src/core/checks`, `src/core/export`, `src/renderer/palette` and `tests/`. The whole suite is 178. The crash tests kill a child writer with SIGKILL at ten moments and check the file is never torn. A control run with a plain `writeFile` shows the harness does catch torn files.
- **E2E:** 7 tests in `e2e/platform.spec.ts`; the palette and checks/dismissal tests are tagged `@smoke`. They cover the export flow, an external edit, the conflict dialog, a git snapshot, quarantine and the empty export view. `npm run check` passes (lint, prettier, tsc, 178 unit tests, 9 smoke e2e).
- **Screenshots:** `docs/screens/platform-palette.png`, `platform-export.png`, `platform-conflict.png` and `platform-quarantine.png`.
- **API spend:** $0.00. Every AI path runs on the fake gateway.
