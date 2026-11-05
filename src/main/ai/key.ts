import { spawnSync } from 'node:child_process';

/**
 * Where the API key comes from (SYSTEM §10): the system keyring first, then
 * `ANTHROPIC_API_KEY`. It is never stored in the world directory, never logged
 * and never printed; callers learn only where it came from.
 *
 * The keyring is the freedesktop Secret Service (GNOME Keyring, KeePassXC,
 * KWallet's bridge), read with `secret-tool`. Store the key once with:
 *
 *     secret-tool store --label='carbon: Anthropic API key' service carbon account anthropic-api-key
 *
 * `CARBON_KEYRING=off` skips the keyring (the e2e harness sets it, so a key on
 * the developer's machine never reaches a test run).
 */
export const KEYRING_ATTRIBUTES = ['service', 'carbon', 'account', 'anthropic-api-key'] as const;

export type KeySource = 'keyring' | 'env';

export interface ApiKey {
  key: string;
  source: KeySource;
}

/** Reads the keyring; `undefined` when there's no keyring, no entry or no `secret-tool`. */
export type KeyringReader = () => string | undefined;

export const readSecretTool: KeyringReader = () => {
  try {
    const r = spawnSync('secret-tool', ['lookup', ...KEYRING_ATTRIBUTES], {
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

export function resolveApiKey(
  env: NodeJS.ProcessEnv = process.env,
  readKeyring: KeyringReader = readSecretTool,
): ApiKey | undefined {
  if (env.CARBON_KEYRING !== 'off') {
    const k = readKeyring();
    if (k) return { key: k, source: 'keyring' };
  }
  const e = env.ANTHROPIC_API_KEY?.trim();
  return e ? { key: e, source: 'env' } : undefined;
}

export const NO_KEY_REASON = 'No API key: store one in the keyring or set ANTHROPIC_API_KEY';
