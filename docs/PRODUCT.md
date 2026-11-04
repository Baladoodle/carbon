# Carbon: the product

**Carbon is a live design studio for Infinite, with AI built in.** The world
bible (bands, biomes, materials, creatures, structures), the progression
(capabilities, items, feats) and the numbers that hold them together (variables,
formulas, curves) are all designed here, from scratch, in one tool. Claude is
part of the surface: it suggests, critiques and generates at moments you choose.
Nothing is handed off to run on its own.

> Carbon is for design. Claude Code is for implementation. Infinite is the game.
> Carbon exports specs. It doesn't read Infinite and never writes to it.

---

## 1. The problem

The parts of Infinite that most need a human are the world's identity, how the
player's power grows (progression), and how both feel. Today they live in
scattered prose docs, numbers in data files and chat sessions whose ideas
disappear into scrollback. None of those is a design surface:

- You can't see the whole world and progression at once, so gaps, clumps and
  imbalances stay invisible.
- Numbers are edited in one place and their consequences felt nowhere.
- AI help means handing work to an agent and reviewing whatever comes back.
  That leaves you further from the design, not closer.

Carbon makes a hard job easy and good: holding an endless vertical world, its
biomes, materials, creatures and an unbounded progression consistent with each
other and with your taste.

## 2. What carbon is

- **One model of the world.** Every band, biome, material, creature, structure,
  capability, item and feat is a typed entity with fields and typed relations
  ("found in", "made from", "unlocks", "counters", …). Everything has a place on
  Infinite's Y axis.
- **Live surfaces to design on.** The Column (everything along Y), the Climate
  plane (biomes per band), the Codex (every entity as a filterable table), the
  Bench (one entity in depth) and Numbers (formulas and curves).
- **AI at deliberate moments.** Suggestions when you ask for them in a field.
  Critique when you finish editing an entity. Spreads of candidates when you
  start one. Every call is visible, logged and costed.
- **Taste that builds up.** Your rules, kill reasons and the patterns carbon
  learns from your keeps and kills shape every AI request.
- **Specs out.** Decided entities export as markdown specs that Claude Code
  implements in Infinite.

## 3. Who it's for and when

- **One user:** you. It's tuned for your taste and for Infinite's shape.
- **Where:** your Omarchy desktop, in its own Hyprland workspace, opened with
  `carbon`.
- **When:** design sessions of any length, from one spread over coffee to an
  evening of world-building.

## 4. Principles

1. **You decide.** AI proposes; you accept. Every AI change arrives as a
   proposal, and nothing changes the world without your keypress. There are no
   background agents and no autonomous loops.
2. **The AI is deliberate, not noisy.** It runs at defined moments (§5 of
   `EXPERIENCE.md`), never on every keystroke. Results are cached by content, so
   unchanged content is never sent twice. The cheap mechanical checks run
   locally, for free.
3. **The tool is live.** Edits, numbers, curves and the mechanical checks update
   immediately. The AI answers in seconds, streaming where possible.
4. **Rigor over features.** A validated data model, a numbers engine that always
   gives the same answer for the same input, undo for everything (AI included),
   atomic saves, tests and measured prompt quality. One feature that works
   perfectly beats three that almost work.
5. **Everything has a place.** Every entity sits somewhere on the Y axis, in a
   band, a biome or both. Ideas without a place wait in the Inbox.
6. **Grounded by construction.** Every AI request is assembled from the relevant
   slice of *your* world, your taste and the entity in focus, never from generic
   game knowledge. Each request stays under 100k tokens.
7. **Separate from Claude Code.** No chat box, no code, no access to Infinite.
   Carbon shapes things; Claude Code builds them.
8. **Keyboard first, native to Omarchy.** Every action has a key, and the colours
   follow your Omarchy theme.

## 5. How it's separate from Claude Code

> **If the answer is text you read once, it belongs to Claude Code.
> If the answer is an object you keep shaping with your hands, it belongs to carbon.**

| Task | Where |
|---|---|
| Implement the decided accessory set in Infinite | Claude Code (from carbon's exported spec) |
| How does the game compute damage today? | Claude Code |
| What should the damage curve be across the bands? | Carbon (Numbers) |
| Give me candidates for the Low Sky accessory gap | Carbon (Spread) |
| Does this material appear in any biome? | Carbon (mechanical check, always visible) |
| Does this creature feel like it belongs in the Hollows? | Carbon (critique on finishing the edit) |

What a chat can't do and carbon does: keep a persistent, spatial model of the
whole world; let you judge many options at once; show consequences instantly;
ground every request in your world automatically; and build up taste across
weeks.

## 6. Why a native app

Electron gives a rich surface (the Column, the Climate plane, curves, spreads)
plus the filesystem (a git-backed world directory, file watching, atomic
writes). It runs as a tiled window in its own workspace and starts with one
command. A web page lacks the filesystem and native presence. A terminal UI
lacks the visual surfaces. A plugin inside Claude Code would drift into being a
chat.

## 7. Scope

**In:**

- **World bible:** bands, biomes, materials, creatures, structures
- **Progression:** capabilities, items (armor, accessories, tools, weapons,
  consumables), feats and slot unlocks, acquisition routes
- **Numbers:** variables, formulas, curves, attributes on entities

**Out:** terrain generation, visuals and textures, code, playtesting, reading
Infinite, other users.

## 8. Success

- **Week 1:** the band structure and its first biomes exist with clear
  identities. The first accessory set and the feat that opens slot 4 are decided
  and exported, in less time than it would have taken in chat and docs.
- **Measured inside carbon:** judgements per hour; kill reasons over time;
  suggestion acceptance rate; critique notes acted on versus dismissed; AI spend.
- **The failure signal:** you're back to brainstorming in a chat because it's
  faster.

## 9. Risks

| Risk | Answer |
|---|---|
| The AI is noisy or expensive | Deliberate triggers only, a content-hash cache, a visible log, a spend meter and a hard per-request cap |
| AI suggestions are generic | The context packer grounds each request in your world and taste; prompt evals measure grounding |
| The world grows past what fits in a request | The context packer ranks entities by relevance and packs to a token budget below 100k |
| Data corruption | Schema-validated files, atomic writes, git snapshots, versioned migrations |
| Scope creep | §7, plus the principle "rigor over features" |
