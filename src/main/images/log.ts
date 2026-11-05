import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ImageLogEntrySchema, type ImageLogEntry } from '@core/images/gateway';
import { usdToNanos } from '@core/images/pricing';

/**
 * The image log: one JSONL line per image call in
 * `<world>/ai-log/images-<YYYY-MM-DD>.jsonl`, beside Claude's log (whose
 * reader takes only `<YYYY-MM>…` names, so the two never mix), plus an
 * in-memory copy for the AI log overlay. Lines never hold the key: it is
 * never part of a request body we keep.
 */
export class ImageLogStore {
  private readonly entries: ImageLogEntry[] = [];
  private dir: string | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly limit = 5_000) {}

  attach(worldDir: string): void {
    this.dir = path.join(worldDir, 'ai-log');
  }

  add(entry: ImageLogEntry): void {
    const e = ImageLogEntrySchema.parse(entry);
    this.entries.push(e);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    const dir = this.dir;
    if (!dir) return;
    const file = path.join(dir, `images-${e.at.slice(0, 10)}.jsonl`);
    const line = `${JSON.stringify(e)}\n`;
    this.writing = this.writing
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(file, line, 'utf8');
      })
      .catch(() => undefined);
  }

  recent(limit = 200): ImageLogEntry[] {
    return this.entries.slice(-limit);
  }

  flush(): Promise<void> {
    return this.writing;
  }

  /** This month's spend from the files (`month` is `YYYY-MM`), in nano-dollars, and earlier entries for the overlay. */
  async load(month: string): Promise<number> {
    if (!this.dir) return 0;
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter(
        (f) => f.startsWith(`images-${month}`) && f.endsWith('.jsonl'),
      );
    } catch {
      return 0;
    }
    let nanos = 0;
    const loaded: ImageLogEntry[] = [];
    for (const f of files.sort()) {
      const text = await readFile(path.join(this.dir, f), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const r = ImageLogEntrySchema.safeParse(JSON.parse(line));
          if (!r.success) continue;
          nanos += usdToNanos(r.data.costUsd);
          loaded.push(r.data);
        } catch {
          // A torn last line (a crash mid-append) is skipped.
        }
      }
    }
    this.entries.unshift(...loaded.slice(-this.limit));
    return nanos;
  }
}
