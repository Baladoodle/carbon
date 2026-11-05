import { z } from 'zod';
import type { AiGateway } from '@core/ai/gateway';
import type { Command } from '@core/commands/registry';
import type { Note } from '@core/model/notes';
import type { World } from '@core/model/world';
import type {
  AgentError,
  AgentLogEntry,
  AgentReveal,
  AgentSettings,
  AgentMethod,
} from '@shared/agent';
import type { DispatchResult } from '@shared/ipc';
import { TOOLS, toolByName, type AgentImages, type ToolContext, type ToolDef } from './tools';
import { RESOURCES, RESOURCE_TEMPLATES, readResource } from './resources';
import { redactSecrets } from './redact';

/**
 * Runs the agent's requests against the app (docs/MCP.md): the MCP methods the
 * relay forwards, each answered here. Everything that makes the tools safe is
 * in this one place, in this order, for every call:
 *
 *  1. the tool exists, and its input passes its zod schema
 *  2. agent access is on
 *  3. anything but a read is within the rate limit
 *  4. it runs, inside `asAgent` (the gateways log `via: agent`, and their own
 *     budgets apply as they do to the UI)
 *  5. its cost is counted, and it's logged for the Agent overlay
 *  6. the result is redacted for anything shaped like a key
 *
 * Paid tools aren't gated here: the server's instructions and each paid tool's
 * description tell the agent to ask the user first, quoting `estimate_cost`.
 */

export class AgentFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentSession {
  readonly world: World;
  dispatch(
    commands: readonly { type: string; payload: unknown }[],
    label?: string,
    effect?: undefined,
    meta?: { by: 'agent' },
  ): DispatchResult;
}

export interface AgentHostDeps {
  session: AgentSession;
  ai: AiGateway;
  images: () => AgentImages | null;
  settings: () => AgentSettings;
  /** What a Claude moment would cost (estimate_cost); null when the AI can't say (off). */
  estimateAi?: ToolContext['estimateAi'];
  reveal: (r: AgentReveal) => void;
  notes: (world: World) => Note[] | Promise<Note[]>;
  /** Runs a tool call in the agent's async context (via.ts). Identity in tests. */
  asAgent?: <T>(fn: () => Promise<T>) => Promise<T>;
  now?: () => Date;
  /** Writes per window; default 50 per second. */
  rate?: { limit: number; windowMs: number };
  onLogged?: (e: AgentLogEntry) => void;
}

/** A sliding-window limit: `limit` takes per `windowMs`. */
export class RateLimiter {
  private readonly times: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  take(now: number): boolean {
    while (this.times.length > 0 && (this.times[0] as number) <= now - this.windowMs)
      this.times.shift();
    if (this.times.length >= this.limit) return false;
    this.times.push(now);
    return true;
  }
}

const CallParamsSchema = z.object({
  name: z.string().max(100),
  arguments: z.record(z.string(), z.unknown()).optional(),
});
const ReadParamsSchema = z.object({ uri: z.string().max(500) });

/** What `tools/call` returns (MCP's CallToolResult). */
export interface ToolCallResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

const MAX_LOG = 300;

export class AgentHost {
  private readonly limiter: RateLimiter;
  private readonly entries: AgentLogEntry[] = [];
  private seq = 0;
  private spentNanos = 0;

