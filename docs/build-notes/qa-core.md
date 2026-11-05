# Build notes: `qa-core` (hardening the core, the store and main)

Branch `claude/blissful-einstein-8u27ty-qa-core`, from
`claude/blissful-einstein-8u27ty` at `893eac2`. Scope: `src/core/`,
`src/main/`, `src/shared/`, and the status line's entity count. No view, Bench,
palette or UI-kit file was touched. API spend: **$0.00**.

Every defect below was first shown by a test that failed on the old code, and
each fix was checked by putting the old code back (or by a mutation that the new
test must catch). No test was skipped, weakened or deleted. The one test whose
code changed, `faults.test.ts`, kept every assertion. Its fault injection moved
below the atomic writer so that it reaches the new batched write path (§3).

- **The backlog, items 1–5:** §1–§5
- **The hunt (item 6), with the defects it found:** §6
- **Decisions:** §7
- **Tests and the full runs:** §8
- **Still open:** §9

---

## 1. Inverted band edges

**The rule.** A band's bottom must lie strictly below its top, whenever both
edges are set. A zero-height band (bottom equal to top) breaks the rule too:
it covers no height, and the placement resolver (`bandRange`) already treats it
like an inverted band. The `±∞` ends compare the obvious way: `+inf` as a
bottom, or `-inf` as a top, is inverted.

**Where the rule applies:**

| Where | What happens to an inverted band |
|---|---|
| `validateWorld` / `entityProblems` | An error, code `band.inverted`: "the bottom (640) must be below the top (96)" |
| Commands | Refused, because `checkPatched` refuses new errors. This covers `entity.create`, `entity.update` (both edges at once) and `entity.setField`. Unrelated edits to a band that was already inverted on disk are still allowed, and so is any single edit that fixes it. An edit that leaves it inverted another way is refused |
| Loading, and edits made outside carbon | The file loads, and the band is kept. `band.inverted` is in `TOLERATED_ON_LOAD`, so it never sends a file to quarantine. Other errors in the same file still do |
| The fallback | Unchanged: placement, the Column and Climate treat the band as edgeless |
| The checks | A new `band-inverted` error note names the band ("Low Sky: the bottom (640) is not below the top (96), so it has no place"). The checks' own `bandSpans` now uses the resolver's usable-edge rule, so an inverted band no longer produces overlap or empty-lane notes |
| AI proposals | Suggest-one, suggest-three and fill drop an edge value that would invert the band (`edgesFit`). For fill, "would invert" also counts the edges proposed alongside it. The fake gateway follows the same rule |

**Why the issue is a check note, not a `LoadIssue`.** A `LoadIssue` means
"carbon couldn't use this file". The watcher rejects any outside edit that comes
with one, the list is computed only at load, and the status line calls these
"unreadable files". A note is recomputed on every change, so it disappears the
moment the band is fixed.

**Tests:**
- `src/core/model/band-edges.test.ts`, 16 tests: the rule, the commands, the
  files on disk, the checks and the AI.
- `watcher.test.ts`: an outside edit that inverts a band is taken as is, and
  the load/outside-edit equivalence property now includes an inverted band.
- The existing property ("any command leaves the world valid") now guards the
  rule as well. Its arbitrary already sets random heights.

## 2. The flaky `stream.test.ts`

**The test was wrong, not the parser.** `JsonArrayStreamer` hands each item's
exact text to `JSON.parse`, so it keeps whatever sign the text has. The
property compared the parsed items against the values *before*
`JSON.stringify`, and `JSON.stringify(-0)` is `"0"`. The fix compares against
what the text says.

**A new property** writes zeros by hand (`-0`, `-0.0`, `-0e-3`, `0e5`, …),
splits them at every chunk boundary, and checks that the sign of every number
is exactly what the text gives.

**Stability:**
- The old property, at 100,000 runs, fails reliably with the same counterexample
  (`[{"{":-0}]`).
