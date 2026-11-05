# Build notes: `mcp`

Branch `claude/blissful-einstein-8u27ty-mcp`, from
`claude/blissful-einstein-8u27ty` at `86f9d83` (the base had not moved when
this was finished). Scope: a way for an outside agent to work with the running
carbon (the user's request: "a MCP or a way for agents to interact with it
directly, while it's working … you don't need to provide the agent, just the
interactivity side"). The design is in [`../MCP.md`](../MCP.md); this file is
what was built, where, and what was decided on the way. API spend: **$0.00**.
Every test runs on the fake AI and the fake images.

---

## 1. What's where

| Path | What |
|---|---|
| `src/shared/agent.ts` | the wire between `carbon mcp` and the app (NDJSON, version 1, 1 MiB lines), and the renderer's schemas: settings, status, log entries, reveals |
| `src/main/agent/socket-path.ts` | where the socket is: `CARBON_SOCKET`, `$XDG_RUNTIME_DIR/carbon/carbon.sock`, or `<userData>/carbon.sock`. Shared by both ends |
| `src/main/agent/server.ts` | the app's socket: stale-socket replacement, 0600 under a 0177 umask, a `ready` on connect, `hello` and `call` handling, `bye` on close |
| `src/main/agent/host.ts` | `AgentHost`: every MCP method the relay forwards; the checks in order (tool, zod, access, write rate, spending, budget, estimate), `asAgent`, the cost, the log, redaction |
| `src/main/agent/tools.ts` | the 41 tools: input schema, kind (`read`, `write`, `ui`, `paid`, `free`), handler |
| `src/main/agent/resources.ts` | 4 resources and the `carbon://entity/{id}` template, each the same data as its read tool |
| `src/main/agent/settings.ts` | `AgentSettingsStore`: `<userData>/agent.json`, and the agent's spend (session in memory, the month on disk) |
| `src/main/agent/via.ts` | an `AsyncLocalStorage` that marks a call as the agent's, so the image gateway logs `via: agent` and `WorldSession` marks steps without new parameters |
| `src/main/agent/redact.ts` | key-shaped strings and the process's keys become `[redacted]` |
| `src/main/agent/module.ts` | the main module: wires the host to the session, the AI, the image gateway and the renderer; the `agent:*` IPC |
| `src/main/agent/relay.ts`, `mcp.ts` | `carbon mcp`: the SDK's low-level `Server` over stdio, forwarding to the socket. Built as `out/main/mcp.js` |
| `src/main/images/current.ts` | the image gateway the images module made, for the agent's image tools |
| `src/renderer/agent/` | the status-line piece, the Agent overlay (settings, budget, the log with Undo), `focus`/`view`, `agent.css` |
| `scripts/carbon-mcp.mjs` | `npm run -s mcp`: the relay from a checkout, under the checkout's Electron in node mode |
| `e2e/mcp.spec.ts` | the integration tests (§3) |

## 2. Decisions

1. **The tools live in the app; `carbon mcp` only relays.** The relay is the
   SDK's low-level `Server` (its `McpServer` wants zod schemas registered at
   start; here they come from the app as JSON Schema, which is what `Server`
   is kept for). So one carbon defines the tools, validates them, and a relay
   never goes stale against the app it talks to. The lint rule against the
   deprecated `Server` is disabled on those two lines, with the reason.
