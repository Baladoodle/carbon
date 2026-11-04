import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the world directory is, in order:
 *  1. `--world <dir>` on the command line
 *  2. `CARBON_WORLD_DIR`
 *  3. `worldDir` in `<userData>/settings.json`
 *  4. `~/infinite-bible`
 */
export function resolveWorldDir(argv: readonly string[], userData: string): string {
  const i = argv.indexOf('--world');
  const fromArg =
    i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--world='))?.slice('--world='.length);
  const fromEnv = process.env.CARBON_WORLD_DIR;
  let fromSettings: string | undefined;
  const settingsFile = path.join(userData, 'settings.json');
  if (existsSync(settingsFile)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsFile, 'utf8'));
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'worldDir' in parsed &&
        typeof parsed.worldDir === 'string'
      )
        fromSettings = parsed.worldDir;
    } catch {
      // ignore a broken settings file
    }
  }
  const chosen = fromArg ?? fromEnv ?? fromSettings ?? path.join(os.homedir(), 'infinite-bible');
  return path.resolve(chosen.startsWith('~') ? path.join(os.homedir(), chosen.slice(1)) : chosen);
}
