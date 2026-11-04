import type { BrowserWindow } from 'electron';
import type { AiGateway } from '@core/ai/gateway';
import type { AppInfo } from '@shared/ipc';
import type { handle, send } from './ipc';
import type { WorldSession } from './world-session';

/**
 * Main-process modules: how a package adds behaviour to the main process
 * without editing src/main/index.ts. Create `src/main/<package>/module.ts`
 * whose default export is `defineMainModule({...})`; it is found with
 * `import.meta.glob` and started after IPC is registered, in name order.
 */
export interface MainContext {
  session: WorldSession;
  ai: AiGateway;
  info: AppInfo;
  /** The main window, once created (null before and after). */
  window: () => BrowserWindow | null;
  /** Registers a typed IPC handler (add the channel to src/shared/ipc.ts first). */
  handle: typeof handle;
  /** Sends a typed event to a window. */
  send: typeof send;
}

/** What `start` may return: a stop function, awaited on quit before the final save. */
export type Stop = () => void | Promise<void>;

export interface MainModule {
  name: string;
  // void: a module may have nothing to stop.
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  start: (ctx: MainContext) => void | Stop | Promise<void | Stop>;
}

export const defineMainModule = (m: MainModule): MainModule => m;

const found = import.meta.glob<{ default: MainModule }>('./*/module.ts', { eager: true });

export const MAIN_MODULES: MainModule[] = Object.values(found)
  .map((m) => m.default)
  .sort((a, b) => a.name.localeCompare(b.name));

/** Starts every module; returns one function that stops them all (in reverse). */
export async function startModules(
  ctx: MainContext,
  modules: MainModule[] = MAIN_MODULES,
): Promise<() => Promise<void>> {
  const stops: Stop[] = [];
  for (const m of modules) {
    try {
      const stop = await m.start(ctx);
      if (stop) stops.push(stop);
    } catch (e) {
      console.error(`carbon: module ${m.name} failed to start`, e);
    }
  }
  return async () => {
    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch (e) {
        console.error('carbon: a module failed to stop', e);
      }
    }
  };
}
