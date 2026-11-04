import { watch, type FSWatcher } from 'node:fs';
import { readFile, readlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { tokensFromOmarchy, TOKYO_NIGHT, type ThemeTokens } from '@core/theme/theme';

/** Omarchy's current theme directory (a symlink to the active theme). */
export const omarchyThemeDir = (): string =>
  process.env.CARBON_THEME_DIR ?? path.join(os.homedir(), '.config/omarchy/current/theme');

/** Reads the current Omarchy theme, falling back to Tokyo Night. Never throws. */
export async function readTheme(dir = omarchyThemeDir()): Promise<ThemeTokens> {
  const files = new Map<string, string>();
  for (const name of ['colors.toml', 'alacritty.toml']) {
    try {
      files.set(name, await readFile(path.join(dir, name), 'utf8'));
    } catch {
      // not present in this theme
    }
  }
  let name = 'omarchy';
  try {
    name = path.basename(await realpath(dir));
  } catch {
    try {
      name = path.basename(await readlink(dir));
    } catch {
      // keep the default name
    }
  }
  return tokensFromOmarchy(name, files) ?? TOKYO_NIGHT;
}

/** Watches the theme (Omarchy swaps the `current` symlink); calls back with new tokens. */
export function watchTheme(
  onChange: (t: ThemeTokens) => void,
  dir = omarchyThemeDir(),
): () => void {
  const parent = path.dirname(dir);
  let w: FSWatcher | null = null;
  let timer: NodeJS.Timeout | null = null;
  try {
    w = watch(parent, { persistent: false }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void readTheme(dir).then(onChange);
      }, 150);
    });
  } catch {
    // No Omarchy here: nothing to watch.
  }
  return () => {
    if (timer) clearTimeout(timer);
    w?.close();
  };
}
