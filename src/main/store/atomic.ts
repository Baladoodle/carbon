import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

let counter = 0;

/**
 * Writes a file atomically: a temporary file in the same directory, fsync,
 * rename over the target, then fsync the directory. A crash leaves either the
 * old file or the new one, never half of either.
 */
export async function writeFileAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${++counter}.tmp`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await syncDir(dir);
}

async function syncDir(dir: string): Promise<void> {
  try {
    const dh = await open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // Some platforms can't fsync a directory; the rename is still atomic.
  }
}
