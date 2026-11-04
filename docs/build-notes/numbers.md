# Build notes: `numbers` (W3)

Branch `claude/blissful-einstein-8u27ty-numbers`. Owns `src/core/numbers/` and
`src/renderer/views/numbers/`.

- **The API for other packages:** §1 (stable; W4 and W6 can build on it now).
- **The language:** §2.
- **Decisions:** §3. **Shared-contract changes:** §4. **Status:** §5.

---

## 1. The API (`src/core/numbers/index.ts`)

Everything is pure (no I/O, no clock, no `eval`/`Function`), so it runs in main
or in the renderer on the world mirror.

```ts
import {
  NumbersEngine, analyzeNumbers, compileExpression,
  relevantFormulas, allFormulas, summarize, formulaErrors,
  intentDeviations, sampleCurve, formatValue,
} from '@core/numbers';

// One-off (from scratch):
const a = analyzeNumbers(world);

// Incremental (keep one engine per world; update on every change):
const engine = new NumbersEngine();          // { placement?: PlacementResolver, stepLimit? }
const a2 = engine.update(world);             // re-evaluates only what changed; same result as from scratch
```

`NumbersAnalysis`:

| Field | Meaning |
|---|---|
| `diagnostics` | Every problem, sorted by position: `{ severity: 'error' \| 'warning', stage: 'parse' \| 'check' \| 'eval', code, message, span: { start, end }, hint?, def? }`. Spans are UTF-16 offsets into `world.numbers.formulas` |
| `defs` / `byName` | `DefInfo` per definition, in source order: `name`, `kind: 'const' \| 'func'`, `text` (canonical source), `type` (`number`, `(number, number) → number`), `deps`, `variables`, `dependents`, `props` and `kinds` (entity properties and collections it reads), `blocked`, and for constants `result: { ok: true, value } \| { ok: false, error: Diagnostic }` |
| `value(name)` | A constant's value, if it has one |
| `order` | Evaluation order (dependencies first) |
| `evaluated` | Constants evaluated in this update (the rest were reused) |

**For W6 (mechanical checks):**

- `formulaErrors(analysis)` → `{ id, code, message, hint?, def?, line, col, severity }[]`.
  `id` is stable for the same problem on the same line:
  `numbers:<code>:<def>:<line>`.
- `intentDeviations(analysis, world)` → `{ curve, entity, value, intent, deviation, tolerance }[]`:
  every entity dot that is further off its curve's intent than the curve's
  `tolerance` (relative; default 0.25). `deviation = (value − intent) / |intent|`.

**For W4 (AI prompts) and W6 (export):**

- `relevantFormulas(analysis, world, entityId)` → `FormulaSummary[]`: the
  formulas that read the entity's attributes or fields or query its kind, plus
  what uses them and what they use, in source order. Each is
  `{ name, text, type, value?, plain?, error?, line }`. `value` is readable
  (`19.2308`, `Hollows`); `plain` is JSON-safe.
- `allFormulas(analysis, world)` for a world digest.

**Expressions outside `formulas.carbon`** (curves, probes):
`compileExpression(analysis, source, { x: NUMBER }, elementType?)` → `{ ok, type,
diagnostics, run(bindings?, element?) }`. All definitions and variables are in
scope.

**Values** are `number | boolean | string | { $: 'entity', id: string | null } | { $: 'list', items }`.
`formatValue(v, { name })` shows them; `toPlain(v)` makes them JSON-safe.

**Placement:** `explicitPlacement` is the interim resolver (see §3.6). When W2's
`resolvePlacement` is merged, pass an adapter as
`new NumbersEngine({ placement: (world) => Map<id, { band, tier, inferred }> })`.

**Commands** (in `src/core/numbers/commands.ts`, one line in the registry):

| Type | Payload |
|---|---|
| `numbers.putCurve` | `{ curve }`: adds, or replaces by id |
| `numbers.removeCurve` | `{ id }` |
| `numbers.setIntent` | `{ id, points: [{ x, y }] \| null }` |
| `numbers.removeAttributeDef` | `{ kind, key }`: removes a `schema.json` attribute definition |
| `numbers.renameVariable` | `{ from, to }`: renames the variable and every formula and curve reference that resolves to it; refuses if a parameter or property would capture it |

The foundation's `numbers.setVariable`, `numbers.setFormulas` and
`schema.setAttributeDef` do the rest.

## 2. The language

```
k = 100                                            # a constant (variables live in variables.json)
taken(raw, def) = raw * k / (k + def)              # a function; parameter types are inferred
band_defense(b: band) = sum(items where subkind == "armor" and band == b, .defense)
ttk(c: creature, w: item) = ceil(c.health / taken(w.damage, c.defense))
```

- **One definition per line.** Inside brackets, an *indented* next line
  continues the formula. `#` comments run to the end of the line.
- **Values:** numbers (`12`, `1.5`, `1e3`, `1_000`), strings (`"armor"`),
  `true`/`false`, `none` (no entity), entity references, lists (`[1, 2]`).
- **Operators**, loosest first: `where` · `or` · `and` · `not` · `== != < <= > >=`
  (they don't chain) · `+ -` · `* / %` · unary `-` · `^` (right-associative) ·
  calls and `.property`.
- **Collections:** `bands`, `biomes`, `materials`, `creatures`, `structures`,
  `capabilities`, `items`, `feats`, and `entities` (all). Graveyard entities
  are left out; order is by id.
- **Queries:** `items where subkind == "armor" and band == b`. Inside `where`,
  and in the per-element argument of an aggregate, a bare name that is a
  property of the element means that property; `.defense` and `it.defense`
  say so explicitly.
- **Entity properties:** `id`, `name`, `kind`, `state`, `identity`, `tags`;
  `band` and `tier` (placement); every kind field (text and enum → string,
  number and height → number, boolean, ref → entity, list → list of string, a
  range `danger` → `danger_min`/`danger_max`); every attribute of the kind.
- **Built-ins:** `min max clamp log exp pow sqrt abs floor ceil round lerp if
  sum avg count contains`. `sum/avg/min/max(list, .value)`,
  `count(list, condition)`.
- **Types:** number, bool, string, entity (of a kind, when known) and list,
  inferred by unification. Parameters may be annotated (`c: creature`).
- **Errors** carry a span and, where there is one, a fix hint. A definition
  with an error blocks those that use it ("taken has an error").
- **Evaluation** is bounded by a step limit (200,000 per definition) and is
  deterministic.

## 3. Decisions

(Filled in below as the work goes.)

## 4. Shared-contract changes

All additive (foundation §1.12):

1. `src/core/model/curves.ts` (new): `CurveSchema`, `CurveAxisSchema`,
   `IntentPointSchema`; exported from `src/core/model/index.ts`.
2. `src/core/model/world.ts`: `NumbersSchema` gains an optional
   `curves: Curve[]`. Optional, so `emptyWorld()`, `sampleWorld()` and
   existing files are unchanged.
3. `src/core/files/world-files.ts`: `PATHS.curves = 'numbers/curves.json'`,
   read when present, written when `numbers.curves` is set, and handled in
   `filesForPatch` (key `curves`).
4. `src/core/commands/registry.ts`: the one `...numbersCommands` line.
5. `src/core/model/model.test.ts`: the exhaustive label test lists the five
   new commands' payloads.

## 5. Status

In progress.
