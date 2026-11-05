import net from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  AGENT_MAX_LINE,
  AGENT_WIRE_VERSION,
  AppMessageSchema,
  type AgentMethod,
  type AppMessage,
} from '@shared/agent';
import { socketPath } from './socket-path';

/**
 * `carbon mcp` (docs/MCP.md §1): a small stdio MCP server that relays to the
 * running carbon over its agent socket. It holds no tools of its own: it asks
 * the app for them, and forwards every call. It runs under the installed
 * app's Electron in node mode (`ELECTRON_RUN_AS_NODE=1`), so it needs no
 * separate Node.
 */

export const INSTRUCTIONS = `carbon is the user's live design studio for the game Infinite: a world model of bands, biomes, materials, creatures, structures, capabilities, items and feats, with numbers and taste. The user is watching carbon while you work.

- Start with world_summary, then find_entities (Codex filter language) and get_entity.
- Every write is one undo step: the user can undo it with ctrl+z, and what you wrote is marked as agent-written until they edit it. Writes are validated exactly like the UI; a refusal gives the command's error code and why.
- Lifecycle: idea → shaped → decided → exported, or graveyard. "decided" needs a why (the Why gate) and the state's required fields; get_entity lists what's missing.
- Use focus (an entity on the Bench) and view to show the user what you're talking about.
- Paid tools spend real money: suggest, fill, critique, spread, image_prompt, generate_image, run_image_batch, and plan_image_batch for concepts (Claude or OpenAI calls). Before calling one, ask the user for approval and quote its estimated cost: get it from estimate_cost with the same arguments. Don't call it until they say yes. Carbon's own AI and image budgets still apply.
- Everything else is free and needs no approval: reads, writes, focus and view, estimate_cost, icon_from_concept, review_sheet and accept_sheet_cells.
- Spreads: run spread, then keep or kill each candidate with judge_candidate, giving a reason; carbon's taste learns from your judgements.`;

export class RelayError extends Error {}

/** Lines from a socket, at most `AGENT_MAX_LINE` bytes each. */
function lines(socket: net.Socket, onLine: (line: string) => void): void {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim() !== '') onLine(line);
    }
    if (buf.length > AGENT_MAX_LINE * 4)
      socket.destroy(new RelayError('a reply from carbon was too large'));
  });
}

export interface CarbonLink {
  version: string;
  call(method: AgentMethod, params: unknown): Promise<unknown>;
  hello(client: { name: string; version: string }): void;
  close(): void;
  /** Resolves when carbon goes away, with its reason. */
  closed: Promise<string>;
}

/**
 * Connects to the running carbon and waits for it to say it's ready. Rejects
 * with a RelayError carrying one clear sentence when it isn't running.
 */
export function connectToCarbon(file: string, timeoutMs = 3000): Promise<CarbonLink> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(file);
    let ready = false;
    let seq = 0;
    let bye = '';
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new RelayError(`Something is listening on ${file}, but it isn't carbon.`));
    }, timeoutMs);
    let closedResolve: (why: string) => void = () => undefined;
    const closed = new Promise<string>((r) => (closedResolve = r));
    const send = (m: unknown): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(m)}\n`);
    };

    socket.once('error', (e: NodeJS.ErrnoException) => {
      if (ready) return;
      clearTimeout(timer);
      reject(
        new RelayError(
          e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
            ? "carbon isn't running. Start it (`carbon`), then connect the agent again."
            : e.code === 'EACCES'
              ? `carbon's agent socket (${file}) belongs to another user.`
              : `Couldn't reach carbon at ${file}: ${e.message}`,
        ),
      );
    });
    socket.on('close', () => {
      clearTimeout(timer);
      for (const p of pending.values()) p.reject(new RelayError(bye || 'carbon went away'));
      pending.clear();
      if (!ready) reject(new RelayError(bye || `carbon closed the connection (${file}).`));
      closedResolve(bye || 'carbon closed the connection');
    });
    lines(socket, (line) => {
      let m: AppMessage;
      try {
        const r = AppMessageSchema.safeParse(JSON.parse(line));
        if (!r.success) return;
        m = r.data;
      } catch {
        return;
      }
      if (m.t === 'ready') {
        if (ready) return;
        ready = true;
        clearTimeout(timer);
        if (m.v !== AGENT_WIRE_VERSION) {
          socket.destroy();
          reject(
            new RelayError(
              `carbon speaks agent wire version ${m.v}, this carbon mcp ${AGENT_WIRE_VERSION}: update one of them.`,
            ),
          );
          return;
        }
        resolve({
          version: m.version,
          call(method, params) {
            const id = seq++;
            return new Promise((res, rej) => {
              pending.set(id, { resolve: res, reject: rej });
              send({ t: 'call', id, method, ...(params === undefined ? {} : { params }) });
            });
          },
          hello(client) {
            send({ t: 'hello', v: AGENT_WIRE_VERSION, client });
          },
          close() {
            socket.end();
          },
          closed,
        });
      } else if (m.t === 'bye') {
        bye = m.message;
      } else {
        const p = pending.get(m.id);
        if (!p) return;
        pending.delete(m.id);
        if (m.t === 'result') p.resolve(m.result);
        else p.reject(new McpError(errorCode(m.error.code), `${m.error.code}: ${m.error.message}`));
      }
    });
  });
}

