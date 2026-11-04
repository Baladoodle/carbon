import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { hashValue, seededRandom } from '@core/util/hash';
import { messageBody, replyCount, replyJson, replyStream } from './fixtures';

/**
 * Offline Claude API for the app (`CARBON_AI=replay`) and the evals' dry run:
 * the REAL gateway (packer, request shape, SDK, streaming, retries, log, cost)
 * talks to this `fetch` instead of the network.
 *
 *  1. A request recorded with `npm run eval -- --record` (see evals/) is
 *     answered with its recorded response, matched by the request's hash.
 *  2. Anything else gets a deterministic answer generated from the request's
 *     own JSON schema (`output_config.format`), seeded by the request. Usage
 *     is estimated from the request size, with prompt caching emulated: a
 *     cached prefix seen before is reported as `cache_read_input_tokens`.
 *
 * Synthesised answers are shaped right but not meaningful; invalid references
 * in them are dropped by the builders like real ones, which is the point.
 */

export interface RecordedExchange {
  /** hashValue of the request params (stream flag excluded). */
  key: string;
  moment: string;
  request: Anthropic.MessageCreateParams;
  response: Anthropic.Message;
}

export const requestKey = (body: Record<string, unknown>): string => {
  const { stream: _stream, ...rest } = body;
  return hashValue(rest);
};

export function loadRecorded(dir: string): Map<string, RecordedExchange> {
  const out = new Map<string, RecordedExchange>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files.sort()) {
    try {
      const x = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as RecordedExchange;
      out.set(x.key, x);
    } catch {
      // a broken fixture file is skipped
    }
  }
  return out;
}

type Schema = Record<string, unknown>;

const ADJ = [
  'Glass',
  'Ember',
  'Hollow',
  'Drift',
  'Lumen',
  'Ash',
  'Moss',
  'Cinder',
  'Tide',
  'Thorn',
  'Echo',
  'Salt',
  'Vesper',
  'Gloam',
];
const NOUN = [
  'Lung',
  'Coat',
  'Bell',
  'Spur',
  'Wake',
  'Thread',
  'Reed',
  'Crown',
  'Husk',
  'Shard',
  'Veil',
  'Root',
  'Knot',
  'Mantle',
];
const PHRASE = [
  'hums when danger is near',
  'trades speed for certainty',
  'remembers the last place you fell',
  'only works in the dark',
  'grows heavier the higher you climb',
  'turns heat into light',
  'asks you to come back later',
];

/** Generates a value matching a structured-outputs JSON schema. */
export function synthesize(
  schema: Schema,
  rand: () => number,
  key = '',
  counts: { array?: number } = {},
): unknown {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
  if (Array.isArray(schema.anyOf)) {
    const options = (schema.anyOf as Schema[]).filter((s) => s.type !== 'null');
    // Mostly the value, sometimes null (for optional notes and fields).
    const nullable = options.length < (schema.anyOf as Schema[]).length;
    if (nullable && key === 'note' && rand() < 0.5) return null;
    if (nullable && (key === 'ruleId' || key === 'field' || key === 'about' || key === 'updates'))
      return null;
    return synthesize(pick(options), rand, key, counts);
  }
  if (Array.isArray(schema.enum)) return pick(schema.enum as unknown[]);
  switch (schema.type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, s] of Object.entries((schema.properties ?? {}) as Record<string, Schema>))
        out[k] = synthesize(s, rand, k, counts);
      return out;
    }
    case 'array': {
      const n =
        key === 'suggestions'
          ? 3
          : key === 'candidates'
            ? (counts.array ?? 8)
            : key === 'notes'
              ? Math.floor(rand() * 2)
              : key === 'needs' || key === 'attributes'
                ? 0
                : 1 + Math.floor(rand() * 2);
      return Array.from({ length: n }, () => synthesize(schema.items as Schema, rand, key, counts));
    }
    case 'string':
      if (key === 'name' || key === 'title' || key === 'label')
        return `${pick(ADJ)} ${pick(NOUN)} ${Math.floor(rand() * 90 + 10)}`;
      if (key === 'markdown')
        return `# Draft\n\n## Summary\n\nIt ${pick(PHRASE)}.\n\n## Acceptance questions\n\n- Does it ${pick(PHRASE)}?\n`;
      if (key === 'low') return 'less';
      if (key === 'high') return 'more';
      if (key === 'target') return 'unknown-entity';
      return `It ${pick(PHRASE)}`;
    case 'number':
      return Math.round(rand() * 100) / 100;
    case 'boolean':
      return rand() < 0.15;
    default:
      return null;
  }
}

interface Block {
  text: string;
  cache_control?: unknown;
}

/** A `fetch` serving the Messages API offline (see the module comment). */
export function replayFetch(
  opts: { recorded?: Map<string, RecordedExchange>; delayMs?: number } = {},
): typeof fetch {
  const seenPrefixes = new Set<string>();
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<
      string,
      unknown
    >;
    const chars =
      JSON.stringify(body.system ?? '').length + JSON.stringify(body.messages ?? '').length;
    if (url.endsWith('/count_tokens')) return replyCount(Math.ceil(chars / 3));
    if (opts.delayMs) await sleep(opts.delayMs);
    const key = requestKey(body);
    const hit = opts.recorded?.get(key);
    if (hit) {
      const text = hit.response.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      const reply = {
        text,
        usage: {
          input_tokens: hit.response.usage.input_tokens,
          output_tokens: hit.response.usage.output_tokens,
          cache_read_input_tokens: hit.response.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: hit.response.usage.cache_creation_input_tokens ?? 0,
        },
        stop_reason: hit.response.stop_reason ?? 'end_turn',
      };
      return body.stream ? replyStream({ ...reply, chunks: 24 }) : replyJson(reply);
    }
    // Emulated prompt caching over the system blocks up to the last breakpoint.
    const system = (Array.isArray(body.system) ? body.system : []) as Block[];
    const last = system.map((b) => !!b.cache_control).lastIndexOf(true);
    const prefix = system
      .slice(0, last + 1)
      .map((b) => b.text)
      .join('');
    const prefixTokens = Math.ceil(prefix.length / 3);
    const total = Math.ceil(chars / 3);
    const prefixKey = hashValue(prefix);
    const cached = last >= 0 && seenPrefixes.has(prefixKey);
    if (last >= 0) seenPrefixes.add(prefixKey);
    const usage = {
      input_tokens: Math.max(1, total - (last >= 0 ? prefixTokens : 0)),
      output_tokens: 0,
      cache_read_input_tokens: cached ? prefixTokens : 0,
      cache_creation_input_tokens: !cached && last >= 0 ? prefixTokens : 0,
    };
    const schema: Schema = (body.output_config as { format?: { schema?: Schema } } | undefined)
      ?.format?.schema ?? { type: 'object', properties: {} };
    const ask = JSON.stringify(body.messages);
    const count = /Generate (\d+) candidates/.exec(ask);
    const value = synthesize(
      schema,
      seededRandom(key),
      '',
      count ? { array: Number(count[1]) } : {},
    );
    const text = JSON.stringify(value);
    usage.output_tokens = Math.ceil(text.length / 3) + 40;
    const reply = { text, usage, thinking: true };
    return body.stream ? replyStream({ ...reply, chunks: 24 }) : replyJson(reply);
  };
}

export { messageBody };