2. **`carbon mcp` runs as `electron -e "<loader>"` in node mode.** The loader
   finds `app.asar/out/main/mcp.js` from `process.resourcesPath`, so the same
   launcher line works for the unpacked build and an AppImage wherever it
   mounts. ESM imports from inside the asar work under
   `ELECTRON_RUN_AS_NODE`: checked against a real `electron-builder --linux
   dir` build, with the packaged app and the packaged relay talking over the
   socket (41 tools, the sample's 24 entities). The launcher tests check the
   `mcp` branch runs before the hyprctl focus.
3. **Settings are outside the world**, in `<userData>/agent.json`. In the
   world (`carbon.json`) an agent with file access could enable its own
   spending; there's no tool for the settings either. Access defaults on,
   spending off, the budget $1 a session and $10 a month.
4. **Provenance is a second marker, not the AI's.** `Origin.by` gains
   `'agent'`; an entity gains an optional `agent_fields` (absent when empty,
   so no existing file changes and the sample fixture is untouched). The
   commands' `source` gains `'agent'`: a key carries at most one of the two
   markers, and your own edit clears both. Spread candidates an agent keeps
   stay `origin.by: 'ai'`: the AI wrote them; the agent's judgement is in the
   spread record (with its note).
5. **The agent colour is `--agent: #cf8fae`**, a dusty rose (VISUAL.md §2):
   muted like the other semantic colours, apart from `--ai`'s violet,
   `--accent`, the states, `--danger` and `--warn`. It marks the agent's
   fields on the Bench and in the Codex, its name on the status line, its
   tools in the log, and `· agent` in the AI log.
6. **An agent's edit counts as an outside edit for a draft.** `PatchEvent`
   gains `by: 'agent'`; `bench/outside.ts` stamps those entities like a file
   watcher change, so a field you're typing in asks Keep mine / Use theirs,
   and the prompt says "Changed by the agent".
7. **Steps the image gateway takes during an agent call are the agent's.**
   `WorldSession.dispatch` takes `meta.by`, or the async context's
   `currentVia()`, so `icon_from_concept` and `accept_sheet_cells` are marked
   without threading a parameter through the image gateway.
8. **One write is one transaction**: every write tool makes exactly one
   `dispatch`, labelled `Agent: …`. `set_state` with a `why` is two commands
   in it (`entity.update`, marking `why` as the agent's, then
   `entity.setState`); a keep is `keepCommands` from triage, with the agent's
   note riding on its `spread.judge`.
9. **Paid gating is per call, by kind.** A `paid` tool may declare itself
   free for an input (an icon batch plan writes sheet lines, no Claude) and
   an `estimate` (images: the gateway's own pricing) that must fit what's
   left of the agent budget. The AI and images keep their own budgets and off
   switches. The agent budget is a soft cap like theirs: a call that starts
   with room may end a little over.
10. **Undo from the Agent log only while it's the last change.** An entry
    keeps the `rev` its write produced; Undo shows while the world is still at
    that `rev`, when the top of the undo history is certainly that step.
11. **The Codex filter language moved to `src/core/codex/query.ts`** so main
    can use it (`find_entities`); `renderer/views/codex/query.ts` re-exports
    it. It gains `agent:yes|no` and `origin:agent`.
12. **No `undo`, `merge` or settings tool.** An agent undoing would undo
    whatever was last, yours included; `ctrl+z` is the user's. Merge needs
    marking several candidates, which the UI does better. A tool for the
    settings would defeat them.
13. **Under e2e** the app's socket is in its private userData unless
    `CARBON_SOCKET` is set, so parallel workers never share
    `$XDG_RUNTIME_DIR`. The harness exposes it as `carbon.socket`.

## 3. Tests

- **Unit** (`src/main/agent/agent.test.ts`, 50): the tool list (every tool
  once, an object schema, a description; every kind present); reads
  (summary, the filter language and its errors, an entity with inbound
  relations, placement and next states, evaluate, the export preview,
  resources); **each write tool maps to its commands** in one dispatch,
  labelled and marked `by: agent` (17 cases); provenance, and your edit
  clearing it; the Why gate's code and message passed through; zod refusals
  before anything runs; focus and view; access off; every paid tool refused
  while spending is off, without calling the AI; the free image actions;
  `via: agent` in the AI log and the cost counted; the budget and the
  estimate; the rate limit and its window; a spread run, kept with a note and
  killed with a reason (the reason counted); redaction; the settings file
  (defaults, persistence, the month rolling, a bad file); the socket path;
  **a real MCP client through the relay and the socket** (in-memory
  transport, real socket, mode 0600); a stale socket replaced; a live one and
  a plain file left alone; an oversize line; `carbon mcp` with no carbon, when
  carbon quits, and when the agent hangs up; a step inside an agent call
  marked as the agent's. Plus the `agent` source in `commands.test.ts`, the
  `agent:` filter in `query.test.ts`, and `carbon mcp` in the launcher in
  `tests/install-omarchy.test.ts`.
- **Integration** (`e2e/mcp.spec.ts`, 11): the SDK's `Client` through the
  real `carbon mcp` (`scripts/carbon-mcp.mjs` → `out/main/mcp.js` under
  Electron in node mode) into the running app: lists the tools and the status
  line names the agent (`@smoke`); reads the world; creates an entity that
  shows in the Column with the agent marker on the Bench, and `ctrl+z` undoes
  it; the Why gate's refusal; an agent edit of a field being typed in asks
  Keep mine / Use theirs; a paid call refused; spending turned on in the
  Agent overlay, a spread on the fake AI, a candidate kept (in the Column)
  and one killed, and the call in the AI log as `· agent`; the overlay's log
  and Undo; access off; `carbon mcp` with no carbon running; a socket left by
  a killed process replaced.

## 4. Shared files changed (all additive)

| File | Change |
|---|---|
| `src/core/model/entity.ts` | `Origin.by` gains `'agent'`; `agent_fields?` |
| `src/core/model/schema.ts`, `core/files/entity-file.ts`, `main/store/merge.ts` | `agent_fields` among the common keys, the file order and the merged keys |
| `src/core/commands/entity-commands.ts` | `SourceSchema` (`user`, `ai`, `agent`); `entity.create` takes `agent_fields` |
| `src/core/ai/gateway.ts`, `core/ai/fake.ts`, `main/ai/gateway.ts` | `AiRunOptions.via`, `AiLogEntry.via` |
| `src/core/images/gateway.ts`, `main/images/gateway.ts` | `ImageLogEntry.via`, from the async context |
| `src/core/codex/query.ts` | moved from the renderer (§2.11) |
| `src/shared/ipc.ts` | `agent:status`, `agent:setSettings`, `agent:log`; events `agent:status`, `agent:logged`, `agent:reveal`; `PatchEvent.by` |
| `src/main/world-session.ts` | `dispatch(…, meta?)`, and the patch event's `by` |
| `src/main/images/module.ts` | sets the current image gateway |
| `src/renderer/shell/StatusLine.tsx` | `<AgentStatus />` |
| `src/renderer/bench/` | the agent marker; `outside.ts` and the conflict prompt |
| `src/renderer/views/codex/view.tsx`, `ai/AiLog.tsx`, `images/LogRow.tsx` | the agent's colour on its cells and log lines |
| `src/renderer/ui/tokens.css`, `tokens.ts`, `base.css` | `--agent`, `.t-agent` |
| `package.json` | `@modelcontextprotocol/sdk` 1.32.2; `npm run mcp` |
| `electron.vite.config.ts` | the `mcp` entry |
| `scripts/install-omarchy.sh`, `scripts/dev-sample.mjs` | `carbon mcp` in the launcher; a hint |
| `e2e/harness.ts` | `CarbonApp.socket` |
| `docs/` | `MCP.md` (new), `GUIDE.md` §1, §4 (the key), §5, §6; `VISUAL.md` §2; `PRODUCT.md` §4, §5; `SYSTEM.md` §1 |

## 5. Known gaps

- **AppImage.** `carbon mcp` through an AppImage uses the same loader and
  should work (AppRun passes the environment and arguments), but only the
  unpacked build was run; the installer prefers it anyway.
- **A killed carbon leaves its socket file** (SIGKILL, or SIGTERM, which
  skips Electron's quit). The next carbon replaces it; `carbon mcp` meanwhile
  says carbon isn't running.
- **Cancellation isn't relayed.** An agent's MCP cancel doesn't stop a call
  already in carbon; a spread or an image batch runs to its end (the AI and
  image gateways' own cancels, from the UI, still work).
- **Spreads don't stream to the agent**: the candidates come back when the
  spread ends. The saved spread is in the Spread view's history from then; nothing streams onto the field.
- **The write rate is shared by all agents**, not counted per agent.
- **Patterns** are learned every 25 judgements by the renderer, as before;
  an agent's judgements count toward them.
- Image metadata goes to the agent without pixels; an agent that wants to
  *see* an image has no tool for it.
