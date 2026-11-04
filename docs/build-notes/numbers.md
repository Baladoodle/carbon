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

1. **Syntax beyond SYSTEM §6.** One definition per line; continuation only on
   *indented* lines inside brackets, so one unclosed `(` can't swallow the rest
   of the file. `#` comments (kept by the printer, trailing ones too). Optional
   parameter annotations (`b: band`). List literals (`[1, 2]`). A `none`
   literal, because an unplaced entity's `band` has to be something you can
   compare (`where band != none`). `if(c, a, b)`, `abs` and `contains` were
   added to the built-ins; `if` and `and`/`or` are lazy.
2. **Comparisons don't chain** (`1 < x < 3` is a parse error with a hint), and
   `<`/`>` compare numbers only. `==` compares any two values of the same type,
   structurally.
3. **Name resolution inside `where`:** a bare name that is a property of the
   element wins over parameters and definitions, with a warning when it hides
   one (`it.x` makes it explicit). This is what makes
   `items where subkind == "armor" and band == b` read naturally. A field with
   no value form (a range, a climate) is reported as such rather than falling
   through to an outer name.
4. **Types are inferred** by unification (Hindley–Milner without recursion,
   since recursion is a cycle). Definitions are generalised, so `ident(v) = v`
   works at several types. An entity's kind is inferred from the properties
   read: `c.health` makes `c` a creature if only creatures have `health`.
5. **Strict values, few surprises.** Division by zero, `sqrt` of a negative,
   `log` of ≤ 0, `avg`/`min`/`max` of an empty list, a NaN anywhere, an unset
   number field, an attribute whose `when` doesn't match, and an unset attribute
   without a default are all errors with a span and a hint, never silent zeros.
   Empty text fields read as `""`, empty lists as `[]`, an empty ref as `none`.
   ±∞ is allowed (band edges are infinite).
6. **Placement adapter** (`placement.ts`), until W2 merges: bands ordered by
   `y_bottom` (then `y_top`, then id; graveyard bands left out); an entity's
   band is the band itself, a biome's `band` field, the first `in_band`
   relation, or the band of the first `in_biome` biome. **Tier** = the band's
   index counted from the first band whose top is above Y 0 (that band is 0,
   above +1, below −1). To switch to W2's resolver:

   ```ts
   import { resolvePlacement } from '@core/placement';
   import { bandOrder, bandTiers, NumbersEngine } from '@core/numbers';
   const w2: PlacementResolver = (world) => {
     const tiers = bandTiers(bandOrder(world));
     const ps = resolvePlacement(world);
     return new Map(Object.values(ps).map((p) => {
       const band = p.bands[0] ?? null;                         // lowest band it sits in
       return [p.id, { band, tier: band ? tiers.get(band) ?? null : null, inferred: p.mode === 'inferred' }];
     }));
   };
   new NumbersEngine({ placement: w2 });
   ```

   The view creates its engine in `src/renderer/views/numbers/analysis.ts`;
   that is the one line to change.
7. **Collections leave out the graveyard** and are in id order, so sums don't
   count dead designs and evaluation order is deterministic.
8. **Incremental evaluation** records, per constant, the exact inputs it read
   (`var:k`, `def:f`, `entity:id`, `kind:item`, `placement:id`). An update
   re-parses only if the source changed, re-checks only if the source, schema
   or variable *types* changed, and re-evaluates a constant only if its
   canonical text, type or blocked state changed or one of its inputs did
   (with early cut-off when a re-evaluated value is equal). Whitespace edits
   re-evaluate nothing. The property test holds it equal to a from-scratch
   analysis over random command sequences.
9. **Errors block downstream.** A definition with a static error, or on a cycle,
   isn't evaluated; whatever uses it gets "`taken` has an error" pointing at
   the reference. Only root causes go into `diagnostics`.
10. **Step limit** 200,000 per definition (configurable). Every node costs one.
11. **Curves** live in `numbers/curves.json` (a new, optional part of
    `Numbers`). On the band axis, intent points are stored by **band id**, so
    they follow their band when bands are added or reordered. Changing a
    curve's axis drops its intent (its x would mean something else). Intent
    points move vertically only. Tolerance for "far off the intent" defaults to
    25% of the intent.
12. **Formula editing:** the editor commits `numbers.setFormulas` 600 ms after
    typing stops, or on blur, so one pause of typing is one undo step. While
    there's uncommitted typing, `ctrl+z` in the editor drops it first. The
    view evaluates the draft locally on every keystroke (values, inline marks,
    curves). Undo and external edits replace the editor text only when there's
    no uncommitted typing.
