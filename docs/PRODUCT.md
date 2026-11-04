# Carbon: the product

**Carbon is a desktop design studio for Infinite's progression.** It is where you
and Claude invent, shape and decide the armor, accessories, feats, tools and
capabilities a player earns, and the curves they sit on. Nothing is implemented
here. Carbon produces decisions and specs; Claude Code turns them into the game.

> Carbon is for design. Claude Code is for implementation. Infinite is the game.
> Carbon reads Infinite and never writes to it.

---

## 1. The problem

Progression is the part of Infinite that most needs a human. Feel, identity,
trade-offs and the moment a reward is revealed can't be handed to an agent and
reviewed afterwards. Right now that design work happens in three places, and none
of them is built for it:

- **Prose.** `docs/CRAFTING-SYSTEMS.md` is a 680-line proposal. `docs/ARMOR.md` ends
  with "Accessories: not in the game yet."
- **Numbers in RON.** `defense_k: 100.0` in `assets/combat.ron`, `tier: 3` scattered
  through `assets/blocks.ron`.
- **Chat sessions.** Ideas come up, get discussed and then disappear into scrollback.

What exists so far shows how much is still open:

| Fact (read from Infinite, Nov 2026) | What it means for design |
|---|---|
| 3 accessory slots, more "through big feats", the count never shown | The whole accessory and feat system is unwritten |
| Copper, bronze and iron armor: defense 12, 16 and 24 | With `taken = raw·100/(100+def)`, iron saves **1.8 HP** per 20-point hit compared with copper. Is that how the first upgrade should feel? |
| Tool tiers 1 to 4, each tier short ×4 break time, mining never hard-blocked | Tiers are a pacing tool, not a gate |
| Authored bands from the Crush (Y −1000) to the Thin (Y +1000); the world itself is endless | Progression must keep going past every band that has been authored |
| Danger: ±0.22 at the surface, ±0.62 at 20 km, the same up and down | "Height is a multiplier on local character, not a ladder" |
| Damage is meant to reach six figures late in the game | The curves must hold across five orders of magnitude |

To design at this scale you have to hold dozens to hundreds of pieces, across 8+
bands, an endless curve and a consistent taste, all in your head. That is the job
you would otherwise do badly or not at all. Carbon exists to make it easy and
good.

## 2. What carbon is

Three things in one window:

1. **A canvas: the Column.** Infinite's Y axis drawn as a vertical strip, from the
   endless depths through the surface to the endless sky. Every piece of
   progression sits at the height where it is earned. Gaps, clumps, cliffs and
   imbalance between the depths and the sky become visible.
2. **A generator: Spreads.** Point at a place on the Column, pick a *move* (fill,
   vary, oppose, cross, push, break, …), and Claude lays out a spread of 8 to 24
   candidates. You judge them by eye and keyboard: keep, kill, merge, push further.
3. **A memory: Taste and Decisions.** Every kill carries a reason. Reasons turn
   into rules you can read and edit. Every decision is logged with why it was
   made. All of it feeds back into the next spread.

Its output is **decided cards** bundled into **handoff specs**: markdown files
that you point Claude Code at.

## 3. Who it's for, and when

- **One user:** you. It's tuned for your taste and Infinite's canon, with no
  settings for anyone else.
- **Where:** your Omarchy desktop, in its own Hyprland workspace, next to the game
  and a Claude Code terminal. It opens with one command: `carbon`.
- **When:** design sessions from 20 minutes to 3 hours. It works in short bursts
  too: open it, run one spread, triage it, close it.

## 4. Principles

Each principle has a *so that*. If a feature doesn't serve one of them, it doesn't
go in.

1. **You decide; Claude doesn't.** Claude proposes. Only you can mark a card
   *decided*. There are no autonomous loops and nothing runs in the background
   to make choices. *So that the progression is yours.*
2. **Show many options at once and judge them by eye.** Generation always returns
   a spread of cards, never a paragraph. Scanning 16 cards laid out on axes is far
   faster than reading 16 ideas in prose. *So that judging keeps up with
   generating.*
3. **Every idea has a place.** A card lives at a height on the Column, in a lane.
   An idea without a place waits in the Inbox until it gets one. *So that the
   shape of the whole is always visible.*
4. **Consequences show up instantly.** Changing a number updates every curve and
   every affected card while you type. *So that numbers are something you feel,
   not something you calculate.*
5. **Grounded by default.** Infinite's real data, its canon and your taste go into
   every request automatically. You never explain the game again. *So that ideas
   fit Infinite rather than generic games.*
6. **Taste builds up over time.** Killing a card means giving a reason (one key).
   Reasons become rules. *So that week 5 spreads are better than week 1 spreads.*
7. **Separate by construction.** Carbon reads Infinite and never writes to it.
   It produces specs, never code. *So that it can't turn into a second Claude Code.*
8. **Keyboard first, native to Omarchy.** Every action has a key. The colours
   follow your Omarchy theme. *So that it feels like part of your OS, not a
   website.*

## 5. How it's separate from Claude Code

### The test

