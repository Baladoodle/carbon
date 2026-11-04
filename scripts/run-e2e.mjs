// Runs the Playwright end-to-end suite against the built app. Wraps it in
// `xvfb-run` when there is no display (cloud containers, CI). Extra arguments
// go to `playwright test` (e.g. `--grep @smoke`).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = ['playwright', 'test', ...process.argv.slice(2)];
const needsXvfb =
  process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
const hasXvfb = spawnSync('sh', ['-c', 'command -v xvfb-run'], { stdio: 'ignore' }).status === 0;
if (!existsSync('out/main/index.js')) {
  console.error('out/main/index.js is missing: run `npm run build` first.');
  process.exit(1);
}
const [cmd, cmdArgs] =
  needsXvfb && hasXvfb
    ? ['xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', 'npx', ...args]]
    : ['npx', args];
const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit' });
process.exit(r.status ?? 1);