13. **Renaming a variable** (click its name) rewrites only the references that
    resolve to it, in formulas and in curves, through the resolver's spans, and
    is refused if a parameter or element property would capture a reference.
14. **The text rule:** no titles or section headings. Labels only where a
    control is ambiguous: `y =` and `dots` on a curve, and the attribute
    table's column heads (`min`, `max`, `default`, `set`). How many formulas
    use a variable is in its remove button's tooltip, not on screen. Empty
    states say what's missing and the one key (`c`, `a`). Keys: `e` edits
    formulas, `v` new variable, `a` new attribute, `c` new curve; ↑/↓ (shift
    for more) nudge a focused intent point; escape leaves the editor. All are
    in the palette under Numbers.
15. **Dots** are coloured by entity state (idea outlined, the rest filled with
    their state colour), ringed in `--warn` when off the intent, and clicking
    one puts the entity on the Bench.

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
   new commands' payloads. (Every package adding commands has to touch this
   list; a merge conflict there is trivial.)
6. `src/renderer/ui/icons.tsx`: `IconIntent` (a dashed curve with a square).

No IPC channels, settings keys or main-process modules were added.

## 5. Status

Everything in the W3 row of BUILD.md §5 is built. `npm run check` passes.

**Files:** `src/core/numbers/` — `span.ts`, `lexer.ts`, `ast.ts`,
`parser.ts`, `printer.ts`, `types.ts`, `props.ts`, `builtins.ts`, `check.ts`,
`graph.ts`, `values.ts`, `evaluate.ts`, `engine.ts`, `placement.ts`,
`curves.ts`, `rename.ts`, `commands.ts`, `index.ts`, and `golden/*.golden.txt`.
`src/renderer/views/numbers/` — `view.tsx`, `analysis.ts`,
`FormulaEditor.tsx`, `Variables.tsx`, `Attributes.tsx`, `Curves.tsx`,
`CurvePlot.tsx`, `numbers.css`.

**Tests:** 41 Vitest tests in `src/core/numbers` (109 in the repo):

- 3 golden suites with committed files: the parser (30 cases: precedence,
  queries, literals, comments, continuation and 23 kinds of syntax error), the
  checker (41 definitions: inferred types and every check error), and
  evaluation (36 constants against the sample world, every built-in and every
  runtime error). Update with `npx vitest run src/core/numbers/golden.test.ts -u`
  and review the diff.
- 8 property tests (fast-check): print → parse round-trip for expressions
  (1,000 runs) and programs; exact spans; the parser and the whole analysis
  never throw on fuzzed input with in-bounds spans; incremental equals from
  scratch over random command sequences (150 runs of up to 12 commands mixing
  the foundation's command arbitrary with numbers edits); determinism;
  idempotence (an equal world re-evaluates nothing); and exactly which
  constants a change re-evaluates.
- 28 unit tests: evaluation details, graph and long chains, unification,
  placement, curves (band, tier and attribute axes, intent, problems),
  commands with persistence and exact inverses, rename and capture, the API
  helpers for W4/W6.
- 2 safety tests: no `eval`/`Function` in the engine's source, and 2,000
  entities (full analysis well under 2 s; a variable change re-evaluates one
  constant).
- Coverage of `src/core/numbers`: 95% of lines, 95% of functions, 85% of
  branches (core overall 96% / 96% / 87%).

**E2E:** `e2e/numbers.spec.ts`, 7 tests, 2 tagged `@smoke`: live values and
curves; inline errors while typing and the debounced commit to disk; editing a
variable with undo; renaming a variable; defining an attribute (persisted in
`schema.json`); dragging and nudging intent points (persisted in
`curves.json`) with the off-intent ring and dot tooltip; adding, editing and
removing a curve.

**Screens** (sample world plus a few armor items and two curves, set up by the
spec): `docs/screens/numbers-view.png`, `numbers-error.png`,
`numbers-attributes.png`, `numbers-curves.png`.

**API spend:** $0.00 (no AI in this package).

**Known gaps:**

- Placement uses the interim adapter (§3.6) until W2 is merged.
- Intent points move vertically only, and there's no adding or deleting single
  points (the intent curve is created with one point per band or tier, or five
  on an attribute axis).
- The formula editor has no autocomplete or go-to-definition; hovering a value
  shows its type, and the caret's line shows its error and hint.
- `formulaErrors` ids include the line, so inserting a line above a broken
  formula changes its id (W6's dismissals would reset for it).
- W6's checks and W4's prompts aren't wired to this API yet; that's theirs, or
  integration's.
