import Anthropic from '@anthropic-ai/sdk';

/**
 * SDK-shaped HTTP fixtures. Tests run the real `@anthropic-ai/sdk` client
 * against a fake `fetch` that answers with Messages API JSON bodies, SSE
 * streams or error responses, so the gateway's whole path (SDK parsing, typed
 * errors, streaming events) is exercised offline. Recorded fixtures
 * (`evals/fixtures/recorded/*.json`) are replayed the same way.
 */

export interface FixtureUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export type StopReason = Anthropic.StopReason;

export interface FixtureReply {
  /** The JSON text the model "wrote" (usually `JSON.stringify(result)`). */
  text: string;
  usage?: FixtureUsage;
  stop_reason?: StopReason;
  /** Add an (empty, like the API's default "omitted" display) thinking block first. */
  thinking?: boolean;
  /** For streams: split the text into this many deltas. */
  chunks?: number;
}

const DEFAULT_USAGE: FixtureUsage = {
  input_tokens: 1200,
  output_tokens: 300,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

let messageSeq = 0;

export function messageBody(r: FixtureReply, model = 'claude-haiku-5-5'): Anthropic.Message {
  const usage = { ...DEFAULT_USAGE, ...r.usage };
  return {
    id: `msg_fixture_${++messageSeq}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [
      ...(r.thinking ? [{ type: 'thinking' as const, thinking: '', signature: 'sig' }] : []),
      { type: 'text' as const, text: r.text, citations: null },
    ],
    stop_reason: r.stop_reason ?? 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: {
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
    },
  } as unknown as Anthropic.Message;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_fixture', ...headers },
  });

export const replyJson = (r: FixtureReply): Response => json(messageBody(r));

/** An SSE stream of the Messages API events for `r`. */
export function replyStream(r: FixtureReply): Response {
  const m = messageBody(r);
  const n = Math.max(1, r.chunks ?? 6);
  const size = Math.ceil(r.text.length / n);
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: { ...m, content: [], stop_reason: null, usage: { ...m.usage, output_tokens: 1 } },
      },
    ],
  ];
  let index = 0;
  if (r.thinking) {
    events.push([
      'content_block_start',
      {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      },
    ]);
    events.push([
      'content_block_delta',
      { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: 'sig' } },
    ]);
    events.push(['content_block_stop', { type: 'content_block_stop', index }]);
    index++;
  }
  events.push([
    'content_block_start',
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'text', text: '', citations: null },
    },
  ]);
  for (let i = 0; i < r.text.length; i += size)
    events.push([
      'content_block_delta',
      {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: r.text.slice(i, i + size) },
      },
    ]);
  events.push(['content_block_stop', { type: 'content_block_stop', index }]);
  events.push([
    'message_delta',
    {
      type: 'message_delta',
      delta: { stop_reason: m.stop_reason, stop_sequence: null, stop_details: null },
      usage: {
        output_tokens: m.usage.output_tokens,
        input_tokens: m.usage.input_tokens,
        cache_read_input_tokens: m.usage.cache_read_input_tokens,
        cache_creation_input_tokens: m.usage.cache_creation_input_tokens,
      },
    },
  ]);
  events.push(['message_stop', { type: 'message_stop' }]);
  const body = events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' },
  });
}

/** An API error response with the API's error body. */
export function replyError(
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ type: 'error', error: { type, message } }, status, headers);
}

export const replyCount = (input_tokens: number): Response => json({ input_tokens });

/** A recorded HTTP exchange: what was sent and what came back. */
export interface Exchange {
  url: string;
  method: string;
  body: unknown;
}

export type Responder =
  Response | Error | ((ex: Exchange) => Response | Error | Promise<Response | Error>);

/**
 * A `fetch` that answers from a queue of responders and records every request.
 * A responder that is an Error makes the fetch throw (a connection failure).
 */
export class FixtureFetch {
  readonly requests: Exchange[] = [];
  private readonly queue: Responder[] = [];

  constructor(responders: Responder[] = []) {
    this.queue.push(...responders);
  }

  push(...r: Responder[]): this {
    this.queue.push(...r);
    return this;
  }

  /** Requests to the Messages endpoint (not count_tokens). */
  get messages(): Exchange[] {
    return this.requests.filter((r) => /\/v1\/messages(\?|$)/.test(r.url));
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const raw = typeof init?.body === 'string' ? init.body : '';
    const ex: Exchange = {
      url,
      method: init?.method ?? 'GET',
      body: raw ? (JSON.parse(raw) as unknown) : null,
    };
    this.requests.push(ex);
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const next = this.queue.shift();
    if (!next) throw new Error(`FixtureFetch: no response queued for ${ex.method} ${url}`);
    const pending = Promise.resolve(typeof next === 'function' ? next(ex) : next);
    // Like a real fetch, an abort rejects even while the response is pending.
    const r = signal
      ? await Promise.race([
          pending,
          new Promise<never>((_, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            ),
          ),
        ])
      : await pending;
    if (r instanceof Error) throw r;
    return r;
  };
}

/** A real SDK client over a fixture fetch. */
export function fixtureClient(f: FixtureFetch): Anthropic {
  return new Anthropic({
    apiKey: 'test-key-not-real',
    baseURL: 'https://api.anthropic.com',
    fetch: f.fetch,
    maxRetries: 0,
  });
}
