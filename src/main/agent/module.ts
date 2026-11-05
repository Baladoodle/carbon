import { app } from 'electron';
import path from 'node:path';
import { DismissalsSchema } from '@shared/ipc';
import type { AgentStatus } from '@shared/agent';
import type { World } from '@core/model/world';
import type { Note } from '@core/model/notes';
// Type-only: modules.ts imports this file eagerly (see src/main/module-def.ts).
import type { MainModule } from '../modules';
import { imageGateway } from '../images/current';
import { META, readJson } from '../store/meta';
import { AgentHost } from './host';
import { AgentSocketServer, SocketInUse } from './server';
import { AgentSettingsStore } from './settings';
import { socketPath } from './socket-path';
import { createNotesSource } from './tools';
import { asAgent } from './via';

/**
 * The agent socket's main-process module (docs/MCP.md): listens on the Unix
 * socket that `carbon mcp` relays to, runs every tool through `AgentHost`
 * against the session, and tells the renderer who is connected, what they did
 * and what they want shown.
 */
const agentModule: MainModule = {
  name: 'agent',
  async start({ session, ai, info, handle, send, window }) {
    const userData = app.getPath('userData');
    const store = AgentSettingsStore.at(userData);
    await store.load();

    const push = <C extends 'agent:status' | 'agent:logged' | 'agent:reveal'>(
      channel: C,
      payload: Parameters<typeof send<C>>[2],
    ): void => {
      const w = window();
      if (w && !w.isDestroyed()) send(w, channel, payload);
    };

    const runChecks = createNotesSource();
    const notes = async (world: World): Promise<Note[]> => {
      const all = runChecks(world);
      const raw = await readJson(info.worldDir, META.dismissals).catch(() => null);
      const r = DismissalsSchema.safeParse(
        raw && typeof raw === 'object' && 'notes' in raw ? raw.notes : raw,
      );
      const dismissed = r.success ? r.data : {};
      return all.filter((n) => !(n.inputsHash && dismissed[n.id] === n.inputsHash));
    };

    let server: AgentSocketServer | null = null;
    let reason: string | undefined;
    const status = (): AgentStatus => ({
      settings: store.get(),
      listening: server !== null,
      ...(reason ? { reason } : {}),
      connections: (server?.connections() ?? []).map((c) => ({
        id: c.id,
        since: c.since,
        ...(c.client ? { client: c.client.name } : {}),
      })),
      spend: store.spend(),
    });
    const pushStatus = (): void => push('agent:status', status());

    const host = new AgentHost({
      session,
      ai,
      // MainImageGateway is the full gateway; the tools use a part of it.
      images: () => imageGateway(),
      settings: () => store.get(),
      spend: store,
      reveal: (r) => push('agent:reveal', r),
      notes,
      asAgent,
      onLogged: (e) => {
        push('agent:logged', e);
        if (e.costUsd) pushStatus();
      },
    });

    handle('agent:status', () => status());
    handle('agent:setSettings', async (patch) => {
      await store.set(patch);
      const s = status();
      push('agent:status', s);
      return s;
    });
    handle('agent:log', (req) => host.log(req.limit));

    // Under e2e each app has a private userData; a shared XDG_RUNTIME_DIR would make them collide.
    const file =
      info.e2e && !process.env.CARBON_SOCKET
        ? path.join(userData, 'carbon.sock')
        : socketPath(process.env, userData);
    try {
      server = await AgentSocketServer.listen(file, {
        version: info.version,
        onOpen: pushStatus,
        onHello: pushStatus,
        onClose: pushStatus,
        onCall: (c, method, params) => host.handle(method, params, c.client?.name),
      });
    } catch (e) {
      reason =
        e instanceof SocketInUse
          ? 'another carbon is using the agent socket'
          : `the agent socket couldn't start: ${e instanceof Error ? e.message : String(e)}`;
      console.warn(`carbon: ${reason}`);
    }

    return async () => {
      await server?.close();
      server = null;
      await store.flush();
    };
  },
};

export default agentModule;
