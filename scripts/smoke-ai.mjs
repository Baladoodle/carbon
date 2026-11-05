// `npm run smoke:ai`: a few small real requests through carbon's real AI
// gateway (src/main/ai/evals/smoke.eval.ts): two critiques (the second reads
// the first's cached prefix) and one streamed spread. Prints outcomes, usage
// and cost; never the key. Costs well under $0.01. See docs/AI-FIRST-RUN.md.
import { spawnSync } from 'node:child_process';
import { NO_KEY_HELP, resolveApiKey } from './lib/api-key.mjs';

const found = resolveApiKey();
if (!found) {
  console.log(`AI smoke test skipped.\n${NO_KEY_HELP}`);
  process.exit(0);
}
console.log(`AI smoke test: using the key from ${found.source}.`);
const r = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    '--config',
    'evals/vitest.config.mjs',
    '--reporter',
    'dot',
    'src/main/ai/evals/smoke.eval.ts',
  ],
  {
    stdio: 'inherit',
    env: { ...process.env, ANTHROPIC_API_KEY: found.key, CARBON_KEYRING: 'off' },
  },
);
process.exit(r.status ?? 1);
