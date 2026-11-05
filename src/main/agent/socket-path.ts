import os from 'node:os';
import path from 'node:path';

/**
 * Where the agent socket lives (docs/MCP.md §1). The app and `carbon mcp`
 * work it out the same way, so neither needs to be told:
 *
 *  1. `CARBON_SOCKET`, when set (tests; two carbons on one machine)
 *  2. `$XDG_RUNTIME_DIR/carbon/carbon.sock`: a per-user tmpfs, gone on logout
 *  3. `<userData>/carbon.sock`: `$XDG_CONFIG_HOME/carbon` or `~/.config/carbon`,
 *     Electron's user data directory for an app named carbon
 */
export function socketPath(
  env: NodeJS.ProcessEnv = process.env,
  userData: string = defaultUserData(env),
): string {
  if (env.CARBON_SOCKET) return path.resolve(env.CARBON_SOCKET);
  if (env.XDG_RUNTIME_DIR && path.isAbsolute(env.XDG_RUNTIME_DIR))
    return path.join(env.XDG_RUNTIME_DIR, 'carbon', 'carbon.sock');
  return path.join(userData, 'carbon.sock');
}

/** Electron's `userData` for carbon on Linux, without Electron. */
export function defaultUserData(env: NodeJS.ProcessEnv = process.env): string {
  const config =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : path.join(os.homedir(), '.config');
  return path.join(config, 'carbon');
}

/** A Unix socket path's limit (sun_path is 108 bytes, with its terminating NUL). */
export const MAX_SOCKET_PATH = 107;
