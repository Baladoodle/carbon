// `npm run -s mcp`: `carbon mcp` from a checkout (docs/MCP.md). Runs the built
// relay (out/main/mcp.js; `npm run build` first) under this checkout's
// Electron in node mode, the way the installed launcher does. stdin and stdout
// are the agent's MCP stream, so nothing else is printed there.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'out/main/mcp.js');
if (!existsSync(entry)) {
  process.stderr.write('carbon mcp: out/main/mcp.js is missing: run `npm run build` first.\n');
  process.exit(1);
}
const child = spawn(String(electron), [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
