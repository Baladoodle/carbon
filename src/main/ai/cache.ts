/**
 * The content-hash result cache (EXPERIENCE §5: "a critique of an unchanged
 * entity, with unchanged context and taste, is never sent twice"). Keyed by
 * the hash of the canonical request plus the moment, so any change to the
 * entity, its neighbourhood, the digest or the taste is a new key. In memory,
 * least recently used first out; it lives for the session.
 */
export class ResultCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly capacity = 500) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}
