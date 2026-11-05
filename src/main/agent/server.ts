import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {
  AGENT_MAX_LINE,
  AGENT_WIRE_VERSION,
  RelayMessageSchema,
  type AgentClient,
  type AgentMethod,
  type AppMessage,
} from '@shared/agent';
import { MAX_SOCKET_PATH } from './socket-path';

/**
 * The app's end of the agent socket (docs/MCP.md §1): a Unix domain socket,
 * mode 0600 in a 0700 directory, speaking newline-delimited JSON with
 * `carbon mcp`. Each connection is one agent.
 *
 * A socket file left by a carbon that crashed is replaced; a live one (another
 * carbon answering on it) is left alone and this one doesn't listen. A path
 * that exists and isn't a socket is never removed.
 */

export interface AgentConnection {
  readonly id: string;
  readonly since: string;
  client?: AgentClient;
}

export interface ServerHandlers {
  version: string;
  onOpen(c: AgentConnection): void;
  onHello(c: AgentConnection): void;
  onClose(c: AgentConnection): void;
  /** Answers one request; a thrown error with a `code` becomes `{ t: 'error' }`. */
  onCall(c: AgentConnection, method: AgentMethod, params: unknown): Promise<unknown>;
}

export class SocketInUse extends Error {}

/** Whether something answers on the socket at `file` (within `ms`). */
export function probe(file: string, ms = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(file);
    const done = (live: boolean): void => {
      clearTimeout(t);
      s.destroy();
      resolve(live);
    };
    const t = setTimeout(() => done(false), ms);
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Makes `file` ready to listen on: its directory exists (0700), and a stale socket is gone. */
export async function prepareSocketPath(file: string): Promise<void> {
  if (Buffer.byteLength(file) > MAX_SOCKET_PATH)
    throw new Error(`the socket path is too long for a Unix socket: ${file}`);
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let st;
  try {
    st = await lstat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (!st.isSocket()) throw new Error(`${file} exists and is not a socket; not touching it`);
  if (await probe(file)) throw new SocketInUse(`another carbon is listening on ${file}`);
  await unlink(file);
}

export class AgentSocketServer {
  private readonly conns = new Map<string, { c: AgentConnection; socket: net.Socket }>();
  private seq = 0;

  private constructor(
    readonly file: string,
    private readonly server: net.Server,
    private readonly h: ServerHandlers,
  ) {}

  static async listen(file: string, h: ServerHandlers): Promise<AgentSocketServer> {
    await prepareSocketPath(file);
    const server = net.createServer();
    const self = new AgentSocketServer(file, server, h);
    server.on('connection', (s) => self.accept(s));
    // The socket is created 0600: the umask covers the moment between bind and chmod.
    const umask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(file, () => {
          server.off('error', reject);
          resolve();
        });
      });
    } finally {
      process.umask(umask);
    }
    await chmod(file, 0o600);
    server.on('error', (e) => console.error('carbon: agent socket', e));
    return self;
  }

  connections(): AgentConnection[] {
    return [...this.conns.values()].map((x) => x.c);
  }

  private accept(socket: net.Socket): void {
    const c: AgentConnection = { id: `c${++this.seq}`, since: new Date().toISOString() };
    this.conns.set(c.id, { c, socket });
    socket.setEncoding('utf8');
    const send = (m: AppMessage): void => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(m)}\n`);
    };
    send({ t: 'ready', v: AGENT_WIRE_VERSION, version: this.h.version });
    this.h.onOpen(c);
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim() !== '') this.onLine(c, line, send, socket);
      }
      if (Buffer.byteLength(buf) > AGENT_MAX_LINE) {
        send({ t: 'bye', message: 'a request was larger than carbon accepts (1 MiB)' });
        socket.destroy();
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      if (this.conns.delete(c.id)) this.h.onClose(c);
    });
  }

  private onLine(
    c: AgentConnection,
    line: string,
    send: (m: AppMessage) => void,
    socket: net.Socket,
  ): void {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      send({ t: 'bye', message: 'not JSON' });
      socket.destroy();
      return;
    }
    const m = RelayMessageSchema.safeParse(raw);
    if (!m.success) {
      const id = (raw as { id?: unknown } | null)?.id;
      if (typeof id === 'number')
        send({
          t: 'error',
          id,
          error: { code: 'agent.invalid_request', message: m.error.message },
        });
      return;
    }
    const msg = m.data;
    if (msg.t === 'hello') {
      if (msg.v !== AGENT_WIRE_VERSION) {
        send({
          t: 'bye',
          message: `carbon speaks agent wire version ${AGENT_WIRE_VERSION}, this carbon mcp ${msg.v}: update one of them`,
        });
        socket.destroy();
        return;
      }
      c.client = msg.client;
      this.h.onHello(c);
      return;
    }
    void this.h.onCall(c, msg.method, msg.params).then(
      (result) => send({ t: 'result', id: msg.id, result }),
      (e: unknown) =>
        send({
          t: 'error',
          id: msg.id,
          error: {
            code: (e as { code?: unknown }).code?.toString() ?? 'agent.internal',
            message: e instanceof Error ? e.message : String(e),
          },
        }),
    );
  }

  /** Says goodbye to every agent, stops listening and removes the socket file. */
  async close(message = 'carbon is closing'): Promise<void> {
    for (const { socket } of this.conns.values()) {
      if (!socket.destroyed) socket.end(`${JSON.stringify({ t: 'bye', message })}\n`);
    }
    // A relay that doesn't hang up is cut off shortly after.
    const cut = setTimeout(() => {
      for (const { socket } of this.conns.values()) socket.destroy();
    }, 300);
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    clearTimeout(cut);
    try {
      await unlink(this.file);
    } catch {
      // already gone
    }
  }
}
