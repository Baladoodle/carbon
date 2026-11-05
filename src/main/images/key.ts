import { spawnSync } from 'node:child_process';
import type { KeyringReader, KeySource } from '../ai/key';

/**
 * The OpenAI key, found the way review-b finds the Anthropic key
 * (src/main/ai/key.ts): the system keyring first (service `carbon`, account
 * `openai-api-key`), then `OPENAI_API_KEY`. It is never logged, never
 * written and never printed; callers learn only where it came from.
 *
 *     secret-tool store --label='carbon: OpenAI API key' service carbon account openai-api-key
 *
 * `CARBON_KEYRING=off` skips the keyring (the e2e harness sets it).
 */
export const OPENAI_KEYRING_ATTRIBUTES = [
  'service',
  'carbon',
  'account',
  'openai-api-key',
] as const;

export const readOpenAiKeyring: KeyringReader = () => {
  try {
    const r = spawnSync('secret-tool', ['lookup', ...OPENAI_KEYRING_ATTRIBUTES], {
      encoding: 'utf8',
      timeout: 3_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.error || r.status !== 0) return undefined;
    const key = r.stdout.trim();
    return key === '' ? undefined : key;
  } catch {
    return undefined;
  }
};

export function resolveOpenAiKey(
  env: NodeJS.ProcessEnv = process.env,
  readKeyring: KeyringReader = readOpenAiKeyring,
): { key: string; source: KeySource } | undefined {
  if (env.CARBON_KEYRING !== 'off') {
    const k = readKeyring();
    if (k) return { key: k, source: 'keyring' };
  }
  const e = env.OPENAI_API_KEY?.trim();
  return e ? { key: e, source: 'env' } : undefined;
}

export const NO_OPENAI_KEY_REASON =
  'No OpenAI key: store one in the keyring (service carbon, account openai-api-key) or set OPENAI_API_KEY';
