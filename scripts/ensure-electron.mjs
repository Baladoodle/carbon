// Makes sure Electron's binary is present (npm can skip its download in CI or
// with --ignore-scripts). Safe to run repeatedly.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
let pkgDir;
try {
  pkgDir = path.dirname(require.resolve('electron/package.json'));
} catch {
  process.exit(0); // electron not installed (production install)
}
const pathFile = path.join(pkgDir, 'path.txt');
const ok =
  existsSync(pathFile) &&
  existsSync(path.join(pkgDir, 'dist', readFileSync(pathFile, 'utf8').trim()));
if (!ok) {
  // The download sometimes drops through proxies: try a few times.
  let status = 1;
  for (let attempt = 1; attempt <= 3 && status !== 0; attempt++) {
    status =
      spawnSync(process.execPath, [path.join(pkgDir, 'install.js')], { stdio: 'inherit' }).status ??
      1;
    if (status !== 0) console.warn(`electron download failed (attempt ${attempt}/3)`);
  }
  process.exit(status);
}
