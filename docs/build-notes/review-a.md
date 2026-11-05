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
8. Column flipped inverted bands (resolver: no edges) — property 'bands agree with the resolver' — bandSpan uses bandRange. Changed the unit assertion that encoded the flip.
9. External edit clobbered typed Bench text — column.spec 'an outside edit of a field you are typing in' — outside.ts + useTypedDraft.
10. Critique notes outlived deleted entity; late critique published for deleted entity — core/bench stale critiques, bench.test late gateway, column.spec delete — controller prune + guard.

## Gaps
- moved pure logic to core/column, core/bench, core/testing/stress
- incremental indexing: model 3.2→0.8 ms, geo 2.0→0.6 ms (node); e2e rename 14.4→9.6–10.0 ms
- lane widths by need + cursor reveal
- climate nudge bursts one undo step
- codex prefs sort/widths

## Baseline measurements
- pan 60.6 fps; round trip identity 6.4 ms, name 14.4 ms median (max 85.9)
