import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ghostText } from './Input';
import { depthTint, mix, TOKENS } from './tokens';

describe('tokens', () => {
  it('tokens.ts agrees with tokens.css and VISUAL.md', () => {
    const css = readFileSync(path.join(import.meta.dirname, 'tokens.css'), 'utf8');
    const kebab = (k: string): string => k.replace(/([A-Z0-9])/g, (m) => `-${m.toLowerCase()}`);
    for (const [k, v] of Object.entries(TOKENS)) {
      expect(css, k).toContain(`--${kebab(k)}: ${v};`);
    }
    expect(TOKENS.bg).toBe('#141416');
    expect(TOKENS.accent).toBe('#e8a54b');
  });

  it('tints by depth: warm below, cool above, pure bg at 0', () => {
    expect(depthTint(0)).toBe(TOKENS.bg);
    expect(depthTint(-1e9)).toBe(TOKENS.tintDeep);
    expect(depthTint(1e9)).toBe(TOKENS.tintHigh);
    const a = depthTint(-100);
    expect(a).not.toBe(TOKENS.bg);
    expect(a).not.toBe(TOKENS.tintDeep);
    expect(mix('#000000', '#ffffff', 0.5)).toBe('#808080');
  });
});

describe('ghostText', () => {
  it('completes a prefix, shows the whole suggestion when empty, or offers a replacement', () => {
    expect(ghostText('', 'Glass Lung')).toBe('Glass Lung');
    expect(ghostText('gla', 'Glass Lung')).toBe('ss Lung');
    expect(ghostText('Ember', 'Glass Lung')).toBe(' → Glass Lung');
    expect(ghostText('x', null)).toBe('');
  });
});
