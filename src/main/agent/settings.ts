import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AgentSettingsSchema, type AgentSettings } from '@shared/agent';
import { writeFileAtomic } from '../store/atomic';
import type { SpendMeter } from './host';

/**
 * Agent access and spending (docs/MCP.md §1, §4), in `<userData>/agent.json`:
 * outside the world directory on purpose, so nothing an agent can write
 * (the world's files) can turn on its own spending. It also keeps this
 * month's agent spend, so the monthly budget survives a restart.
 */
const FileSchema = z.object({
  settings: AgentSettingsSchema.default(AgentSettingsSchema.parse({})),
  spent: z.object({ month: z.string(), usd: z.number().min(0) }).optional(),
});

const nanos = (usd: number): number => Math.round(usd * 1e9);

export class AgentSettingsStore implements SpendMeter {
  private current: AgentSettings = AgentSettingsSchema.parse({});
  private sessionNanos = 0;
  private month = '';
  private monthBaseNanos = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static at(userData: string, now?: () => Date): AgentSettingsStore {
    return new AgentSettingsStore(path.join(userData, 'agent.json'), now);
  }

  /** Reads the file; a missing or unreadable one gives the defaults (access on, spending off). */
  async load(): Promise<void> {
    this.month = this.thisMonth();
    try {
      const r = FileSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      if (!r.success) return;
      this.current = r.data.settings;
      if (r.data.spent?.month === this.month) this.monthBaseNanos = nanos(r.data.spent.usd);
    } catch {
      // first run, or unreadable: the defaults
    }
  }

  get(): AgentSettings {
    return this.current;
  }

  async set(patch: Partial<AgentSettings>): Promise<AgentSettings> {
    this.current = AgentSettingsSchema.parse({ ...this.current, ...patch });
    await this.save();
    return this.current;
  }

  private thisMonth(): string {
    return this.now().toISOString().slice(0, 7);
  }

  /** Spend this session and this month (USD). */
  spend(): { sessionUsd: number; monthUsd: number } {
    this.roll();
    return {
      sessionUsd: this.sessionNanos / 1e9,
      monthUsd: (this.monthBaseNanos + this.sessionNanos) / 1e9,
    };
  }

  remaining(budget: AgentSettings['budget']): number {
    const s = this.spend();
    return Math.min(budget.sessionUsd - s.sessionUsd, budget.monthUsd - s.monthUsd);
  }

  add(usd: number): void {
    if (!(usd > 0)) return;
    this.roll();
    this.sessionNanos += nanos(usd);
    void this.save();
  }

  /** A new month starts the month's count again (the session's spend moves with it). */
  private roll(): void {
    const m = this.thisMonth();
    if (m === this.month) return;
    this.month = m;
    this.monthBaseNanos = -this.sessionNanos;
  }

  private save(): Promise<void> {
    const body = {
      settings: this.current,
      spent: {
        month: this.month || this.thisMonth(),
        usd: (this.monthBaseNanos + this.sessionNanos) / 1e9,
      },
    };
    this.queue = this.queue
      .then(() => writeFileAtomic(this.file, `${JSON.stringify(body, null, 2)}\n`))
      .catch((e: unknown) => console.error('carbon: saving agent settings', e));
    return this.queue;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}
