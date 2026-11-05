// `npm run dev:sample`: runs `electron-vite dev` on a scratch copy of the
// sample world (the fixture itself is never modified).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(os.tmpdir(), 'carbon-sample-'));
cpSync('fixtures/worlds/sample', dir, { recursive: true });
console.log(`carbon: sample world copied to ${dir}`);
console.log('carbon: agents connect with `npm run -s mcp` (after `npm run build`; docs/MCP.md)');
const r = spawnSync('npx', ['electron-vite', 'dev', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    CARBON_WORLD_DIR: dir,
    CARBON_AI: process.env.CARBON_AI ?? 'fake',
    CARBON_IMAGES: process.env.CARBON_IMAGES ?? 'fake',
  },
});
process.exit(r.status ?? 1);
