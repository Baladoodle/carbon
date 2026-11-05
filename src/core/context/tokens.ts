/**
 * Local token estimates (docs/SYSTEM.md §8 step 3). Deliberately conservative:
 * `claude-haiku-5-5` uses a newer tokenizer that counts the same text as
 * roughly 30% more tokens than older models (about 3 characters per token for
 * English and JSON). Overestimating is safe, because the packer stays under its
 * budget and the gateway calls `count_tokens` for an exact figure near the limit.
 *
 * ASCII counts at CHARS_PER_TOKEN. Anything else counts as its UTF-8 length in
 * tokens: a byte-level tokenizer never makes more tokens than bytes, so emoji,
 * CJK or accented text can't make a request larger than its estimate.
 */

/** ASCII characters per token assumed by the estimate. Lower = more conservative. */
export const CHARS_PER_TOKEN = 2.8;

/** Fixed overhead per text block (role and block framing). */
export const BLOCK_OVERHEAD = 4;

/** UTF-8 bytes of the code unit at `i` (a surrogate pair counts 4 at its high half, 0 at its low). */
function unitCost(text: string, i: number): { ascii: boolean; bytes: number; width: number } {
  const c = text.charCodeAt(i);
  if (c < 0x80) return { ascii: true, bytes: 1, width: 1 };
  if (c < 0x800) return { ascii: false, bytes: 2, width: 1 };
  if (c >= 0xd800 && c <= 0xdbff) {
    const d = text.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return { ascii: false, bytes: 4, width: 2 };
  }
  return { ascii: false, bytes: 3, width: 1 };
}

/** Estimated tokens for one piece of text. Monotonic in length; 0 for "". */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < text.length;) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      ascii++;
      i++;
      continue;
    }
    const u = unitCost(text, i);
    other += u.bytes;
    i += u.width;
  }
  return Math.ceil(ascii / CHARS_PER_TOKEN) + other + BLOCK_OVERHEAD;
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
 * marker doesn't fit. Never cuts a character in half.
 */
export function clipToTokens(text: string, maxTokens: number): string {
  if (estimateTokens(text) <= maxTokens) return text;
  // The marker is a space (ASCII) and "…" (3 UTF-8 bytes).
  const marker = ' …';
  const fits = (a: number, o: number): boolean =>
    Math.ceil((a + 1) / CHARS_PER_TOKEN) + o + 3 + BLOCK_OVERHEAD <= maxTokens;
  if (!fits(0, 0)) return '';
  // The longest prefix that fits with the marker.
  let ascii = 0;
  let other = 0;
  let end = 0;
  for (let i = 0; i < text.length;) {
    const u = unitCost(text, i);
    const a = ascii + (u.ascii ? 1 : 0);
    const o = other + (u.ascii ? 0 : u.bytes);
    if (!fits(a, o)) break;
    ascii = a;
    other = o;
    i += u.width;
    end = i;
  }
  if (end === 0) return '';
  let cut = text.slice(0, end);
  const nl = cut.lastIndexOf('\n');
  const sp = cut.lastIndexOf(' ');
  const at = nl > end * 0.6 ? nl : sp > end * 0.6 ? sp : -1;
  if (at > 0) cut = cut.slice(0, at);
  return `${cut.trimEnd()}${marker}`;
}
