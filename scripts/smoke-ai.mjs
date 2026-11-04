// `npm run smoke:ai`: two small real critiques through carbon's real AI gateway
// (src/main/ai/evals/smoke.eval.ts), the second reading the first's cached
// prefix. Prints outcomes, usage and cost, never the key.
import { spawnSync } from 'node:child_process';

if (!process.env.ANTHROPIC_API_KEY) {
  console.log(
    'AI smoke test skipped: ANTHROPIC_API_KEY is not set. Set it and run `npm run smoke:ai` again.',
  );
  process.exit(0);
}
const r = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'evals/vitest.config.mjs', 'src/main/ai/evals/smoke.eval.ts'],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
