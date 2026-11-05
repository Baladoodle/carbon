/**
 * Token values for code that can't use CSS variables (canvas, computed SVG
 * colours). Keep in sync with tokens.css; a unit test checks they agree.
 */
export const TOKENS = {
  bg: '#141416',
  surface1: '#19191c',
  surface2: '#1f1f23',
  surface3: '#26262b',
  line: '#2a2a2f',
  lineStrong: '#37373d',
  text: '#ececee',
  text2: '#a3a3ab',
  text3: '#6e6e78',
  accent: '#e8a54b',
  accentFg: '#1a1205',
  stateIdea: '#8b8b95',
  stateShaped: '#7da7d9',
  stateDecided: '#e8a54b',
  stateExported: '#7fbf8e',
  danger: '#e5675e',
  warn: '#d9b45a',
  ai: '#b39ddb',
  tintDeep: '#1a1614',
  tintHigh: '#14171a',
  climateCold: '#6f9bd1',
  climateWarm: '#e09a52',
  climateWet: '#63b0aa',
} as const;

const rgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
];

/** Mixes two hex colours; `t` = 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = rgb(a);
  const y = rgb(b);
  return `#${x
    .map((v, i) =>
      Math.round(v + ((y[i] ?? 0) - v) * t)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/**
 * The Column's depth tint for a band at height `y` (VISUAL.md §2): deeper
 * leans warm, higher leans cool, Y 0 is pure `--bg`. `scale` is the height at
 * which the tint is full (log-scaled, so the endless ends saturate gently).
 */
export function depthTint(y: number, scale = 4096): string {
  if (y === 0 || Number.isNaN(y)) return TOKENS.bg;
  const t = Math.min(1, Math.log10(1 + Math.abs(y)) / Math.log10(1 + scale));
  return mix(TOKENS.bg, y < 0 ? TOKENS.tintDeep : TOKENS.tintHigh, t);
}
