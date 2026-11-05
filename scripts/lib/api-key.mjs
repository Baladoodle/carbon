// The API key for `npm run eval` and `npm run smoke:ai`, resolved the same way
// as the app (src/main/ai/key.ts): the system keyring first (Secret Service,
// via `secret-tool`), then ANTHROPIC_API_KEY. The key is never printed; only
// where it came from.
import { spawnSync } from 'node:child_process';

export const STORE_COMMAND =
  "secret-tool store --label='carbon: Anthropic API key' service carbon account anthropic-api-key";

export function resolveApiKey(env = process.env) {
  if (env.CARBON_KEYRING !== 'off') {
    try {
      const r = spawnSync(
        'secret-tool',
        ['lookup', 'service', 'carbon', 'account', 'anthropic-api-key'],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      const k = !r.error && r.status === 0 ? r.stdout.trim() : '';
      if (k) return { key: k, source: 'the system keyring' };
    } catch {
      // no keyring: fall through to the environment
    }
  }
  const e = (env.ANTHROPIC_API_KEY ?? '').trim();
  return e ? { key: e, source: 'ANTHROPIC_API_KEY' } : undefined;
}

export const NO_KEY_HELP = [
  'No API key found (checked the system keyring, then ANTHROPIC_API_KEY).',
  'Store one in the keyring (you are prompted for it; it never appears in your shell history):',
  `  ${STORE_COMMAND}`,
  'or export ANTHROPIC_API_KEY for this shell.',
].join('\n');