- The new file passed at 200× its usual run counts: 200,000, 60,000, 100,000
  and 100,000 runs.

**Found on the way: another flaky property, and a real bug behind it.**
- `numbers/fuzz.test.ts › never throw, never hang` failed in my first full run.
  At 30,000 runs it gives `"#c\n  \n  a"`.
- The parser emitted a pending blank line *before* trying the next line. When
  that line produced nothing (an error with no `=`), the program ended in a
  blank, or held two blanks in a row. So printing wasn't a fixed point: it
  printed `"#c\n\n"`, which prints again as `"#c\n"`.
- The blank is now emitted only together with the item after it.
- There's a deterministic regression test, and 3 runs of the fuzz property at
  30,000 pass.

## 3. Batched transaction writes

**`writeBatchAtomic` (`main/store/atomic.ts`).** `writeChanges` hands it every
file of one call, that is, one transaction:

1. Every temporary file is written.
2. Each is fsynced. These run side by side, 16 at a time, so ext4 commits them
   together instead of one journal commit each.
3. Each is renamed over its target, only once every one of them is durable.
4. Removals run after the writes, so a file moved between folders is never
   missing from both.
5. Each directory touched is fsynced once.

**Atomicity.** Each file is still atomic on its own: the old content or the
new, never half. Files are not atomic *together*; they weren't before either.

**Partial failures.** A file that fails is left as it was, its temporary file
is removed, and the others still land. `DiskState.unsaved` and the retry
semantics are unchanged.

**Single writes.** `writeFileAtomic` and `removeFileDurable` are now batches of
one, so the existing kill -9 tests exercise the new code.

**Tests:**
- **Crash simulation:** kill -9 lands at random moments in a loop of 40-file
  batches. Every file must be whole, at most two consecutive versions may be on
  disk, and no temporary file may survive `cleanTempFiles`. The test also
  asserts that kills really landed mid-batch. They do, in every phase: 16 or 32
  temporary files left behind, 40 in the fsync phase, and partial counts
  together with mixed versions in the rename phase.
