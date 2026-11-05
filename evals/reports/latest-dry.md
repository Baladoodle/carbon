# Prompt evals: FAIL

2026-11-05T09:10:49.730Z · dry · claude-haiku-5-5 · 21 cases · $0.0064

> Dry run: the answers were generated offline from each request’s schema, not by Claude. The pipeline ran end to end; the quality metrics are not meaningful.

| Metric | Value | Target | |
|---|---|---|---|
| Schema validity | 100.0% | = 100% | pass |
| References resolve to existing entities | 0.0% | = 100% | **fail** |
| No duplicates of existing names | 100.0% | ≥ 95% | pass |
| Critique catches seeded flaws (recall) | 0.0% | ≥ 0.9 | **fail** |
| Critique raises no notes on clean entities | 50.0% | ≥ 0.8 | **fail** |
| Spread diversity: name overlap (worst spread) | 0.057 | < 0.15 | pass |
| Spread diversity: identity/verb overlap (worst spread) | 0.179 | < 0.3 | pass |
| Largest request (input tokens) | 3,932 | < 100,000 | pass |
| Self-consistency: critique notes on just-filled fields | 0.0% | ≤ 10% | pass |

## Details

- **References resolve to existing entities:** It only works in the dark, It only works in the dark, It trades speed for certainty, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity, unknown-entity
- **No duplicates of existing names:** 20 names
- **Critique catches seeded flaws (recall):** missed critique-flaw-brass-band (no notes); missed critique-flaw-lumen-spores (weak_identity); missed critique-flaw-mending-draught (no notes); missed critique-flaw-frost-wisp (no notes); missed critique-flaw-magma-eel (no notes)
- **Critique raises no notes on clean entities:** critique-clean-lantern-moth: rule_clash; critique-clean-echo-reading: just_a_number
- **Largest request (input tokens):** cache read rate 50.9%
- **Self-consistency: critique notes on just-filled fields:** 0 of 2 notes on just-filled fields, over 3 fills

## Cases

| Case | Moment | Result | In | Cache read | Out | Cost | ms |
|---|---|---|---|---|---|---|---|
| critique-flaw-brass-band | critique | ok | 3132 | 0 | 44 | $0.00038 | 25 |
| critique-flaw-lumen-spores | critique | ok (1 dropped) | 1403 | 1883 | 87 | $0.00020 | 6 |
| critique-flaw-mending-draught | critique | ok | 1250 | 1883 | 44 | $0.00017 | 2 |
| critique-flaw-frost-wisp | critique | ok | 1166 | 1883 | 44 | $0.00016 | 2 |
| critique-flaw-magma-eel | critique | ok | 1261 | 1883 | 44 | $0.00017 | 2 |
| critique-clean-updraft-kite | critique | ok | 1225 | 1883 | 44 | $0.00016 | 1 |
| critique-clean-lantern-moth | critique | ok (1 dropped) | 1382 | 1883 | 85 | $0.00020 | 1 |
| critique-clean-echo-reading | critique | ok (1 dropped) | 1150 | 1883 | 89 | $0.00018 | 2 |
| critique-clean-heat-glass | critique | ok | 1375 | 1883 | 44 | $0.00018 | 2 |
| suggest-name-updraft-kite | suggest_one | ok | 1826 | 1310 | 74 | $0.00025 | 3 |
| suggest-tradeoff-spore-lantern | suggest_one | ok | 1580 | 1865 | 70 | $0.00021 | 1 |
| suggest-identity-frost-wisp | suggest_one | ok | 1206 | 1865 | 71 | $0.00017 | 1 |
| suggest-subkind-brass-band | suggest_one | ok | 1303 | 1865 | 64 | $0.00018 | 1 |
| suggest3-name-lantern-moth | suggest_three | ok | 1980 | 1310 | 130 | $0.00029 | 6 |
| suggest3-change-brass-band | suggest_three | ok | 1302 | 1864 | 129 | $0.00021 | 2 |
| fill-high-drift | fill_entity | ok | 1725 | 1310 | 204 | $0.00030 | 3 |
| fill-frost-wisp | fill_entity | ok | 1220 | 1815 | 149 | $0.00021 | 1 |
| spread-fill-low-sky-items | spread | ok | 2493 | 1310 | 1959 | $0.00126 | 11 |
| spread-vary-lantern-moth | spread | ok | 1887 | 2045 | 1608 | $0.00101 | 5 |
| spec-cinder-sting-glide | spec_draft | ok | 1621 | 1310 | 97 | $0.00023 | 2 |
| patterns-kills | patterns | ok | 1544 | 1310 | 131 | $0.00024 | 3 |

Usage: 28294 input, 4737 cache write, 34243 cache read, 5211 output tokens.
