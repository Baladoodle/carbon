// A child process for the crash tests in atomic.test.ts: writes a large file
// over and over (atomically, or naively for the control), printing "w" after
// each completed write, until the parent kills it with SIGKILL.
// argv: <atomic.ts path> <target file> <mode: atomic|naive> <size in bytes>
import { writeFile } from 'node:fs/promises';

const [atomicPath, target, mode, sizeArg] = process.argv.slice(2);
const { writeFileAtomic } = await import(atomicPath);
const size = Number(sizeArg);
let n = 0;
for (;;) {
  n++;
  // Every byte of version n is the same letter, so a torn file is detectable.
  const letter = String.fromCharCode(97 + (n % 26));
  const body = `${letter.repeat(size)}\nEND ${n}\n`;
  if (mode === 'naive') await writeFile(target, body);
  else await writeFileAtomic(target, body);
  process.stdout.write('w');
}
