import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

let counter = 0;

/** Temporary files carbon writes next to their target: `.<name>.<pid>.<n>.tmp`. */
export const TMP_PATTERN = /^\..+\.\d+\.\d+\.tmp$/;

/**
 * Writes a file atomically: a temporary file in the same directory, fsync,
 * rename over the target, then fsync the directory. A crash (or a kill) at any
 * point leaves either the old file or the new one, never half of either; at
 * worst a stray temporary file, which `cleanTempFiles` removes on the next open.
 *
 * The new file keeps the old one's permission bits, so a hand-made `chmod`
 * survives carbon saving the file.
 */
export async function writeFileAtomic(file: string, content: string | Uint8Array): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  let mode = 0o644;
  try {
    mode = (await stat(file)).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${++counter}.tmp`);
  try {
    const fh = await open(tmp, 'w', mode);
    try {
      await fh.writeFile(content);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  await syncDir(dir);
}

/** Removes a file and makes the removal durable (fsync of the directory). */
export async function removeFileDurable(file: string): Promise<void> {
  await rm(file, { force: true });
  await syncDir(path.dirname(file));
}

export async function syncDir(dir: string): Promise<void> {
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

/**
 * Removes temporary files left behind by a crash mid-write, in `dir` and its
 * subdirectories (skipping `.git`). Returns the relative paths removed.
 */
export async function cleanTempFiles(
  dir: string,
  skip: readonly string[] = ['.git'],
): Promise<string[]> {
  const removed: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) {
        if (!skip.includes(r)) await walk(r);
      } else if (d.isFile() && TMP_PATTERN.test(d.name)) {
        await rm(path.join(dir, r), { force: true });
        removed.push(r);
      }
    }
  };
  await walk('');
  return removed.sort();
}