> **If the answer is text you read once, it belongs to Claude Code.
> If the answer is an object you keep shaping with your hands, it belongs to carbon.**

### Where each task goes

| Task | Where | Why |
|---|---|---|
| "Implement the Lantern Moth Jar accessory" | Claude Code | Code, assets and tests in Infinite |
| "Why does iron armor feel weak?", meaning *how is mitigation computed?* | Claude Code | One-off question about the code |
| "Why does iron armor feel weak?", meaning *what should the curve be?* | Carbon (Curves) | A shape you drag and live with |
| "Give me 20 accessory ideas for the Hollows" | Carbon (Spread) | Many candidates, triaged and placed, with kills that teach taste |
| "Which blocks have no recipe?" | Claude Code | One-off query |
| "Is the sky as rewarding as the depths?" | Carbon (Column + Pressure) | Ongoing; visible on every open |
| "Does decided item X match what's in the game?" | Carbon (Sync) | Read-only check against Infinite's RON files, shown as drift on the card |
| "Write the accessory system design doc" | Carbon produces the spec, Claude Code commits it into Infinite | Carbon never writes to Infinite |

### What a chat structurally can't do

A chat (Claude Code, or claude.ai) is linear, text-only, one exchange at a time
and forgotten when it ends. Carbon is:

1. **Spatial and persistent.** Ideas are objects with a place and a state, not
   paragraphs. The model of the whole progression is always on screen.
2. **Built for judging many options.** Spreads are laid out on axes you choose and
   triaged with single keys.
3. **Instant.** Changing a number updates every curve and every affected card.
4. **Grounded automatically.** Each request is assembled from exactly the right
   slice of Infinite's data, canon, the neighbouring cards and your taste. A chat
   gets whatever you remember to paste in.
5. **Cumulative.** Taste and the decision log carry across sessions and weeks and
   shape every generation.
6. **Aware of the game.** It knows what is already in Infinite, what's only
   decided, and where the two disagree.

### What carbon deliberately does not have

- **No chat box on the main surface.** Moves accept a one-line *direction* ("more
  about light", "nothing combat") and that's all. A free-form conversation
  belongs in Claude Code or claude.ai.
- No editing Infinite's files, no shell, no code tools, no running the game.
- No autonomous agents. Each spread is one request with a structured answer.

## 6. Why a native app is the right form

| Form | Why not, or why |
|---|---|
| **Electron app** ✅ | Chromium gives a rich canvas (the Column, spreads on axes, draggable curves). Node gives the filesystem: it reads the Infinite checkout, watches it for changes and keeps its own store on disk. It runs as a tiled window in its own workspace and starts with one command. |
| Web page | No filesystem or file watching without a server; a browser tab gets lost among others and doesn't feel native to the OS. |
| Terminal UI | Can't show cards laid out on axes, draggable curves or a scaled Y axis. |
| Claude Code plugin or panel | Would sit next to a chat and drift into being one. Carbon's state has to outlive sessions. |
| Spreadsheet or Notion | No grounding in Infinite, no generation, no consequences, no taste. |

## 7. Scope

**In:** progression content and the numbers that hold it together:

- capabilities (what the player can *do*: light a route, cross a gap, breathe thin air)
- armor, accessories, tools and weapons, consumables
- feats and the accessory slots they open
- tiers and acquisition routes (source → process → total effort)
- curves: defense, damage, health, time to kill, effort per band

**Read-only context** (shown, never designed here): bands, biomes, materials,
mobs, combat constants, crafting stations, existing items.

**Out:** world generation, biome design, textures, structures, code,
playtesting, other people.

## 8. Success

"Done" means: *working with carbon got me further in the same time than I
would have got otherwise.*

- **First week:** the first accessory set (3 starting slots, the first feat that
  opens a 4th) is decided. Every accessory has an identity, a trade-off and a
  band, and a handoff spec has gone to Claude Code.
- **Signals carbon tracks for you:** cards judged per hour; kill reasons over
  time (fewer *generic* kills means taste is being learned); how many decided
  cards survive implementation without being redesigned; how often you open a
  spread versus the Bench.
- **The honest failure signal:** you're back to brainstorming in a chat because
  it's faster. If that happens, carbon has failed at its one job.

## 9. Risks

| Risk | Answer |
|---|---|
| Spreads all feel the same (mode collapse) | Spreads are laid out on axes and diversity is enforced; every spread has a *wildcard* slot that ignores taste; the **Oppose** and **Push** moves |
| Taste overfits and suggestions get narrow | Rules are visible and editable; the wildcard slot; rules can be switched off per spread |
| It turns into a second chat | No chat box; the test from §5 is applied to every feature |
| Numbers in carbon drift away from the game's | Formula parameters are read from Infinite; Sync flags drift between decided cards and the game's data |
| Too big to build in an evening | Build in slices; see `SYSTEM.md` §8. The first evening ships the Column, Spreads and card files. |
| Spending the API credits | Each spread shows its estimated cost; the stable part of each request is cached; a budget meter shows spending against the $100 |
