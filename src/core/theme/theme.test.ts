import { describe, expect, it } from 'vitest';
import {
  luminance,
  mix,
  parseTomlStrings,
  ThemeTokensSchema,
  tokensFromOmarchy,
  tokensToCss,
  TOKYO_NIGHT,
} from './theme';

const ALACRITTY = `
# a comment
[colors.primary]
background = "#24273a"
foreground = '#cad3f5'

[colors.normal]
red = "#ed8796" # trailing
green = "#a6da95"
blue = "0x8aadf4"
magenta = "#f5bde6"

[colors.bright]
red = "#ee99a0"
`;

describe('theme', () => {
  it('parses the TOML subset', () => {
    const t = parseTomlStrings(ALACRITTY);
    expect(t.get('colors.primary.background')).toBe('#24273a');
    expect(t.get('colors.primary.foreground')).toBe('#cad3f5');
    expect(t.get('colors.normal.red')).toBe('#ed8796');
    expect(parseTomlStrings('top = "x"\nnot a pair').get('top')).toBe('x');
  });

  it('builds valid tokens from alacritty.toml, filling gaps from Tokyo Night', () => {
    const t = tokensFromOmarchy('catppuccin', new Map([['alacritty.toml', ALACRITTY]]));
    expect(t).not.toBeNull();
    expect(ThemeTokensSchema.parse(t)).toMatchObject({
      name: 'catppuccin',
      source: 'omarchy:alacritty.toml',
      dark: true,
    });
    expect(t?.colors.blue).toBe('#8aadf4');
    expect(t?.colors.cyan).toBe(TOKYO_NIGHT.colors.cyan);
  });

  it('prefers colors.toml and handles light themes', () => {
    const t = tokensFromOmarchy(
      'light',
      new Map([
        [
          'colors.toml',
          'background = "#fafafa"\nforeground = "#383a42"\naccent = "#4078f2"\ncolor1 = "#e45649"',
        ],
        ['alacritty.toml', ALACRITTY],
      ]),
    );
    expect(t).toMatchObject({
      source: 'omarchy:colors.toml',
      dark: false,
      colors: { accent: '#4078f2', red: '#e45649' },
    });
    expect(ThemeTokensSchema.safeParse(t).success).toBe(true);
  });

  it('returns null when nothing usable is there', () => {
    expect(tokensFromOmarchy('x', new Map())).toBeNull();
    expect(
      tokensFromOmarchy(
        'x',
        new Map([
          ['colors.toml', 'accent = "#ffffff"'],
          ['alacritty.toml', '[colors.primary]\nbackground = "nope"'],
        ]),
      ),
    ).toBeNull();
  });

  it('mixes colours and emits CSS variables', () => {
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(luminance('#ffffff')).toBeCloseTo(1);
    expect(tokensToCss(TOKYO_NIGHT)).toContain('--bg:#1a1b26;');
    expect(ThemeTokensSchema.parse(TOKYO_NIGHT)).toEqual(TOKYO_NIGHT);
  });
});
