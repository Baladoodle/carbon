/**
 * The last line of defence for "a request never contains the API key": before
 * anything is sent (count_tokens included), the request is scanned for the key
 * itself and for anything shaped like an Anthropic key. A world can hold one by
 * accident (pasted into a description); sending it would put it in a prompt,
 * the request log and the provider's logs. The key is never printed, only
 * compared.
 */

/** Anthropic keys (`sk-ant-api03-…`, `sk-ant-admin01-…`). */
const KEY_SHAPE = /sk-ant-[A-Za-z0-9]+-[A-Za-z0-9_-]{16,}/;

/** The keys this process knows: the client's and the environment's. */
function knownKeys(clientKey: string | null | undefined): string[] {
  const out: string[] = [];
  for (const k of [clientKey, process.env.ANTHROPIC_API_KEY])
    if (typeof k === 'string' && k.length >= 16) out.push(k);
  return out;
}

/** Whether a request (any JSON value) holds an API key. */
export function holdsSecret(request: unknown, clientKey?: string | null): boolean {
  const text = JSON.stringify(request);
  if (KEY_SHAPE.test(text)) return true;
  return knownKeys(clientKey).some((k) => text.includes(k));
}