- **Faults:** ENOSPC is now injected at `node:fs/promises` (`open` of a
  target's temporary file, `rm` of a target), which reaches every write path.
  The 5 existing fault tests pass unchanged. A sixth fails one file in a
  whole-world transaction: the other files land, only that one stays
  `unsaved`, and the retry writes it. Turning the injection off makes 4 of them
  fail, so the injection is live.

**Measurements.** The stress world (2,000 entities), write time only (until
the save queue is empty), median of 3 runs. "Loaded" means a busy loop on each
of the 4 cores. Reproduce with `CARBON_BENCH=1 [CARBON_BENCH_LOAD=1] npx vitest
run src/main/store/write-bench.test.ts`.

| Transaction | Quiet, before → after | Loaded, before → after |
|---|---|---|
| 2,000 `entity.create` | 4.43 s → **1.18 s** | 5.84 s → **1.29 s** |
| …its undo (2,000 removals) | 1.92 s → **0.17 s** | 2.25 s → **0.21 s** |
| 2,000 `entity.update` | 5.72 s → **1.36 s** | 6.52 s → **1.62 s** |
| …its undo | 5.41 s → **1.32 s** | 6.20 s → **1.75 s** |
| One-file command | 3–4 ms → 3–4 ms | 2–10 ms → 2–8 ms |

So a 2,000-command transaction plus its undo now takes about 1.5 s to write
under load, against about 8 s before. The renames now run in the same pool;
they had been about half of the remaining time for rewrites. 64-way
concurrency measured the same as 16, and writing and fsyncing in a single open
was no faster than separate phases.

**Also found: applying the transaction took 3.9 s in memory, before any
write.** Profiled: `checkPatched` took 1.8 s, and copying the entities map in
`patch.ts` another 1.8 s.
- `checkPatched` scanned every entity on each create, to re-check whatever
  pointed at the new id. That made a transaction O(n²).
- Only a dangling target can be such an id. `checkPatched` now keeps a superset
  of those per world (keyed by the entities object and the schema), carried
  from command to command in O(touched).
- The result: 2,000 creates apply in **2.0 s** instead of 3.9 s.
- Tests: a property shows that any command sequence has the same outcome with
  the cache as from a fresh world, and a mutation test (the cache claiming
  nothing is missing) fails all 3 tests.
- The map copying is still open (§9).

## 4. The status line's entity count

**The counter (`shell/StatusLine.count.ts`).** `EntityCounter` records each
`world:patch` by rev. When the mirror's world moves on, it applies the
patches' entity creates and removes, which is O(patch).

**When it counts afresh** (still never wrong, only O(n) now and then):
- a gap in the patches it has seen
- a reset
- a patch that replaces the whole table
- a world that was *loaded* rather than patched

**How it tells a loaded world from a patched one.** It checks whether a
sentinel entity, one the patches didn't touch, is still the identical object.
Patches share untouched entities; a snapshot from IPC shares none. The
sentinels are chosen at each fresh count, because enumerating the table to
find one costs as much as counting it.

**Ordering.** The counter's listeners are registered when the module is
imported, which is before the shell starts the mirror.

**Measurements.** Rename on 2,000 entities, 400 commands, in Node: about 250 µs
per command with `Object.keys`, against **3 µs** with the counter. It counted
afresh once in those 400 commands. Review-a measured the old count at about
1.2 ms in the renderer's profile.

**Tests (`StatusLine.count.test.ts`):**
- A property: `countAfter` equals the true count after any chain of command and
  undo patches.
- A property that drives **the real mirror** (`startWorldSync`) and the counter
  behind a fake bridge that clones like IPC. Events are delivered, dropped,
  doubled or delivered late (mirror first), across a reset to another world,
  and the count must always equal the mirror's true count.
- It found a real flaw in my first version. A lost reset followed by the other
  world's patch, which failed in the mirror, which then resynced, gave a wrong
  delta. That's what led to the sentinel check.
- A counter that trusts patches blindly fails both the property and a
  deterministic test.

## 5. Persisted note dismissals

**What I found:**
1. **A real defect: an entity id that comes back inherits an old dismissal.**
   Ids are slugs of names, so a deleted entity's id comes back with the next
   entity of that name. Its check notes then had the same id and the same
   inputs hash, so the dismissal made for the old entity silently hid the new
   one's note.
   - Shown with a duplicate-name note: create "Spore Lantern" a second time,
     dismiss its note, delete it, create it again.
   - Fix: the runner folds the `created` stamps of a note's entities into its
     inputs hash. An undo of a delete restores the same stamp, so its dismissal
     holds; a new entity under the old id gets a new hash.
   - Cost: per-edit check time on the stress world is unchanged within noise
     (13.3–14.6 ms with the stamp, 13.9–14.3 ms without).
2. **Dismissals that can never match again pile up.** A critique note's hash is
   the whole entity, so any edit to the entity makes its dismissals dead. The
   file is capped at 5,000 entries and drops the oldest first, so dead entries
   eventually push out *live* ones.

**The decision: prune, after 30 days dead.**
- **What counts as dead.** The rules are proofs, not heuristics:
  - a check note that names an entity which is gone
  - a critique note (`ai:<entity>:…`) whose entity is gone, or has changed
    since the dismissal (the hash differs)
- **Reading entity ids from note ids.** `checkNoteSubjects` does it, next to the
  id formats in `checks.ts`. A property test holds it to every note the checks
  make: whatever it names is in the note's entities and exists. Anything it
  can't read gives nothing, and unknown ids are kept.
- **On every open, before the renderer reads them:**
  - dead dismissals are marked with the date
  - one that comes alive again forgets its date
  - those dead for `DISMISSAL_GRACE_DAYS` (30) are pruned
- **Why wait instead of pruning at once.** A world can come back as it was (a
  git checkout of last week, a branch switched back), and then its dismissals
  hold again.
- **The file format.** It gains `dead` only when there is any, so it is
  otherwise exactly the old format. A carbon that doesn't know `dead` reads
  `notes` alone.

**Tests:**
- `checks/dismiss-identity.test.ts`: the reused id, the undo, an unrelated edit.
- `checks/dismissals.test.ts`: the subjects property, the dead rules, the grace
  period, a dismissal coming alive again, an unreadable date. It also checks
  that a critique hash computed on the renderer's copy, after JSON, equals the
  one computed in main.
- `exports.test.ts`: pruning on open, all within the grace period then pruned
  after it, and `all()` waiting for the prune.

**Found on the way:** the dismissals' save queue (`this.queue =
this.queue.then(write)`) stayed rejected after one failed write. Every later
dismissal of the session was then never written. Fixed: the failed call
reports and the queue goes on (`dismissals.test.ts`).

## 6. The hunt

### 6.1 Save, reload, full equality, over every command

**The property.** `everyCommandArb` reaches all 35 command types, and
`EVERY_COMMAND_TYPE` is checked against the registry, so a new command can't be
left out.
- **The values:** strings full of YAML and JSON specials, line ends, BOMs,
  `---`, astral characters and NULs, and numbers including `-0`, `1e21`,
  `5e-324` and `2^53+2`.
- **The start world** already holds a curve, a spread with candidates, a custom
  attribute and a pattern, so removes and edits find their targets.
- **The rule:** the test fails if any command type never applied.
- **Each run:** commands with undo and redo, saved, reopened, deep-equal.
- **Coverage:** 150 runs per suite run, and it passed one run of 1,000.

It found two defects:

| # | Defect | Fix |
|---|---|---|
| 1 | **An entity file with `---` at the end of any frontmatter line failed to load.** For example an identity "Light---", a name "Wait ---", or a multi-line why or tag. The frontmatter ended at the first `---` anywhere, not at a line that is exactly `---`. Carbon kept working from memory, and **the next open quarantined the entity** | The closing line must be `---` alone. Five cases plus a 2,000-run property over every frontmatter field |
| 2 | **The world in memory held values its files don't give back:** CR/CRLF line ends in a description or the formula source (read back as LF), a description's trailing whitespace, a BOM at the start of the formula source, and `-0` in JSON files (variables, settings, curves, spreads), read back as `0`. After a restart the world was quietly different | `applyChecked` puts every patch into the files' canonical form (`core/files/canonical.ts`) before it applies. What a command stores, for every command present and future (AI accepts included), is what a reopen reads. The patch sent to the renderer is the canonical one. It copies only when something changes. Unit tests plus an idempotence property |

### 6.2 Unhandled rejections in main

**The hook (`src/main/unhandled.ts`):**
- Every unhandled rejection in main is logged.
- Under e2e, every rejection and uncaught exception is also appended to
  `<userData>/unhandled.jsonl`.
- `e2e/harness.ts › close()` fails the test whose app wrote any.
- A `@smoke` self-test (`e2e/main-errors.spec.ts`) raises a real rejection in
  the built app's main process, and expects `close()` to fail with it.

**What the hunt found, all fixed with tests:**
- **Git snapshots could reject, and they are fired and forgotten.** There were
  three ways:
  - `execFile` throws at once on an argument with a NUL, and the commit message
    names entities, whose names can hold one. Every idle snapshot of such a
    world rejected.
  - A world folder that was moved or deleted made `realpath` reject the check,
    and `prepare()` cached the rejection for good.
  - Anything else thrown during a commit.

  `systemGit` now turns a throw into a result, the message drops NULs, a check
  that throws gives `{ok: false}` and is retried, and `snapshot()` never
  rejects. There are three tests in `git.test.ts`.
- **A failed start was itself an unhandled rejection.** `void
  app.whenReady().then(start)` left carbon running with no window. It now
  logs, shows an error box (outside e2e) and exits.
- **The fire-and-forget chains catch.** That covers the store module's idle
  snapshot and git check, and the quit path. A module that fails to stop no
  longer stops carbon from quitting unreported.

### 6.3 IPC payload validation

**The main side.** Every invoke handler goes through `handle()`, which parses
the request with its `INVOKE` schema; nothing calls `ipcMain` directly.
- `world:dispatch` payloads are parsed per command.
- `ai:run` requests are parsed per moment, by both gateways.
- Export names are slugified before they reach a path, so they can't escape
  `exports/`.

**New properties (`core/commands/malformed.test.ts`):**
- Any payload for any command type, whether garbage from `fc.anything` (null
  prototypes, BigInts, Maps, sparse arrays) or a valid payload with one part
  broken, is refused with a typed error or applied leaving the world valid. It
  never throws: a throw in a handler is an error in main.
- A transaction with one bad command is refused as a whole.
- The AI gateway answers `bad_request` to any malformed request for any moment.

They all held: no defect there.

## 7. Decisions

1. **An inverted or zero-height band is an error that loads anyway**
   (`TOLERATED_ON_LOAD`). The user is told by a check note, not a load issue
   (§1).
2. **The flaky stream test was the test's fault.** The parser is exact by
   construction, and a property now proves it (§2).
3. **Batching is per `writeChanges` call, that is, per transaction**, with
   atomicity per file and no transaction-wide atomicity, as before. Concurrency
   is 16 (§3).
4. **The status line's count lives in `StatusLine.count.ts`**, not in the
   mirror, because the mirror is outside my scope. If the polish or a later
   phase prefers the count in `state/world.ts`, `countAfter` and the sentinel
   check move there as they are (§4).
5. **Dismissals: prune after 30 days dead; a check note's hash includes its
   entities' `created` stamps** (§5). This changes check-note hashes once, so
   check notes dismissed before this build show once more. The world format
   is pre-release, and the alternative was leaving the reused-id defect in.
6. **The world in memory is always in its files' canonical form** (§6.1).
   Visible effect: a description's trailing newline is dropped when the
   command applies rather than at the next open. The full e2e suite (108 then)
   passed with it.

## 8. Tests and the full runs

The counts below are on the final merged branch.

- Unit and property tests: 646 at the start, **FINAL_UNIT** at the end, in
  FINAL_FILES files, plus 1 skipped (the opt-in write benchmark).
- e2e: 108 at the start, **FINAL_E2E** at the end (the hook's self-test).
- `npm run check`: CHECK_RESULT.
- The full `npm run test:e2e`: E2E_RESULT.

## 9. Still open

- **Applying a big transaction still copies the entities map once per command**
  (`patch.ts`): about 1.8 s of the 2.0 s for 2,000 creates. Sharing copied
  containers across a transaction's commands would make it O(n) overall, but it
  invalidates the `before` world that `checkPatched` and the dangling cache
  read. That needs `checkPatched` to receive the previous entities explicitly.
  It's rare in use (the Codex's 2,000-row e2e is the only such path), so I left
  it.
- **`e2e/world.spec.ts`'s 2,000-entity Codex test** still has a comment saying
  the store writes "one durable write at a time". That's no longer true, but
  the file is UI territory, so I left it. Its wait-for-the-disk condition is
  still right and now finishes sooner.
- **The renderer's half of the dismissals** (`palette/Platform.tsx`) is
  unchanged. Main prunes before the renderer reads, and the renderer still
  drops an entry when a note comes back with a different hash.
- **`IpcAiGateway.run` returning `ok` after an abort** (review-b §6) is in
  `src/renderer/ai`, outside my scope.
- **Electron's own unhandled errors in the *renderer*** aren't hooked. Only
  main's are, as asked.
