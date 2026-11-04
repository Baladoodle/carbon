/**
 * One AI request at a time per entity (docs/EXPERIENCE.md §5): a new trigger
 * cancels the stale one. Requests are grouped in channels: `field` (suggest
 * one, suggest three, fill) and `critique`. A new request in a channel aborts
 * the one in flight for the same entity and channel; the two channels don't
 * cancel each other, so finishing an edit doesn't throw away a fill you just
 * asked for. Framework-free, so it's unit-tested.
 */
export type Channel = 'field' | 'critique';

export class RequestSlots {
  private readonly live = new Map<string, AbortController>();

  private key(entity: string, channel: Channel): string {
    return `${entity}\u0000${channel}`;
  }

  /** Starts a request: aborts the stale one, returns the new one's signal. */
  start(entity: string, channel: Channel): AbortSignal {
    const k = this.key(entity, channel);
    this.live.get(k)?.abort();
    const ac = new AbortController();
    this.live.set(k, ac);
    return ac.signal;
  }

  /** Whether `signal` is still the current request (its result may be shown). */
  isCurrent(entity: string, channel: Channel, signal: AbortSignal): boolean {
    return !signal.aborted && this.live.get(this.key(entity, channel))?.signal === signal;
  }

  /** Marks a request finished (only if it's still the current one). */
  finish(entity: string, channel: Channel, signal: AbortSignal): void {
    const k = this.key(entity, channel);
    if (this.live.get(k)?.signal === signal) this.live.delete(k);
  }

  /** Cancels a channel (or every channel) of an entity. */
  cancel(entity: string, channel?: Channel): void {
    for (const c of channel ? [channel] : (['field', 'critique'] as const)) {
      const k = this.key(entity, c);
      this.live.get(k)?.abort();
      this.live.delete(k);
    }
  }

  /** Requests in flight. */
  get size(): number {
    return this.live.size;
  }
}
