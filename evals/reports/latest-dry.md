# Prompt evals: FAIL

2026-11-04T21:58:40.618Z · dry · claude-haiku-5-5 · 21 cases · $0.0055

> Dry run: the answers were generated offline from each request’s schema, not by Claude. The pipeline ran end to end; the quality metrics are not meaningful.

| Metric | Value | Target | |
|---|---|---|---|
| Schema validity | 100.0% | = 100% | pass |
| References resolve to existing entities | 0.0% | = 100% | **fail** |
| No duplicates of existing names | 100.0% | ≥ 95% | pass |
| Critique catches seeded flaws (recall) | 0.0% | ≥ 0.9 | **fail** |
| Critique raises no notes on clean entities | 25.0% | ≥ 0.8 | **fail** |
| Spread diversity: name overlap (worst spread) | 0.054 | < 0.15 | pass |
| Spread diversity: identity/verb overlap (worst spread) | 0.143 | < 0.3 | pass |
| Largest request (input tokens) | 3,208 | < 100,000 | pass |

## Details

- **References resolve to existing entities:** It grows heavier the higher you climb, It remembers the last place you fell, It turns heat into light, It grows heavier the higher you climb, It hums when danger is near, It remembers the last place you fell, It remembers the last place you fell, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity
- **No duplicates of existing names:** 20 names
- **Critique catches seeded flaws (recall):** missed critique-flaw-brass-band (no notes); missed critique-flaw-lumen-spores (no notes); missed critique-flaw-mending-draught (no notes); missed critique-flaw-frost-wisp (duplicate); missed critique-flaw-magma-eel (just_a_number)
- **Critique raises no notes on clean entities:** critique-clean-updraft-kite: weak_identity; critique-clean-echo-reading: rule_clash; critique-clean-heat-glass: duplicate
- **Largest request (input tokens):** cache read rate 50.6%

## Cases

| Case | Moment | Result | In | Cache read | Out | Cost | ms |
|---|---|---|---|---|---|---|---|
| critique-flaw-brass-band | critique | ok | 3053 | 0 | 44 | $0.00037 | 48 |
| critique-flaw-lumen-spores | critique | ok | 1403 | 1805 | 44 | $0.00018 | 4 |
| critique-flaw-mending-draught | critique | ok | 1250 | 1805 | 44 | $0.00017 | 3 |
| critique-flaw-frost-wisp | critique | ok (1 dropped) | 1165 | 1805 | 106 | $0.00019 | 3 |
| critique-flaw-magma-eel | critique | ok (1 dropped) | 1261 | 1805 | 104 | $0.00020 | 8 |
| critique-clean-updraft-kite | critique | ok (1 dropped) | 1225 | 1805 | 87 | $0.00018 | 3 |
| critique-clean-lantern-moth | critique | ok | 1382 | 1805 | 44 | $0.00018 | 2 |
| critique-clean-echo-reading | critique | ok (1 dropped) | 1150 | 1805 | 93 | $0.00018 | 3 |
| critique-clean-heat-glass | critique | ok (1 dropped) | 1374 | 1805 | 90 | $0.00020 | 4 |
| suggest-name-updraft-kite | suggest_one | ok | 1472 | 1310 | 72 | $0.00020 | 5 |
| suggest-tradeoff-spore-lantern | suggest_one | ok | 1561 | 1514 | 74 | $0.00021 | 2 |
| suggest-identity-frost-wisp | suggest_one | ok | 1203 | 1514 | 73 | $0.00017 | 2 |
| suggest-subkind-brass-band | suggest_one | ok | 1300 | 1514 | 65 | $0.00018 | 1 |
| suggest3-name-lantern-moth | suggest_three | ok | 1629 | 1310 | 128 | $0.00025 | 2 |
| suggest3-change-brass-band | suggest_three | ok | 1299 | 1516 | 121 | $0.00021 | 2 |
| fill-high-drift | fill_entity | ok | 1397 | 1310 | 193 | $0.00025 | 4 |
| fill-frost-wisp | fill_entity | ok | 1217 | 1490 | 147 | $0.00021 | 3 |
| spread-fill-low-sky-items | spread | ok (8 dropped) | 1686 | 1310 | 1064 | $0.00072 | 15 |
| spread-vary-lantern-moth | spread | ok | 1600 | 1594 | 1215 | $0.00078 | 9 |
| spec-cinder-sting-glide | spec_draft | ok | 1655 | 1310 | 96 | $0.00023 | 3 |
| patterns-kills | patterns | ok | 1404 | 1310 | 83 | $0.00020 | 3 |

Usage: 27472 input, 3214 cache write, 31442 cache read, 3987 output tokens.
