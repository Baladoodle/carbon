import { z } from 'zod';

/**
 * Theme tokens: the colours every view uses (as CSS variables `--<name>`).
 * They follow the Omarchy theme (~/.config/omarchy/current/theme/), with Tokyo
 * Night built in as the fallback. Parsing is pure; src/main/theme reads files.
 */
export const TOKEN_NAMES = [
  'bg',
  'bg2',
  'panel',
  'line',
  'line2',
  'fg',
  'dim',
  'faint',
  'accent',
  'blue',
  'cyan',
  'green',
  'orange',
  'red',
  'purple',
  'yellow',
  'teal',
] as const;
export type TokenName = (typeof TOKEN_NAMES)[number];

const Hex = z.string().regex(/^#[0-9a-f]{6}$/i);
export const ThemeTokensSchema = z.object({
  name: z.string(),
  /** Where the colours came from: `omarchy:<file>` or `builtin`. */
  source: z.string(),
  dark: z.boolean(),
  colors: z.object(
    Object.fromEntries(TOKEN_NAMES.map((n) => [n, Hex])) as Record<TokenName, typeof Hex>,
  ),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;

/** Tokyo Night, matching design/mockups.html. */
export const TOKYO_NIGHT: ThemeTokens = {
  name: 'Tokyo Night',
  source: 'builtin',
  dark: true,
  colors: {
    bg: '#1a1b26',
    bg2: '#16161e',
    panel: '#1f2335',
    line: '#292e42',
    line2: '#3b4261',
    fg: '#c0caf5',
    dim: '#737aa2',
    faint: '#565f89',
    accent: '#7aa2f7',
    blue: '#7aa2f7',
    cyan: '#7dcfff',
    green: '#9ece6a',
    orange: '#ff9e64',
    red: '#f7768e',
    purple: '#bb9af7',
    yellow: '#e0af68',
    teal: '#73daca',
  },
};

/** A tiny TOML subset: `[section.sub]` headers and `key = "string"` pairs. Enough for theme files. */
export function parseTomlStrings(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) continue;
    const h = /^\[([^\]]+)\]$/.exec(line);
    if (h) {
      section = (h[1] ?? '').trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (kv) out.set(section ? `${section}.${kv[1] ?? ''}` : (kv[1] ?? ''), kv[2] ?? kv[3] ?? '');
  }
  return out;
}

const norm = (c: string | undefined): string | undefined => {
  if (!c) return undefined;
  const m = /^(?:#|0x)?([0-9a-f]{6})$/i.exec(c.trim());
  return m ? `#${(m[1] ?? '').toLowerCase()}` : undefined;
};

const rgb = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** Mixes two colours: `t` = 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const c = (x: number, y: number): string =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${c(ar, br)}${c(ag, bg)}${c(ab, bb)}`;
}

export const luminance = (hex: string): number => {
  const [r, g, b] = rgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/** The base palette a theme file gives us. */
interface Base {
  background: string;
  foreground: string;
  accent?: string | undefined;
  red?: string | undefined;
  green?: string | undefined;
  yellow?: string | undefined;
  blue?: string | undefined;
  magenta?: string | undefined;
  cyan?: string | undefined;
  brightRed?: string | undefined;
  brightCyan?: string | undefined;
}

/** Derives the full token set from a base palette, filling gaps from Tokyo Night. */
export function tokensFromBase(name: string, source: string, b: Base): ThemeTokens {
  const fb = TOKYO_NIGHT.colors;
  const dark = luminance(b.background) < 0.5;
  const toward = dark ? '#000000' : '#ffffff';
  const blue = b.blue ?? fb.blue;
  const red = b.red ?? fb.red;
  const yellow = b.yellow ?? fb.yellow;
  return {
    name,
    source,
    dark,
    colors: {
      bg: b.background,
      bg2: mix(b.background, toward, 0.18),
      panel: mix(b.background, b.foreground, 0.04),
      line: mix(b.background, b.foreground, 0.1),
      line2: mix(b.background, b.foreground, 0.2),
      fg: b.foreground,
      dim: mix(b.foreground, b.background, 0.38),
      faint: mix(b.foreground, b.background, 0.55),
      accent: b.accent ?? blue,
      blue,
      cyan: b.cyan ?? fb.cyan,
      green: b.green ?? fb.green,
      orange:
        b.brightRed && b.brightRed !== red ? mix(b.brightRed, yellow, 0.5) : mix(red, yellow, 0.5),
      red,
      purple: b.magenta ?? fb.purple,
      yellow,
      teal: b.brightCyan ?? mix(b.cyan ?? fb.cyan, b.green ?? fb.green, 0.5),
    },
  };
}

/**
 * Builds tokens from Omarchy theme files (name → content). Prefers
 * `colors.toml` (newer Omarchy), then `alacritty.toml`; returns `null` if
 * neither yields a background and foreground.
 */
export function tokensFromOmarchy(
  themeName: string,
  files: ReadonlyMap<string, string>,
): ThemeTokens | null {
  const colors = files.get('colors.toml');
  if (colors !== undefined) {
    const t = parseTomlStrings(colors);
    const g = (k: string): string | undefined => norm(t.get(k));
    const background = g('background');
    const foreground = g('foreground');
    if (background && foreground)
      return tokensFromBase(themeName, 'omarchy:colors.toml', {
        background,
        foreground,
        accent: g('accent'),
        red: g('color1'),
        green: g('color2'),
        yellow: g('color3'),
        blue: g('color4'),
        magenta: g('color5'),
        cyan: g('color6'),
        brightRed: g('color9'),
        brightCyan: g('color14'),
      });
  }
  const alacritty = files.get('alacritty.toml');
  if (alacritty !== undefined) {
    const t = parseTomlStrings(alacritty);
    const g = (k: string): string | undefined => norm(t.get(`colors.${k}`));
    const background = g('primary.background');
    const foreground = g('primary.foreground');
    if (background && foreground)
      return tokensFromBase(themeName, 'omarchy:alacritty.toml', {
        background,
        foreground,
        red: g('normal.red'),
        green: g('normal.green'),
        yellow: g('normal.yellow'),
        blue: g('normal.blue'),
        magenta: g('normal.magenta'),
        cyan: g('normal.cyan'),
        brightRed: g('bright.red'),
        brightCyan: g('bright.cyan'),
      });
  }
  return null;
}

/** CSS custom properties for the tokens, e.g. `--bg: #1a1b26;`. */
export const tokensToCss = (t: ThemeTokens): string =>
  `:root{${TOKEN_NAMES.map((n) => `--${n}:${t.colors[n]};`).join('')}color-scheme:${t.dark ? 'dark' : 'light'};}`;
