import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AgentSettingsSchema, type AgentSettings } from '@shared/agent';
import { writeFileAtomic } from '../store/atomic';

/**
 * Agent access (docs/MCP.md §2), in `<userData>/agent.json`: outside the world
 * directory, so nothing an agent can write (the world's files) changes it.
 */
const FileSchema = z.object({
  settings: AgentSettingsSchema.default(AgentSettingsSchema.parse({})),
});

export class AgentSettingsStore {
  private current: AgentSettings = AgentSettingsSchema.parse({});
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  static at(userData: string): AgentSettingsStore {
    return new AgentSettingsStore(path.join(userData, 'agent.json'));
  }

  /** Reads the file; a missing or unreadable one gives the defaults (access on). */
  async load(): Promise<void> {
    try {
      const r = FileSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      if (r.success) this.current = r.data.settings;
    } catch {
      // first run, or unreadable: the defaults
    }
  }

  get(): AgentSettings {
    return this.current;
  }

  async set(patch: Partial<AgentSettings>): Promise<AgentSettings> {
    this.current = AgentSettingsSchema.parse({ ...this.current, ...patch });
    const body = `${JSON.stringify({ settings: this.current }, null, 2)}\n`;
    this.queue = this.queue
      .then(() => writeFileAtomic(this.file, body))
      .catch((e: unknown) => console.error('carbon: saving agent settings', e));
    await this.queue;
    return this.current;
  }

  flush(): Promise<void> {
    return this.queue;
  }
}
