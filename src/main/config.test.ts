import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveWorldDir } from './config';

afterEach(() => vi.unstubAllEnvs());

describe('resolveWorldDir', () => {
  it('prefers --world, then CARBON_WORLD_DIR, then settings, then ~/infinite-bible', async () => {
    const userData = await mkdtemp(path.join(os.tmpdir(), 'carbon-cfg-'));
    vi.stubEnv('CARBON_WORLD_DIR', '');
    delete process.env.CARBON_WORLD_DIR;
    expect(resolveWorldDir([], userData)).toBe(path.join(os.homedir(), 'infinite-bible'));
    await writeFile(
      path.join(userData, 'settings.json'),
      JSON.stringify({ worldDir: '/w/settings' }),
    );
    expect(resolveWorldDir([], userData)).toBe('/w/settings');
    vi.stubEnv('CARBON_WORLD_DIR', '~/from-env');
    expect(resolveWorldDir([], userData)).toBe(path.join(os.homedir(), 'from-env'));
    expect(resolveWorldDir(['electron', '.', '--world', '/w/arg'], userData)).toBe('/w/arg');
    expect(resolveWorldDir(['--world=/w/eq'], userData)).toBe('/w/eq');
    await writeFile(path.join(userData, 'settings.json'), '{');
    vi.stubEnv('CARBON_WORLD_DIR', '/w/env');
    expect(resolveWorldDir([], userData)).toBe('/w/env');
    await rm(userData, { recursive: true, force: true });
  });
});
