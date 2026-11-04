import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AiLogEntrySchema, type AiLogEntry } from '@core/ai/gateway';

/**
 * The AI log (SYSTEM §8 step 7): one JSONL record per call in
 * `<world>/ai-log/<YYYY-MM-DD>.jsonl`, plus an in-memory copy for the ctrl+l
 * overlay and the request text each call sent ("open the request it sent").
 *
 * Records hold the moment, entity, request hash, usage, cost, latency and the
 * outcome. With `ai.debug` on they also hold the full request params. They
 * never hold the API key: the key is never part of a request body.
 */
export interface AiLogRecord extends AiLogEntry {
  /** The full request params (only with `ai.debug`). */
  request?: unknown;
}

export interface SentRequest {
  /** The prompt as readable text, block by block. */
  text: string;
  /** The Messages API params (model, max_tokens, output_config …) without the prompt text. */
  params: Record<string, unknown>;
}

export class AiLogStore {
  private readonly entries: AiLogEntry[] = [];
  private readonly requests = new Map<string, SentRequest>();
  private dir: string | null = null;
  private writing: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(private readonly limit = 5_000) {}

  /** Starts writing JSONL into `<worldDir>/ai-log/`. */
  attach(worldDir: string): void {
    this.dir = path.join(worldDir, 'ai-log');
  }

  get directory(): string | null {
    return this.dir;
  }

  add(entry: AiLogRecord, request?: SentRequest): void {
    const { request: full, ...plain } = entry;
    this.entries.push(AiLogEntrySchema.parse(plain));
    if (this.entries.length > this.limit) {
      const gone = this.entries.splice(0, this.entries.length - this.limit);
      for (const g of gone) this.requests.delete(g.id);
    }
    if (request) this.requests.set(entry.id, request);
    const dir = this.dir;
    if (!dir) return;
    const line = `${JSON.stringify(full === undefined ? plain : { ...plain, request: full })}\n`;
    const file = path.join(dir, `${entry.at.slice(0, 10)}.jsonl`);
    this.writing = this.writing
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(file, line, 'utf8');
      })
      .catch((e: unknown) => {
        // The log must never break the AI; report once.
        if (!this.failed) console.error('carbon: could not write the AI log', e);
        this.failed = true;
      });
  }

  list(limit = 200): AiLogEntry[] {
    return this.entries.slice(-limit);
  }

  request(id: string): SentRequest | undefined {
    return this.requests.get(id);
  }

  /** Resolves when every queued write is on disk. */
  flush(): Promise<void> {
    return this.writing;
  }

  /**
   * Spend recorded this month (`YYYY-MM`) in the log files, for the monthly
   * budget. Unreadable lines are skipped.
   */
  async monthSpend(month: string): Promise<number> {
    if (!this.dir) return 0;
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((f) => f.startsWith(month) && f.endsWith('.jsonl'));
    } catch {
      return 0;
    }
    let usd = 0;
    for (const f of files.sort()) {
      const text = await readFile(path.join(this.dir, f), 'utf8').catch(() => '');
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const e = AiLogEntrySchema.safeParse(JSON.parse(line));
          if (e.success && e.data.meta && !e.data.meta.cached) usd += e.data.meta.costUsd;
        } catch {
          // a torn line from a crash: skip it
        }
      }
    }
    return usd;
  }
}
