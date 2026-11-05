import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

let counter = 0;

/** Temporary files carbon writes next to their target: `.<name>.<pid>.<n>.tmp`. */
export const TMP_PATTERN = /^\..+\.\d+\.\d+\.tmp$/;

/** One file of a batch: its new content, or `null` to remove it. */
export interface BatchOp {
  file: string;
  content: string | Uint8Array | null;
}

/** How many files a batch works on at once (fds open, fsyncs in flight). */
const CONCURRENCY = 16;

async function eachLimited<T>(xs: readonly T[], run: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < xs.length) await run(xs[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, xs.length) }, worker));
}

async function fsyncFile(file: string): Promise<void> {
  const fh = await open(file, 'r+');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/**
 * Writes and removes many files, each atomically and durably, with as few
 * waits on the disk as that allows (one transaction of thousands of commands
 * is one batch):
 *
 * 1. every new content goes to a temporary file next to its target
 * 2. each temporary file is fsynced; these run side by side, so the
 *    filesystem can commit them together instead of one journal commit each
 * 3. each one is renamed over its target, only once it is durable
 * 4. removals, after the writes (a file moved between folders is never
 *    missing from both)
 * 5. each directory touched is fsynced once, making the renames and
 *    removals durable
 *
 * A crash (or a kill) at any point leaves each file either old or new, never
 * half of either; files are not atomic *together* (some may be new and some
 * old, as with one write at a time). At worst stray temporary files remain,
 * which `cleanTempFiles` removes on the next open.
 *
 * A file that fails (a full disk, a directory in the way) is left as it was,
 * with its temporary file removed; the others still land. Returns the failed
 * files with their errors. A new file keeps the old one's permission bits, so
 * a hand-made `chmod` survives carbon saving the file.
 */
export async function writeBatchAtomic(ops: readonly BatchOp[]): Promise<Map<string, unknown>> {
  const failed = new Map<string, unknown>();
  const dirs = new Set<string>();
  const made = new Map<string, Promise<unknown>>();
  const staged: { file: string; tmp: string }[] = [];
  const writes = ops.filter(
    (o): o is BatchOp & { content: string | Uint8Array } => o.content !== null,
  );
  const removes = ops.filter((o) => o.content === null).map((o) => o.file);
  const drop = async (tmp: string): Promise<void> => {
    await rm(tmp, { force: true }).catch(() => undefined);
  };

  // 1. Temporary files.
  await eachLimited(writes, async ({ file, content }) => {
    const dir = path.dirname(file);
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${++counter}.tmp`);
    try {
      let mk = made.get(dir);
      if (!mk) made.set(dir, (mk = mkdir(dir, { recursive: true })));
      await mk;
      let mode = 0o644;
      try {
        mode = (await stat(file)).mode & 0o777;
      } catch {
        // new file
      }
      const fh = await open(tmp, 'w', mode);
      try {
        await fh.writeFile(content);
      } finally {
        await fh.close();
      }
      staged.push({ file, tmp });
    } catch (e) {
      failed.set(file, e);
      await drop(tmp);
    }
  });
  // 2. Make each durable before anything is renamed.
  const durable: typeof staged = [];
  await eachLimited(staged, async (s) => {
    try {
      await fsyncFile(s.tmp);
      durable.push(s);
    } catch (e) {
      failed.set(s.file, e);
      await drop(s.tmp);
    }
  });
  // 3. Rename each over its target, only now that every one is durable.
  await eachLimited(durable, async (s) => {
    try {
      await rename(s.tmp, s.file);
      dirs.add(path.dirname(s.file));
    } catch (e) {
      failed.set(s.file, e);
      await drop(s.tmp);
    }
  });
  // 4. Removals.
  await eachLimited(removes, async (file) => {
    try {
      await rm(file, { force: true });
      dirs.add(path.dirname(file));
    } catch (e) {
      failed.set(file, e);
    }
  });
  // 5. One fsync per directory.
  await eachLimited([...dirs], syncDir);
  return failed;
}

const throwFirst = (failed: Map<string, unknown>): void => {
  for (const e of failed.values()) throw e;
};

/**
 * Writes one file atomically: a temporary file in the same directory, fsync,
 * rename over the target, then fsync the directory (a batch of one).
 */
export async function writeFileAtomic(file: string, content: string | Uint8Array): Promise<void> {
  throwFirst(await writeBatchAtomic([{ file, content }]));
}

/** Removes a file and makes the removal durable (fsync of the directory). */
export async function removeFileDurable(file: string): Promise<void> {
  throwFirst(await writeBatchAtomic([{ file, content: null }]));
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
