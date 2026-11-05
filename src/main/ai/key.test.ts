import { describe, expect, it } from 'vitest';
import { resolveApiKey } from './key';

describe('the API key: keyring first, then the environment', () => {
  const keyring = (k?: string) => () => k;
  it('prefers the keyring', () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: 'env-key' }, keyring('ring-key'))).toEqual({
      key: 'ring-key',
      source: 'keyring',
    });
  });
  it('falls back to ANTHROPIC_API_KEY', () => {
    expect(resolveApiKey({ ANTHROPIC_API_KEY: ' env-key\n' }, keyring())).toEqual({
      key: 'env-key',
      source: 'env',
    });
  });
  it('is undefined with neither, or a blank variable', () => {
    expect(resolveApiKey({}, keyring())).toBeUndefined();
    expect(resolveApiKey({ ANTHROPIC_API_KEY: '  ' }, keyring())).toBeUndefined();
  });
  it('CARBON_KEYRING=off skips the keyring', () => {
    let asked = false;
    const r = resolveApiKey({ CARBON_KEYRING: 'off' }, () => {
      asked = true;
      return 'ring-key';
    });
    expect(r).toBeUndefined();
    expect(asked).toBe(false);
  });
  it('a missing secret-tool reads as no keyring, never a throw', async () => {
    const { readSecretTool } = await import('./key');
    expect(() => readSecretTool()).not.toThrow();
  });
});
