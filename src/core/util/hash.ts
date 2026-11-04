import { stableStringify } from './json';

/**
 * A fast, deterministic, non-cryptographic 64-bit hash (two FNV-1a lanes), as
 * 16 hex characters. Good for cache keys and stable ids, not for security.
 */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
    h2 ^= h2 >>> 15;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

/** Hash of a JSON-like value in canonical form (key order doesn't matter). */
export function hashValue(value: unknown): string {
  return hashString(stableStringify(value));
}

/** A small seeded PRNG (mulberry32) for deterministic generation in core. */
export function seededRandom(seed: string): () => number {
  let a = parseInt(hashString(seed).slice(0, 8), 16);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
