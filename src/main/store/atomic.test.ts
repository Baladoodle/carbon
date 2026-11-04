import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, stat, writeFile, chmod, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanTempFiles, TMP_PATTERN, writeFileAtomic } from './atomic';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpDir = (): Promise<string> => mkdtemp(path.join(os.tmpdir(), 'carbon-atomic-'));

/** A file written by crash-writer.mjs is whole when every byte of its body is one letter and its trailer matches. */
function isWhole(text: string, size: number): boolean {
  const m = /^([a-z])\1*\nEND (\d+)\n$/.exec(text);
  if (!m) return false;
  const n = Number(m[2]);
  return (
    text.length === size + `\nEND ${n}\n`.length && m[1] === String.fromCharCode(97 + (n % 26))
  );
}

/**
 * Starts the writer, waits for a few completed writes, then kills it with
 * SIGKILL at a random moment (usually mid-write), and returns the file.
 */
async function killMidWrite(
  mode: 'atomic' | 'naive',
  dir: string,
  size: number,
  delayMs: number,
): Promise<string> {
  const target = path.join(dir, 'entity.md');
  const child = spawn(
    process.execPath,
    [
      path.join(here, 'testing/crash-writer.mjs'),
      path.join(here, 'atomic.ts'),
      target,
      mode,
      String(size),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let writes = 0;
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (writes < 2) reject(new Error(`writer exited early (${code})`));
    });
    child.stdout.on('data', (b: Buffer) => {
      writes += b.length;
      if (writes >= 2) resolve();
    });
  });
  await new Promise((r) => setTimeout(r, delayMs));
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGKILL');
  await exited;
  return readFile(target, 'utf8');
}

describe('writeFileAtomic', () => {
  it('writes, overwrites and creates directories', async () => {
    const dir = await tmpDir();
    const f = path.join(dir, 'a/b/c.json');
    await writeFileAtomic(f, 'one');
    await writeFileAtomic(f, 'two');
    expect(await readFile(f, 'utf8')).toBe('two');
    expect((await readdir(path.dirname(f))).filter((n) => TMP_PATTERN.test(n))).toEqual([]);
  });

  it('keeps the permission bits of the file it replaces', async () => {
    const dir = await tmpDir();
    const f = path.join(dir, 'x.md');
    await writeFile(f, 'old');
    await chmod(f, 0o600);
    await writeFileAtomic(f, 'new');
    expect((await stat(f)).mode & 0o777).toBe(0o600);
  });

  it('leaves the old file and no temporary file when the write fails', async () => {
    const dir = await tmpDir();
    const f = path.join(dir, 'x.md');
    await writeFile(f, 'old');
    // A directory where the target should be makes the rename fail.
    const blocked = path.join(dir, 'blocked');
    await mkdir(blocked);
    await mkdir(path.join(blocked, 'inner'));
    await expect(writeFileAtomic(blocked, 'new')).rejects.toThrow();
    expect((await readdir(dir)).filter((n) => TMP_PATTERN.test(n))).toEqual([]);
    expect(await readFile(f, 'utf8')).toBe('old');
  });

  it('cleanTempFiles removes stray temporary files, recursively, but not under .git', async () => {
    const dir = await tmpDir();
    await mkdir(path.join(dir, 'entities/item'), { recursive: true });
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, 'entities/item/.x.md.123.4.tmp'), 'half');
    await writeFile(path.join(dir, '.carbon.json.9.1.tmp'), 'half');
    await writeFile(path.join(dir, '.git/.keep.1.1.tmp'), 'git owns this');
    await writeFile(path.join(dir, 'entities/item/x.md'), 'real');
    expect(await cleanTempFiles(dir)).toEqual([
      '.carbon.json.9.1.tmp',
      'entities/item/.x.md.123.4.tmp',
    ]);
    expect(await readdir(path.join(dir, 'entities/item'))).toEqual(['x.md']);
    expect(await readdir(path.join(dir, '.git'))).toEqual(['.keep.1.1.tmp']);
  });
});

describe('crash simulation: kill -9 mid-write', () => {
  const SIZE = 4 * 1024 * 1024;

  it('the control: a naive writeFile killed mid-write leaves a torn file', async () => {
    // Proves the harness can see a half-written file at all.
    let torn = 0;
    for (let i = 0; i < 6 && torn === 0; i++) {
      const dir = await tmpDir();
      const text = await killMidWrite('naive', dir, SIZE, 3 + i * 7);
      if (!isWhole(text, SIZE)) torn++;
    }
    expect(torn).toBeGreaterThan(0);
  });

  it('writeFileAtomic killed at random moments never leaves a half-written file', async () => {
    const delays = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55];
    for (const d of delays) {
      const dir = await tmpDir();
      const text = await killMidWrite('atomic', dir, SIZE, d);
      expect(isWhole(text, SIZE), `torn file after a kill at +${d}ms`).toBe(true);
      // The temporary file the kill left behind is cleaned up on the next open.
      await cleanTempFiles(dir);
      expect(await readdir(dir)).toEqual(['entity.md']);
    }
  });
});
