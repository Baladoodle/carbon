# Build notes: `review-a` (Phase 3, hardening W1 column + W2 world)

DRAFT — in progress.

## Defects found (test → fix)

1. fitText split graphemes (emoji, flags, ZWJ) — property test core/column/column.test.ts — Intl.Segmenter boundaries. Band labels sliced at 12 UTF-16 units → measured fitText.
2. Codex bulk decide skipped ideas — columns.test.ts "decides ideas through shaped" — planBulkState via shaped; dialog canMove. Changed one assertion (needsWhy of an idea) that encoded the defect.
3. Climate nudges lost under fast repeats, one undo step per press — world.spec "burst of arrow keys" — Burst draft.
4. Column alt+k bursts: one undo step per press — column.spec "burst of alt+k" — Burst.
5. Climate escape / click on plane didn't deselect — world.spec "escape and a click" — unfollowed focus.
6. Clicking the current tab kept focus in strip; arrows switched band — same e2e — pointerup hands focus back.
7. Codex long text inline edit lost line breaks — world.spec "long text" — textarea editor.

## Baseline measurements
- pan 60.6 fps; round trip identity 6.4 ms, name 14.4 ms median (max 85.9)
