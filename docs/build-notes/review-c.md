# Build notes: `review-c` (Phase 3, hardening spreads and platform)

Branch `claude/blissful-einstein-8u27ty-review-c`, from
`claude/blissful-einstein-8u27ty` at `829c669` (it hasn't moved since). Scope:
W5 (spreads, taste) and W6 (store, checks, export, palette, packaging). Each
defect below got a test first, which failed on the old code, and then the fix.
No test was weakened, skipped or deleted. One existing expectation changed
because the behaviour it described was the gap being closed (§2.2). API spend:
**$0.00**.

- **Defects found and fixed:** §1
- **Gaps from integrate §10 closed:** §2
- **Measurements:** §3
- **Changes to shared files:** §4
- **Found outside my scope:** §5
- **Still open:** §6

---

## 1. Defects

| # | Defect | Test | Fix |
|---|---|---|---|
| 1 | **Intent curves were lost on every reopen.** `readWorldFiles` never read `numbers/curves.json`, and `applyFileChanges` dropped `numbers.curves` whenever any root file changed outside carbon. The next save of the numbers then deleted the file | `roundtrip.test.ts`: the new **property test**, where any sequence of commands, with undo and redo, saved and reopened gives back the identical world. Also the `applyFileChanges` property now runs on a world with curves | Curves are read on open and are a root file in `apply-files.ts` |
| 2 | **A failed write was lost and reported as saved.** On a full disk or a read-only filesystem, the write threw, and the status went to `error`. The next successful save of another file set it back to `saved`, and the failed file was never written again. `known` also claimed carbon's content was on disk, so the watcher could take the unchanged disk for an external edit | `faults.test.ts` (ENOSPC injected at the atomic writer): status, retry, a failed removal, the watcher, and an external edit of an unsaved file | `DiskState.unsaved`: carbon's content for each failed path. Every write retries it first, the call throws while anything is unsaved, and `known` keeps what's really on disk. `WorldSession.hasUnsaved()` / `retrySave()`. The store module retries with backoff (2 s doubling to 60 s), and once on quit |
| 3 | **A file saved on another OS was quarantined.** A BOM made `carbon.json`, the JSON files and entity files fail to parse. A quarantined `carbon.json` was then replaced by the defaults | `open.test.ts` (BOM, CRLF, a CRLF file isn't an external edit) | The store reads text without a BOM and with LF line ends. Carbon writes LF |
| 4 | **A symlinked `entities/<kind>` folder vanished silently.** `Dirent.isDirectory()` is false for a link | `open.test.ts` | Links are followed (`stat`) |
| 5 | **An unreadable entity path was dropped silently**, for example a directory named `x.md`, or no permission | `open.test.ts` | Reported as a `file.unreadable` issue |
| 6 | **A typo in `schema.json` (or `carbon.json`) set off mass quarantine.** The broken file was replaced by the defaults, and every entity the defaults reject (custom options, ranges) went to quarantine with it | `open.test.ts` | The world opens read-only, nothing moves, and the reason names the file to fix. Broken taste and number files are still quarantined and replaced, because nothing else depends on them |
| 7 | **An unwritable filesystem (EROFS, EACCES, ENOSPC) made the open throw**, for example when `initWorldDir` created the `ai-log/` that git doesn't keep | `open.test.ts` (EROFS injected) | The world opens read-only with the reason. Nothing is migrated or quarantined |
| 8 | **Migration backups weren't byte-exact and could be overwritten.** The backup was written from carbon's normalised reading, and a folder with the same stamp was overwritten | Two new tests in `world-dir.test.ts` | Bytes are copied from disk. A taken folder name gets `-2`, `-3` and so on. Recovery restores the bytes |
| 9 | **A snapshot could commit carbon's temporary file.** A command saved while git ran left `.<name>.<pid>.<n>.tmp` for `git add -A` to stage, or to fail on once it was renamed away | `git.test.ts` | `status`, `add` and `commit` exclude that pattern by pathspec |
| 10 | **`git init` ran over a broken repository.** A `.git` that git couldn't read counted as no repository, and `git init` re-created HEAD, possibly on a fresh branch | `git.test.ts` | Reported as "broken", and left alone |
| 11 | **Two exports at once with the same name wrote the same file.** The second overwrote the first | `exports.test.ts` | Exports are serialised per world |
| 12 | **Export choices weren't in the palette.** The kind and band toggles could only be reached with the mouse or tab | e2e "the export choice is reachable from the palette" | One palette action per kind and per band |

Smaller things fixed on the way:

- `runSpread` now waits for its record to reach the renderer's mirror (`whenRev`) before anything reads it. The response could arrive before the patch, and a `k` pressed at once found no record.
- `roundtrip.test.ts`'s first draft sent a `numbers.setFormulas` payload with the wrong shape. `tsc` caught it, so the property exercises real formula edits.

## 2. Gaps closed (integrate §10)

1. **Triage while streaming** (W5). `k`, `x` with its reason, `space`, `m` and `u` work on candidates that have arrived.
   - While the stream runs, a judgement is queued and shows on its card at once. `u` takes back the last one queued.
   - When the stream ends, the record is saved once (decision 2 of the spreads notes is unchanged). The queue is then applied in order, each judgement its own undo step, exactly as if the keys had been pressed afterwards.
   - `→` stops the stream, keeping what came, waits for the record, then follows.
   - **Decision:** kept entities appear in the world when the stream ends, a few seconds later, not at the keypress. That keeps one record write per run, and streaming never adds undo steps.
   - **Test:** e2e "triage while streaming" (fails on the old code).
2. **Undoing an export removes `exports/<file>.md`, and redo writes it back** (W6).
   - **The mechanism:** `WorldSession.dispatch(commands, label, effect?)` takes a `StepEffect`, which runs on the save queue when that step is undone or redone.
   - **Decision:** a spec you edited after exporting it is yours. Undo leaves it, and redo doesn't overwrite it.
   - **The changed expectation:** an existing assertion in `exports.test.ts` expected the first file to remain after undo. That was the gap, so it now expects only the second export's file.
   - **Tests:** unit tests, and the platform e2e export test (undo, then redo).
3. **The fake gateway's Ground and Cost candidates carry fields** (W5, in W4's `fake.ts`).
   - Ground proposes a relation to a band, biome, material or creature, with the reason as its note.
   - Cost proposes a two- or three-step route that names what it needs, or a `requires` relation.
   - **Test:** `spreads.test.ts` "the fake gateway under Ground and Cost": every keep changes its entity.
4. **The check runner is off the main thread** (W6).
   - It runs in `palette/checks.worker.ts`, fed by `CheckFeed`: the world once, then patches, and the whole world again after any gap.
   - Only the newest run's notes are published. If a worker can't start, the runner runs inline.
   - **Tests:** a property test in `check-feed.test.ts` shows the worker's notes always equal a full run on the mirror's world, across any commands, runs and lost patches. The existing property test (incremental equals fresh) still holds. The platform e2e asserts the worker runs.
5. **Overlapping bands are flagged** (W6, W1's Column draws them on top of each other).
   - **The check:** `band-overlap` gives one warn note per pair that shares heights, for example "high and mist overlap from 500 to 700". Bands that only touch are fine.
   - **Tests:** unit tests, including incrementality.
6. **Packaging** (W6).
   - **Hyprland rule syntax:** 0.53 rejects the `windowrule = RULE, class:…` form the installer wrote. It now asks `hyprctl version -j` and writes the matching syntax: 0.53+ (`match:class … , tile on`), 0.48–0.52, or `windowrulev2`. Without hyprctl it writes 0.53+ with the older forms as comments.
   - **Icon:** `build/icon.svg` and `icon.png` show the Column's ruler and the ember Y 0 mark on the depth tint. They are electron-builder's Linux icon, `Icon=carbon` in both desktop entries, and installed to `hicolor/scalable` (removed by `--uninstall`). `electron-builder --linux dir` builds with it.
   - **Wayland app id:** still `carbon` through `desktopName`. Nothing changed; it is still untested on a real compositor.

## 3. Measurements

The 2,000-entity stress world (`stressWorld(2000)`), in Node and in the e2e
suite under xvfb:

| Measure | Result | Budget |
|---|---|---|
| Check runner, first run (Node) | 288 ms, now in the worker | off the main thread |
| Check runner, one edit, median of 30 (Node) | 11 ms, now in the worker | off the main thread |
| Of that: the numbers engine's update (W3) | ~4 ms | — |
| Column panning (e2e) | 60.4 fps | 50 fps |
| Round trip, an edit the Column doesn't draw (e2e) | 6.6 ms median, 12.0 ms max | 16 ms |
| Round trip, a rename the Column redraws (e2e) | 11.9 ms median, 26.2 ms max | 16 ms (median) |

Coverage of `src/core` in my areas, by lines and functions:

| Area | Lines | Functions |
|---|---|---|
| checks | 98.4% | 95.2% |
| export | 95.1% | 94.9% |
| spreads | 99.5% | 99.4% |
| taste | 98.8% | 96.0% |

Overall: 97.4% lines and 96.8% functions.

### 3.1 The full suite

- **`npm run check`:** passes. That covers lint, prettier, `tsc`, **534** unit and property tests in 49 files (502 before), the build, and 20 smoke tests.
- **The full `npm run test:e2e`:** **92** tests, all passing (90 before, plus "triage while streaming" and the export palette test).
- **Not measured again:** cold start. No change of mine is on the startup path, except that the first check run moved off the main thread.

## 4. Shared files touched (minimal, additive)

| File | Owner | Change |
|---|---|---|
| `src/main/world-session.ts` | foundation | `hasUnsaved()`, `retrySave()`, optional `StepEffect` on `dispatch` |
| `src/core/ai/fake.ts` | W4 | `aboutChange` for Ground and Cost candidates |
| `src/core/checks/checks.ts` `CHECK_KINDS` | W6 | `band-overlap` (no UI reads the list by name) |
| `electron-builder.json` | W6 | `linux.icon`, `Icon` in the desktop entry |

## 5. Outside my scope (for the coordinator)

- **Bench drafts and external edits** (W1). The Bench keeps typed text in component state (`useDraft` in `bench/fields.tsx`). When an external edit changes a field you are typing in, blurring commits the draft and the external value is lost without a question. Detection needs the Bench's help. **Proposal:**
  - The Bench publishes its dirty fields (`{ entity, key, draft, base }`) to a small store.
  - `PlatformRuntime` watches external patches: one that changes a dirty field opens the existing conflict dialog ("Keep carbon's" keeps the draft).
  - I did not edit W1's files.
- **The numbers engine's update** costs about 4 ms per entity change on 2,000 entities, even when no formula reads what changed (W3). It now runs in the checks worker, but the Export view and the Bench still call it on the main thread.
- **`transact` resolves before its patch reaches the mirror** (foundation, `state/world.ts`). Callers that read the world straight after need `whenRev(r.rev)`. Spreads now do; others may not.
- **Persisted dismissals of notes that disappear are never cleaned up.** A note that comes back later with the same inputs is still dismissed. This is arguably right, but worth a decision.

## 6. Still open

- **Changing the axes of a spread on the field.** Positions come from the model for the axes it was asked about. Re-projecting onto other axes would need either a second request or a local scoring nobody has specified. The field always labels the axes the spread was made with, so it is honest.
- **Kept candidates reach the world when the stream ends**, not at the keypress (§2.1).
- **Not tested on the real machine:** `hyprctl` against a real Hyprland, the desktop entry and icon under Omarchy, and the Wayland app id.
- **Snapshots run only after idle time** (SYSTEM §4). Hours of continuous editing never snapshot until you quit. A maximum interval would be a product decision.
