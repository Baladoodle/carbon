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
// The key is checked by name only; it is never printed.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = flag('record') ? 'record' : flag('replay') ? 'replay' : flag('dry') ? 'dry' : 'live';

if ((mode === 'live' || mode === 'record') && !process.env.ANTHROPIC_API_KEY) {
  console.log(
    [
      'Prompt evals skipped: ANTHROPIC_API_KEY is not set.',
      'Set it and run `npm run eval` (or `npm run eval -- --record` to save fixtures).',
      'Offline: `npm run eval -- --replay` (recorded fixtures) or `npm run eval -- --dry` (pipeline only).',
    ].join('\n'),
  );
  process.exit(0);
}

const env = {
  ...process.env,
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
