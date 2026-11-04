import Anthropic from '@anthropic-ai/sdk';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { World } from '@core/model/world';
import { ClaudeAiGateway } from '../gateway';
import { requestKey, type RecordedExchange } from '../replay';
import { MODEL } from '../settings';
import type { EvalCase } from './cases';
import type { CaseRun } from './metrics';

/**
 * Runs eval cases through the REAL gateway, with a `fetch` that sees every
 * exchange: the raw model output feeds the metrics, and in record mode each
 * exchange is saved as a fixture (`evals/fixtures/recorded/`), the key never
 * included (it lives only in request headers, which are never recorded, and
 * every file is checked for it before writing).
 */

/** Rebuilds the final message from a Messages API SSE stream. */
export function messageFromSse(text: string): Anthropic.Message | undefined {
  let message: Anthropic.Message | undefined;
  const blocks: Record<number, { type: string; text: string }> = {};
  for (const chunk of text.split('\n\n')) {
    const data = chunk
      .split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6))
      .join('');
    if (!data) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    const index = typeof ev.index === 'number' ? ev.index : 0;
    if (ev.type === 'message_start') message = structuredClone(ev.message as Anthropic.Message);
    else if (ev.type === 'content_block_start') {
      const b = ev.content_block as { type: string; text?: string };
      blocks[index] = { type: b.type, text: b.text ?? '' };
    } else if (ev.type === 'content_block_delta') {
      const d = ev.delta as { type: string; text?: string };
      const b = blocks[index];
      if (b && d.type === 'text_delta') b.text += d.text ?? '';
    } else if (ev.type === 'message_delta' && message) {
      const d = ev.delta as { stop_reason?: Anthropic.StopReason };
      if (d.stop_reason) message.stop_reason = d.stop_reason;
      message.usage = { ...message.usage, ...(ev.usage as Partial<Anthropic.Usage>) };
    }
  }
  if (!message) return undefined;
  message.content = Object.entries(blocks)
    .sort(([a], [b]) => Number(a) - Number(b))
    .filter(([, b]) => b.type === 'text')
    .map(([, b]) => ({ type: 'text', text: b.text, citations: null }));
  return message;
}

export interface CapturedExchange {
  url: string;
  body: Record<string, unknown>;
  status: number;
  message?: Anthropic.Message;
}

/** Wraps a fetch so every Messages exchange is captured (responses are teed, not consumed). */
export function capturingFetch(inner: typeof fetch, sink: CapturedExchange[]): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const res = await inner(input, init);
    if (!/\/v1\/messages(\?|$)/.test(url)) return res;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    const copy = res.clone();
    const text = await copy.text();
    const isSse = (res.headers.get('content-type') ?? '').includes('event-stream');
    let message: Anthropic.Message | undefined;
    if (res.ok) {
      try {
        message = isSse ? messageFromSse(text) : (JSON.parse(text) as Anthropic.Message);
      } catch {
        message = undefined;
      }
    }
    sink.push({ url, body, status: res.status, ...(message ? { message } : {}) });
    return res;
  };
}

const textOf = (m: Anthropic.Message | undefined): string | undefined =>
  m ? m.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : undefined;

export interface RunOptions {
  world: World;
  cases: readonly EvalCase[];
  fetch: typeof fetch;
  /** Stop starting new cases once this much has been spent. */
  maxUsd: number;
  apiKey?: string;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface RunOutput {
  runs: CaseRun[];
  exchanges: { case: EvalCase; exchange: CapturedExchange }[];
  stoppedAtBudget: boolean;
}

export async function runEvals(opts: RunOptions): Promise<RunOutput> {
  const sink: CapturedExchange[] = [];
  const world = structuredClone(opts.world);
  world.settings.ai = {
    ...world.settings.ai,
    budget: { sessionUsd: opts.maxUsd, monthUsd: Math.max(opts.maxUsd, 1_000) },
  };
  const client = new Anthropic({
    apiKey: opts.apiKey ?? 'eval-offline',
    baseURL: 'https://api.anthropic.com',
    fetch: capturingFetch(opts.fetch, sink),
    maxRetries: 0,
    timeout: 120_000,
  });
  const gateway = new ClaudeAiGateway({
    getWorld: () => world,
    client,
    ...(opts.now ? { now: opts.now } : {}),
  });
  const runs: CaseRun[] = [];
  const exchanges: RunOutput['exchanges'] = [];
  let stoppedAtBudget = false;
  for (const c of opts.cases) {
    if (gateway.status().paused) {
      stoppedAtBudget = true;
      opts.log?.(`budget of $${opts.maxUsd} reached: stopping before ${c.id}`);
      break;
    }
    const before = sink.length;
    const out = await gateway.run(c.moment, c.request);
    const mine = sink.slice(before);
    const last = mine.at(-1);
    for (const ex of mine) exchanges.push({ case: c, exchange: ex });
    let raw: unknown;
    const text = textOf(last?.message);
    if (text !== undefined)
      try {
        raw = JSON.parse(text);
      } catch {
        raw = undefined;
      }
    const meta = out.meta;
    runs.push({
      case: c,
      ok: out.ok,
      ...(out.ok ? {} : { error: out.error }),
      ...(raw !== undefined ? { raw } : {}),
      usage: meta?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: meta?.costUsd ?? 0,
      latencyMs: meta?.latencyMs ?? 0,
      dropped: meta?.dropped ?? 0,
      ...(last?.message?.stop_reason ? { stopReason: last.message.stop_reason } : {}),
    });
    opts.log?.(
      `${out.ok ? 'ok   ' : 'error'} ${c.id}${out.ok ? '' : ` (${out.error.code}: ${out.error.message})`} $${(meta?.costUsd ?? 0).toFixed(5)}`,
    );
  }
  return { runs, exchanges, stoppedAtBudget };
}

/** Patterns that look like Anthropic credentials; a fixture containing one is never written. */
const SECRET = /sk-ant-[A-Za-z0-9_-]{8,}/;

/** The fixture file for a recorded exchange, or null when it can't be recorded safely. */
export function toRecorded(
  c: EvalCase,
  ex: CapturedExchange,
  key?: string,
): RecordedExchange | null {
  if (!ex.message) return null;
  const rec: RecordedExchange = {
    key: requestKey(ex.body),
    moment: c.moment,
    request: ex.body as unknown as RecordedExchange['request'],
    response: ex.message,
  };
  const text = JSON.stringify(rec);
  if (SECRET.test(text) || (key && key.length >= 8 && text.includes(key))) return null;
  return rec;
}

export async function writeRecorded(
  dir: string,
  items: { case: EvalCase; exchange: CapturedExchange }[],
  key?: string,
): Promise<number> {
  await mkdir(dir, { recursive: true });
  let n = 0;
  for (const { case: c, exchange } of items) {
    const rec = toRecorded(c, exchange, key);
    if (!rec) continue;
    await writeFile(
      path.join(dir, `${c.id}-${rec.key}.json`),
      `${JSON.stringify(rec, null, 2)}\n`,
      'utf8',
    );
    n++;
  }
  return n;
}

export { MODEL };