const errorCode = (code: string): number =>
  code === 'agent.invalid_request'
    ? ErrorCode.InvalidParams
    : code === 'agent.not_found'
      ? ErrorCode.InvalidParams
      : ErrorCode.InternalError;

/**
 * The MCP server over a link to carbon. The low-level `Server`, not
 * `McpServer`: the tools are defined in the app and relayed as JSON Schema,
 * which is the case the SDK keeps `Server` for.
 */
// eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
export function createRelayServer(link: CarbonLink): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- see above
  const server = new Server(
    { name: 'carbon', title: 'carbon', version: link.version },
    { capabilities: { tools: {}, resources: {} }, instructions: INSTRUCTIONS },
  );
  const forward =
    (method: AgentMethod) =>
    async (req: { params?: unknown }): Promise<never> =>
      (await link.call(method, req.params)) as never;
  server.setRequestHandler(ListToolsRequestSchema, forward('tools/list'));
  server.setRequestHandler(CallToolRequestSchema, forward('tools/call'));
  server.setRequestHandler(ListResourcesRequestSchema, forward('resources/list'));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, forward('resources/templates/list'));
  server.setRequestHandler(ReadResourceRequestSchema, forward('resources/read'));
  server.oninitialized = () => {
    const c = server.getClientVersion();
    link.hello({ name: c?.name ?? 'agent', version: c?.version ?? '' });
  };
  return server;
}

/**
 * The whole of `carbon mcp`: connect, serve stdio, and exit when either side
 * goes away. Returns the exit code. Messages go to stderr (stdout is MCP's).
 */
export async function runRelay(
  opts: {
    env?: NodeJS.ProcessEnv;
    transport?: Transport;
    stderr?: (line: string) => void;
  } = {},
): Promise<number> {
  const say = opts.stderr ?? ((l: string) => process.stderr.write(`${l}\n`));
  const file = socketPath(opts.env ?? process.env);
  let link: CarbonLink;
  try {
    link = await connectToCarbon(file);
  } catch (e) {
    say(`carbon mcp: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const server = createRelayServer(link);
  const transport = opts.transport ?? new StdioServerTransport();
  await server.connect(transport);
  // Chain after the SDK's own onclose (connect() set it).
  const sdkClose = transport.onclose;
  const code = await new Promise<number>((resolve) => {
    transport.onclose = () => {
      sdkClose?.();
      resolve(0);
    };
    // The agent hung up: stdin ends (the SDK's stdio transport doesn't report that).
    if (!opts.transport) process.stdin.once('end', () => resolve(0));
    void link.closed.then((why) => {
      say(`carbon mcp: ${why}`);
      resolve(1);
    });
  });
  link.close();
  await server.close().catch(() => undefined);
  return code;
}
