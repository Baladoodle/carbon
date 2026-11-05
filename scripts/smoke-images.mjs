// `npm run smoke:images`: a few real, LOW-quality OpenAI image calls through
// carbon's real image gateway (src/main/images/smoke.eval.ts): a concept, a
// generated icon, an icon edited from the concept, and the same on
// gpt-image-2.6-sunburst. Prints outcome, usage, cost and latency per call;
// never the key. Records the PNGs and usage as fixtures under fixtures/images/.
//
// The key: the keyring (service carbon, account openai-api-key), then
// OPENAI_API_KEY. In an environment whose network proxy injects the key,
// pass `-- --proxy`: the SDK gets the placeholder `sk-proxy`.
//
// A ledger (fixtures/images/ledger.json) counts every real call; the script
// refuses to go past CARBON_IMAGES_MAX_CALLS (default 12) in total.
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const proxy = args.includes('--proxy');
const env = { ...process.env, CARBON_IMAGES_SMOKE: '1' };
if (proxy) {
  env.CARBON_IMAGES_SMOKE_PROXY = '1';
  env.NODE_USE_ENV_PROXY = '1';
  if (!env.NODE_EXTRA_CA_CERTS && env.SSL_CERT_FILE) env.NODE_EXTRA_CA_CERTS = env.SSL_CERT_FILE;
}
const only = args.find((a) => a.startsWith('--only='));
if (only) env.CARBON_IMAGES_SMOKE_ONLY = only.slice('--only='.length);
const r = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'scripts/smoke-images.vitest.mjs', 'src/main/images/smoke.eval.ts'],
  { stdio: 'inherit', env },
);
process.exit(r.status ?? 1);