  constructor(private readonly deps: AgentHostDeps) {
    const rate = deps.rate ?? { limit: 50, windowMs: 1000 };
    this.limiter = new RateLimiter(rate.limit, rate.windowMs);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** What agents' tool calls have cost this session (USD). */
  spent(): number {
    return this.spentNanos / 1e9;
  }

  log(limit = 100): AgentLogEntry[] {
    return this.entries.slice(-limit);
  }

  /** One forwarded MCP request. Throws `AgentFailure` for a protocol-level error. */
  async handle(method: AgentMethod, params: unknown, client?: string): Promise<unknown> {
    switch (method) {
      case 'tools/list':
        return { tools: TOOLS.map(describeTool) };
      case 'tools/call': {
        const p = CallParamsSchema.safeParse(params);
        if (!p.success) throw new AgentFailure('agent.invalid_request', 'tools/call needs a name');
        return this.call(p.data.name, p.data.arguments ?? {}, client);
      }
      case 'resources/list':
        return { resources: RESOURCES };
      case 'resources/templates/list':
        return { resourceTemplates: RESOURCE_TEMPLATES };
      case 'resources/read': {
        const p = ReadParamsSchema.safeParse(params);
        if (!p.success)
          throw new AgentFailure('agent.invalid_request', 'resources/read needs a uri');
        if (!this.deps.settings().access) throw new AgentFailure('agent.access_off', ACCESS_OFF);
        const text = await readResource(p.data.uri, this.context());
        if (text === null) throw new AgentFailure('agent.not_found', `no resource ${p.data.uri}`);
        return {
          contents: [{ uri: p.data.uri, mimeType: 'application/json', text: redactSecrets(text) }],
        };
      }
    }
  }

  /** `tools/call`: one tool, all the checks, one log line. Never throws. */
  async call(name: string, args: unknown, client?: string): Promise<ToolCallResult> {
    const def = toolByName(name);
    if (!def) return errorResult({ code: 'agent.unknown_tool', message: `no tool "${name}"` });
    const at = this.now().toISOString();
    const log = (
      outcome:
        | { ok: true; summary: string; rev?: number; costUsd?: number }
        | { ok: false; error: AgentError; summary: string },
    ): void => this.record(def, at, client, outcome);

    const parsed = def.input.safeParse(args);
    if (!parsed.success) {
      const error = { code: 'agent.invalid_input', message: describeIssues(parsed.error) };
      log({ ok: false, error, summary: name });
      return errorResult(error);
    }
    const input: unknown = parsed.data;
    const about = describeArgs(name, input);
    const settings = this.deps.settings();
    const refuse = (error: AgentError): ToolCallResult => {
      log({ ok: false, error, summary: about });
      return errorResult(error);
    };
    if (!settings.access) return refuse({ code: 'agent.access_off', message: ACCESS_OFF });
    if (def.kind !== 'read' && !this.limiter.take(this.now().getTime()))
      return refuse({
        code: 'agent.rate_limited',
        message:
          'Too many changes at once: agents may make 50 per second. Wait a moment and try again.',
      });
    const ctx = this.context();
    const run = (): Promise<Awaited<ReturnType<ToolDef['run']>>> =>
      Promise.resolve().then(() => def.run(ctx, input));
    let out: Awaited<ReturnType<ToolDef['run']>>;
    try {
      out = await (this.deps.asAgent ? this.deps.asAgent(run) : run());
    } catch (e) {
      out = {
        ok: false,
        error: { code: 'agent.internal', message: e instanceof Error ? e.message : String(e) },
      };
    }
    const cost = out.ok ? out.costUsd : undefined;
    if (cost) this.spentNanos += Math.round(cost * 1e9);
    if (!out.ok) {
      log({ ok: false, error: out.error, summary: out.summary ?? about });
      return errorResult(out.error);
    }
    log({
      ok: true,
      summary: out.summary ?? about,
      ...(out.rev !== undefined ? { rev: out.rev } : {}),
      ...(cost ? { costUsd: cost } : {}),
    });
    return {
      content: [{ type: 'text', text: redactSecrets(JSON.stringify(out.data ?? null, null, 1)) }],
    };
  }

  private context(): ToolContext {
    const { session } = this.deps;
    return {
      world: () => session.world,
      write: (commands: Command[], label: string) =>
        session.dispatch(commands, `Agent: ${label}`, undefined, { by: 'agent' }),
      ai: this.deps.ai,
      images: this.deps.images,
      reveal: this.deps.reveal,
      notes: () => Promise.resolve(this.deps.notes(session.world)),
      estimateAi: this.deps.estimateAi ?? (() => null),
      now: () => this.now().toISOString(),
      newId: (prefix) => `${prefix}-${this.now().getTime().toString(36)}-${++this.seq}`,
    };
  }

  private record(
    def: ToolDef,
    at: string,
    client: string | undefined,
    o:
      | { ok: true; summary: string; rev?: number; costUsd?: number }
      | { ok: false; error: AgentError; summary: string },
  ): void {
    const entry: AgentLogEntry = {
      id: `agent-${++this.seq}`,
      at,
      ...(client ? { client } : {}),
      tool: def.name,
      summary: redactSecrets(o.summary).slice(0, 200),
      kind: def.kind,
      outcome: o.ok ? 'ok' : 'error',
      ...(o.ok ? {} : { error: o.error }),
      ...(o.ok && o.rev !== undefined ? { rev: o.rev } : {}),
      ...(o.ok && o.costUsd ? { costUsd: o.costUsd } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_LOG) this.entries.splice(0, this.entries.length - MAX_LOG);
    this.deps.onLogged?.(entry);
  }
}

export const ACCESS_OFF =
  'Agent access is off in carbon. The user can turn it on from the status line (Agent) or the palette ("Agent access").';
/** A call's arguments in a few words, for the log when the tool gave no summary: `get_entity glide`. */
export function describeArgs(name: string, input: unknown): string {
  if (typeof input !== 'object' || input === null) return name;
  const o = input as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of [
    'id',
    'entityId',
    'spread',
    'key',
    'field',
    'name',
    'query',
    'expression',
    'kind',
    'state',
    'view',
  ])
    if (typeof o[k] === 'string' && o[k] !== '') parts.push(o[k]);
  const text = parts.join(' ');
  return text === '' ? name : `${name} ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`;
}

function errorResult(e: AgentError): ToolCallResult {
  return {
    content: [{ type: 'text', text: `${e.code}: ${redactSecrets(e.message)}` }],
    isError: true,
  };
}

function describeIssues(e: z.ZodError): string {
  return e.issues
    .slice(0, 8)
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : '(input)'}: ${i.message}`)
    .join('; ');
}

/** A tool as `tools/list` gives it: name, description, JSON Schema, hints. */
export function describeTool(t: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
  delete schema.$schema;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: schema,
    annotations: {
      title: t.title,
      readOnlyHint: t.kind === 'read',
      destructiveHint: t.destructive === true,
      idempotentHint: t.kind === 'read' || t.kind === 'ui',
      openWorldHint: t.kind === 'paid',
    },
  };
}
