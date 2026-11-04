/**
 * Local token estimates (docs/SYSTEM.md §8 step 3). Deliberately conservative:
 * `claude-haiku-5-5` uses a newer tokenizer that counts the same text as
 * roughly 30% more tokens than older models (about 3 characters per token for
 * English and JSON). Overestimating is safe, because the packer stays under its
 * budget and the gateway calls `count_tokens` for an exact figure near the limit.
 */

/** Characters per token assumed by the estimate. Lower = more conservative. */
export const CHARS_PER_TOKEN = 2.8;

/** Fixed overhead per text block (role and block framing). */
export const BLOCK_OVERHEAD = 4;

/** Estimated tokens for one piece of text. Monotonic in length; 0 for "". */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD;
}

/** Estimated tokens for several blocks sent together. */
export function estimateBlocks(texts: readonly string[]): number {
  let n = 0;
  for (const t of texts) n += estimateTokens(t);
  return n;
}

/**
 * Cuts `text` so that `estimateTokens(result) <= maxTokens`, at a line or word
 * boundary where possible, marking the cut with " …". Returns "" if even the
 * marker doesn't fit.
 */
export function clipToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  const marker = ' …';
  const maxChars = Math.floor((maxTokens - BLOCK_OVERHEAD) * CHARS_PER_TOKEN) - marker.length;
  if (maxChars <= 0) return '';
  let cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf('\n');
  const sp = cut.lastIndexOf(' ');
  const at = nl > maxChars * 0.6 ? nl : sp > maxChars * 0.6 ? sp : -1;
  if (at > 0) cut = cut.slice(0, at);
  return `${cut.trimEnd()}${marker}`;
}
