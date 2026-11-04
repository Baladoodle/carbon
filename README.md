# carbon

A live design studio for [Infinite](https://github.com/Baladoodle/infinite),
with AI built in. The world bible (bands, biomes, materials, creatures,
structures), the progression (capabilities, items, feats) and the numbers that
hold them together are designed here from scratch. Claude Code implements the
exported specs in Infinite.

> Carbon is for design. Claude Code is for implementation. Infinite is the game.
> Carbon exports specs. It doesn't read Infinite and never writes to it.

**Status:** Phase 0 (foundation) is built: model, commands and undo, store, IPC,
AI gateway contract, UI shell and test harness. The package contract is in
[docs/build-notes/foundation.md](docs/build-notes/foundation.md).

```sh
npm install            # also fetches Electron's binary if npm skipped it
npm run dev:sample     # the app on a scratch copy of the sample world, fake AI
npm run dev            # the app on ~/infinite-bible (or --world <dir>)
npm run check          # lint, format, types, unit tests, e2e smoke
```

| Document | What it covers |
|---|---|
| [docs/PRODUCT.md](docs/PRODUCT.md) | What carbon is, why it's a native app, and how it's separate from Claude Code |
| [docs/EXPERIENCE.md](docs/EXPERIENCE.md) | Views, moves, triage, card lifecycle, keyboard |
| [docs/SYSTEM.md](docs/SYSTEM.md) | Architecture, domain model, store, commands and undo, numbers engine, AI gateway, evals, testing |
| [docs/BUILD.md](docs/BUILD.md) | The overnight build: phases, work packages, rules, coordinator protocol |
| [design/mockups.html](design/mockups.html) | v1 visual direction: the Column, a spread, Curves with the Bench, Taste |
