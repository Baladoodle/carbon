// `npm run eval`: the prompt evals (docs/SYSTEM.md §8), run through the real AI
// gateway by src/main/ai/evals/eval.eval.ts. Reports go to evals/reports/.
//
//   npm run eval                    live: the Claude API (needs ANTHROPIC_API_KEY)
//   npm run eval -- --record        live, and save every exchange to evals/fixtures/recorded/
//   npm run eval -- --replay        offline, from the recorded fixtures
//   npm run eval -- --dry           offline, schema-generated answers (checks the pipeline only)
//   npm run eval -- --only critique run only the cases whose id contains "critique"
//   npm run eval -- --max-usd 0.5   stop starting cases once $0.50 is spent (default $1)
//
// The key comes from the system keyring, then ANTHROPIC_API_KEY (as in the
// app); it is never printed. See docs/AI-FIRST-RUN.md.
import { spawnSync } from 'node:child_process';
import { NO_KEY_HELP, resolveApiKey } from './lib/api-key.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = flag('record') ? 'record' : flag('replay') ? 'replay' : flag('dry') ? 'dry' : 'live';

const live = mode === 'live' || mode === 'record';
const found = live ? resolveApiKey() : undefined;
if (live && !found) {
  console.log(
    [
      'Prompt evals skipped.',
      NO_KEY_HELP,
      'Offline: `npm run eval -- --replay` (recorded fixtures) or `npm run eval -- --dry` (pipeline only).',
    ].join('\n'),
  );
  process.exit(0);
}
if (found) console.log(`Prompt evals (${mode}): using the key from ${found.source}.`);

const env = {
  ...process.env,
  ...(found ? { ANTHROPIC_API_KEY: found.key, CARBON_KEYRING: 'off' } : {}),
  CARBON_EVAL_MODE: mode,
  ...(value('only') ? { CARBON_EVAL_ONLY: value('only') } : {}),
  ...(value('max-usd') ? { CARBON_EVAL_MAX_USD: value('max-usd') } : {}),
};
const r = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'evals/vitest.config.mjs', 'src/main/ai/evals/eval.eval.ts'],
  { stdio: 'inherit', env },
);
process.exit(r.status ?? 1);
