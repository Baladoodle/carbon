// A child process for the crash tests in atomic.test.ts: writes a large file
// over and over (atomically, or naively for the control), printing "w" after
// each completed write, until the parent kills it with SIGKILL.
// argv: <atomic.ts path> <target file> <mode: atomic|naive|batch> <size in bytes>
// batch: one writeBatchAtomic call per round over BATCH files (<target>.0 …),
// every file of round n holding version n.
import { open } from 'node:fs/promises';

const [atomicPath, target, mode, sizeArg] = process.argv.slice(2);
const { writeBatchAtomic, writeFileAtomic } = await import(atomicPath);
const BATCH = 40;
const size = Number(sizeArg);
/**
 * The naive control: truncate in place, then write in 64 KB chunks. This is
 * what a plain writeFile does to the file on disk, with the window between
 * truncation and the last byte made wide enough that a kill lands in it
 * reliably even on a loaded machine.
 */
async function naiveWrite(file, body) {
  const fh = await open(file, 'w');
  try {
    const buf = Buffer.from(body);
    for (let off = 0; off < buf.length; off += 65536) {
      await fh.write(buf, off, Math.min(65536, buf.length - off));
    }
  } finally {
    await fh.close();
  }
}

let n = 0;
for (;;) {
  n++;
  // Every byte of version n is the same letter, so a torn file is detectable.
  const letter = String.fromCharCode(97 + (n % 26));
  const body = `${letter.repeat(size)}\nEND ${n}\n`;
  if (mode === 'naive') await naiveWrite(target, body);
  else if (mode === 'batch') {
    const ops = Array.from({ length: BATCH }, (_, i) => ({
      file: `${target}.${i}`,
      content: body,
    }));
    const failed = await writeBatchAtomic(ops);
    if (failed.size > 0) throw [...failed.values()][0];
  } else await writeFileAtomic(target, body);
  process.stdout.write('w');
}
