import type { BrowserWindow } from 'electron';
import type { AiGateway } from '@core/ai/gateway';
import type { AppInfo } from '@shared/ipc';
import type { handle, send } from './ipc';
import type { WorldSession } from './world-session';

/**
 * Main-process modules: how a package adds behaviour to the main process
 * without editing src/main/index.ts. Create `src/main/<package>/module.ts`
 * whose default export is `defineMainModule({...})`, imported from THIS file
 * (`../module-def`); it is found by modules.ts with an eager
 * `import.meta.glob` and started after IPC is registered, in name order.
 *
 * These live apart from modules.ts on purpose: modules.ts imports every
 * module eagerly, so a module importing a value from modules.ts would be a
 * cycle that runs before `defineMainModule` exists ("defineMainModule is not
 * a function" in the built app).
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
