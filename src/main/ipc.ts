import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';
import type { AiGateway } from '@core/ai/gateway';
import type { Moment, MomentRequest } from '@core/ai/moments';
import {
  EVENTS,
  INVOKE,
  wire,
  type AppInfo,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeResponse,
} from '@shared/ipc';
import type { WorldSession } from './world-session';

type Handler<C extends InvokeChannel> = (
  request: z.output<(typeof INVOKE)[C]['request']>,
  event: IpcMainInvokeEvent,
) => InvokeResponse<C> | Promise<InvokeResponse<C>>;

/** Registers a typed handler; the request is validated before it runs. */
export function handle<C extends InvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.removeHandler(wire(channel));
  ipcMain.handle(wire(channel), async (event, raw: unknown) => {
    const parsed = INVOKE[channel].request.safeParse(raw ?? null);
    if (!parsed.success)
      throw new Error(
        `${channel}: invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    return handler(parsed.data as z.output<(typeof INVOKE)[C]['request']>, event);
  });
}

/** Sends a typed event to a window (validated in development). */
export function send<C extends EventChannel>(
  win: BrowserWindow,
  channel: C,
  payload: EventPayload<C>,
): void {
  if (win.isDestroyed()) return;
  if (process.env.NODE_ENV === 'development') EVENTS[channel].parse(payload);
  win.webContents.send(wire(channel), payload);
}

export interface IpcDeps {
  window: () => BrowserWindow | null;
  session: WorldSession;
  ai: AiGateway;
  info: AppInfo;
}

/** Wires every foundation channel. Packages register their own with `handle`. */
export function registerIpc(deps: IpcDeps): void {
  const { session, ai } = deps;
  const inflight = new Map<string, AbortController>();

  handle('app:info', () => deps.info);
  handle('world:snapshot', () => session.snapshot());
  handle('world:dispatch', (req) => session.dispatch(req.commands, req.label));
  handle('world:undo', () => session.undo());
  handle('world:redo', () => session.redo());
  handle('store:status', () => session.saveStatus());

  handle('ai:run', async (req, event) => {
    inflight.get(req.requestId)?.abort();
    const ac = new AbortController();
    inflight.set(req.requestId, ac);
    try {
      return await ai.run(req.moment, req.request as MomentRequest<Moment>, {
        signal: ac.signal,
        onPartial: (partial: unknown) => {
          if (!event.sender.isDestroyed())
            event.sender.send(wire('ai:partial'), { requestId: req.requestId, partial });
        },
      });
    } finally {
      if (inflight.get(req.requestId) === ac) inflight.delete(req.requestId);
    }
  });
  handle('ai:cancel', (req) => {
    inflight.get(req.requestId)?.abort();
    return { ok: true as const };
  });
  handle('ai:status', () => ai.status());
  handle('ai:setEnabled', (req) => {
    ai.setEnabled(req.enabled);
    return ai.status();
  });
  handle('ai:log', (req) => ai.log(req.limit));

  handle('window:control', (action) => {
    const win = deps.window();
    if (!win) return { ok: true as const };
    if (action === 'minimize') win.minimize();
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    } else if (action === 'close') win.close();
    else win.webContents.toggleDevTools();
    return { ok: true as const };
  });

  session.onPatch((e) => {
    const w = deps.window();
    if (w) send(w, 'world:patch', e);
  });
  session.onSaveStatus((s) => {
    const w = deps.window();
    if (w) send(w, 'store:status', s);
  });
  ai.onStatus((s) => {
    const w = deps.window();
    if (w) send(w, 'ai:status', s);
  });
}
