import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Meta from './meta';
import { Dismissals } from './dismissals';
import { META } from './meta';

/** The next `failNext` writes of the dismissals file fail, as a full disk would. */
let failNext = 0;
vi.mock('./meta', async (orig) => {
  const real = await orig<typeof Meta>();
  return {
    ...real,
    writeJson: async (dir: string, rel: string, value: unknown) => {
      if (failNext > 0) {
        failNext--;
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      }
      return real.writeJson(dir, rel, value);
    },
  };
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-dismissals-'));
  failNext = 0;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('Dismissals after a failed write', () => {
  it('the failed save reports, and the next save still lands (with everything)', async () => {
    const d = new Dismissals(dir);
    failNext = 1;
    await expect(d.set('check:a', 'h1')).rejects.toThrow(/ENOSPC/);
    await d.set('check:b', 'h2');
    const raw = JSON.parse(await readFile(path.join(dir, META.dismissals), 'utf8')) as unknown;
    expect(raw).toEqual({ version: 1, notes: { 'check:a': 'h1', 'check:b': 'h2' } });
  });
});
