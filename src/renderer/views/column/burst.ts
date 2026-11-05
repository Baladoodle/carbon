/**
 * A burst of keyboard nudges (arrow keys on the Climate plane, alt+k/j on a
 * band edge) as one change: each press updates a live draft at once, and the
 * draft is committed as one command (one undo step) once the keys go quiet.
 *
 * Every press builds on the draft, not on the world, so presses that come
 * faster than a command's round trip are never lost. Framework-free, so it's
 * unit-tested with fake timers.
 */
export class Burst<T> {
  private cur: { key: string; value: T } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();

  /**
   * @param commit writes a draft; resolves once the world shows it (the draft
   *   is shown until then, so the view never flickers back).
   * @param quietMs how long the keys must rest before the burst commits.
   */
  constructor(
    private readonly commit: (key: string, value: T) => Promise<unknown>,
    private readonly quietMs = 600,
  ) {}

  /** The live draft for `key`, if a burst is drafting or landing it. */
  get(key: string): T | undefined {
    return this.cur?.key === key ? this.cur.value : undefined;
  }

  /** The draft, whatever its key. */
  get current(): { key: string; value: T } | null {
    return this.cur;
  }

  /** Whether a draft is waiting for the keys to go quiet (not yet sent). */
  get waiting(): boolean {
    return this.timer !== null;
  }

  /** Sets the draft for `key` and (re)starts the quiet timer. A draft for another key commits first. */
  push(key: string, value: T): void {
    if (this.cur && this.cur.key !== key) this.flush();
    this.cur = { key, value };
    this.restart();
    this.emit();
  }

  /** Commits the draft now (when it's still waiting). */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.send();
  }

  /** Drops a waiting draft (undo before it was sent). Returns whether there was one. */
  cancel(): boolean {
    if (!this.timer) return false;
    clearTimeout(this.timer);
    this.timer = null;
    this.cur = null;
    this.emit();
    return true;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private restart(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.send();
    }, this.quietMs);
  }

  private send(): void {
    const sent = this.cur;
    if (!sent) return;
    void this.commit(sent.key, sent.value).finally(() => {
      // A press that came while this landed keeps its newer draft.
      if (this.cur === sent) {
        this.cur = null;
        this.emit();
      }
    });
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }
}
