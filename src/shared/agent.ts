import { z } from 'zod';

/**
 * The agent socket (docs/MCP.md): how an outside agent works with the running
 * carbon. Two contracts live here:
 *
 *  1. The wire between `carbon mcp` (the stdio MCP server, src/main/agent/mcp.ts)
 *     and the app (src/main/agent/server.ts): newline-delimited JSON over a
 *     Unix domain socket. `carbon mcp` speaks MCP to the agent and relays each
 *     request as one `call`; the app owns the tools.
 *  2. What the renderer sees: the settings, the status (connected agents,
 *     spend) and the log of recent tool calls.
 */

/** Bumped when the wire changes incompatibly. */
export const AGENT_WIRE_VERSION = 1;

/** The longest line either side accepts (bytes). Longer lines close the connection. */
export const AGENT_MAX_LINE = 1024 * 1024;

export const AgentClientSchema = z.object({
  name: z.string().max(200),
  version: z.string().max(100).default(''),
});
export type AgentClient = z.infer<typeof AgentClientSchema>;

/** The MCP methods the relay forwards. */
export const AGENT_METHODS = [
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/templates/list',
  'resources/read',
] as const;
export const AgentMethodSchema = z.enum(AGENT_METHODS);
export type AgentMethod = z.infer<typeof AgentMethodSchema>;

/** relay → app */
export const RelayMessageSchema = z.discriminatedUnion('t', [
  /** Sent once the agent has initialised, naming it (the status line shows it). */
  z.object({ t: z.literal('hello'), v: z.number().int(), client: AgentClientSchema }),
  z.object({
    t: z.literal('call'),
    id: z.number().int().min(0),
    method: AgentMethodSchema,
    params: z.unknown().optional(),
  }),
]);
export type RelayMessage = z.infer<typeof RelayMessageSchema>;

export const AgentErrorSchema = z.object({ code: z.string(), message: z.string() });
export type AgentError = z.infer<typeof AgentErrorSchema>;

/** app → relay */
export const AppMessageSchema = z.discriminatedUnion('t', [
  /** Sent as soon as a connection opens: carbon is there. */
  z.object({ t: z.literal('ready'), v: z.number().int(), version: z.string() }),
  z.object({ t: z.literal('result'), id: z.number().int(), result: z.unknown() }),
  z.object({ t: z.literal('error'), id: z.number().int(), error: AgentErrorSchema }),
  /** The app is closing the connection, and why (carbon quitting). */
  z.object({ t: z.literal('bye'), message: z.string() }),
]);
export type AppMessage = z.infer<typeof AppMessageSchema>;

// ── The renderer's side ─────────────────────────────────────────────────────

export const AgentBudgetSchema = z.object({
  sessionUsd: z.number().min(0).max(10_000),
  monthUsd: z.number().min(0).max(100_000),
});

/** Kept in `<userData>/agent.json`, not in the world: an agent can't turn on its own spending. */
export const AgentSettingsSchema = z.object({
  /** Reads and writes (and the free image actions). On by default. */
  access: z.boolean().default(true),
  /** Paid calls: Claude moments and OpenAI images. Off by default. */
  spend: z.boolean().default(false),
  budget: AgentBudgetSchema.default({ sessionUsd: 1, monthUsd: 10 }),
});
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

export const AgentSettingsPatchSchema = z.object({
  access: z.boolean().optional(),
  spend: z.boolean().optional(),
  budget: AgentBudgetSchema.optional(),
});

export const AgentConnectionSchema = z.object({
  id: z.string(),
  /** The MCP client's name (e.g. `claude-code`), once it has said hello. */
  client: z.string().optional(),
  since: z.string(),
});

export const AgentStatusSchema = z.object({
  settings: AgentSettingsSchema,
  /** Whether the socket is up. */
  listening: z.boolean(),
  /** Why it isn't, when it isn't. */
  reason: z.string().optional(),
  connections: z.array(AgentConnectionSchema),
  /** What agents' paid calls have cost. */
  spend: z.object({ sessionUsd: z.number(), monthUsd: z.number() }),
});
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/** One tool call, for the Agent overlay. */
export const AgentLogEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  client: z.string().optional(),
  tool: z.string(),
  /** What it did or asked, in a few words ("Create Glass Lung", "find kind:item"). */
  summary: z.string(),
  outcome: z.enum(['ok', 'error']),
  error: AgentErrorSchema.optional(),
  /** `read`, `write` (one undo step), `ui`, `paid` or `free`. */
  kind: z.enum(['read', 'write', 'ui', 'paid', 'free']),
  /** A write: the revision it produced, so the overlay can offer undo while it's still the last step. */
  rev: z.number().int().optional(),
  costUsd: z.number().min(0).optional(),
});
export type AgentLogEntry = z.infer<typeof AgentLogEntrySchema>;

/** `focus` and `view`: what the agent wants to show the user. */
export const AgentRevealSchema = z.object({
  entity: z.string().optional(),
  view: z.string().optional(),
});
export type AgentReveal = z.infer<typeof AgentRevealSchema>;
