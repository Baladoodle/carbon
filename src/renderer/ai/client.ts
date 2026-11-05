import type { AiGateway, AiOutcome, AiRunOptions, AiStatus } from '@core/ai/gateway';
import {
  MOMENT_SCHEMAS,
  type Moment,
  type MomentRequest,
  type MomentResult,
} from '@core/ai/moments';
import { invoke, on } from '../bridge';
import { createStore, useStore } from '../state/store';

/**
 * The renderer's `AiGateway`: the same interface as the gateway in the main
 * process, forwarded over IPC. UIs import `ai` from here and never care whether
 * the main process runs the real gateway, the fake or none.
 */
const INITIAL: AiStatus = {
  mode: 'off',
  enabled: false,
  reason: 'connecting…',
  model: 'none',
  spend: { sessionUsd: 0, monthUsd: 0 },
  budget: { sessionUsd: 0, monthUsd: 0 },
  paused: false,
  pending: 0,
};

export const aiStatusStore = createStore<AiStatus>(INITIAL);
let started = false;

/** Follows AI status. Called once by the shell. */
export function startAiSync(): void {
  if (started) return;
  started = true;
  on('ai:status', (s) => aiStatusStore.set(s));
  void invoke('ai:status', null).then((s) => aiStatusStore.set(s));
}

/** The bridge the client talks through (the real one in the app; a fake in tests). */
export interface AiBridge {
  invoke: typeof invoke;
  on: typeof on;
}

/** How long a finished run waits for partials still in transit before it fails. */
export const PARTIAL_WAIT_MS = 5_000;

/** One request's partials: delivered in `seq` order, never after it's finished. */
interface Stream {
  next: number;
  early: Map<number, unknown>;
  done: boolean;
  deliver?: ((p: unknown) => void) | undefined;
  /** Woken whenever `next` moves. */
  wake?: (() => void) | undefined;
}

/**
 * The renderer's `AiGateway` over IPC. Partials (`ai:partial`) and the run's
 * reply (`ai:run`) travel on different channels with no shared order: under
 * load a reply can arrive before the partials sent ahead of it. So partials
 * carry a `seq` and the reply the count sent; the client hands partials to
 * `onPartial` in order, resolves `run()` only after it has seen all of them
 * (waiting at most `waitMs`, then failing), and drops any partial for a
 * request that has finished or been cancelled.
 */
export function createIpcAiGateway(bridge: AiBridge, opts: { waitMs?: number } = {}): AiGateway {
  const waitMs = opts.waitMs ?? PARTIAL_WAIT_MS;
  const streams = new Map<string, Stream>();
  let wired = false;
  let seq = 0;

  const receive = (requestId: string, n: number, partial: unknown): void => {
    const st = streams.get(requestId);
    // A finished, cancelled or unknown request: dropped.
    if (!st || st.done || n < st.next || st.early.has(n)) return;
    st.early.set(n, partial);
    while (st.early.has(st.next)) {
      const p = st.early.get(st.next);
      st.early.delete(st.next);
      st.next++;
      st.deliver?.(p);
    }
    st.wake?.();
  };

  /** Resolves true once `count` partials were delivered, false after `waitMs`. */
  const allSeen = (st: Stream, count: number, signal?: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      if (st.next >= count) return resolve(true);
      const timer = setTimeout(() => finish(false), waitMs);
      const onAbort = (): void => finish(true);
      function finish(ok: boolean): void {
        clearTimeout(timer);
        st.wake = undefined;
        signal?.removeEventListener('abort', onAbort);
        resolve(ok);
      }
      st.wake = () => {
        if (st.next >= count) finish(true);
      };
      signal?.addEventListener('abort', onAbort);
    });

  return {
    async run<M extends Moment>(
      moment: M,
      request: MomentRequest<M>,
      options: AiRunOptions<M> = {},
    ): Promise<AiOutcome<M>> {
      if (!wired) {
        wired = true;
        bridge.on('ai:partial', (e) => receive(e.requestId, e.seq, e.partial));
      }
      const requestId = `r${Date.now().toString(36)}-${++seq}`;
      const { onPartial, signal } = options;
      const st: Stream = {
        next: 0,
        early: new Map(),
        done: false,
        deliver: onPartial as ((p: unknown) => void) | undefined,
      };
      streams.set(requestId, st);
      const abort = (): void => {
        // Nothing more reaches the caller once it has cancelled.
        st.done = true;
        void bridge.invoke('ai:cancel', { requestId });
      };
      signal?.addEventListener('abort', abort);
      try {
        if (signal?.aborted)
          return {
            ok: false,
            error: { code: 'cancelled', message: 'cancelled', retryable: false },
          };
        const out = await bridge.invoke('ai:run', { requestId, moment, request });
        const sent = out.partials ?? 0;
        if (!st.done && !(await allSeen(st, sent, signal)))
          return {
            ok: false,
            error: {
              code: 'server',
              message: `lost ${sent - st.next} of ${sent} streamed results in transit`,
              retryable: true,
            },
            ...(out.meta ? { meta: out.meta } : {}),
          };
        if (!out.ok)
          return { ok: false, error: out.error, ...(out.meta ? { meta: out.meta } : {}) };
        const result = MOMENT_SCHEMAS[moment].result.safeParse(out.result);
        if (!result.success)
          return {
            ok: false,
            error: { code: 'invalid_output', message: result.error.message, retryable: false },
            meta: out.meta,
          };
        return { ok: true, result: result.data as MomentResult<M>, meta: out.meta };
      } finally {
        st.done = true;
        streams.delete(requestId);
        signal?.removeEventListener('abort', abort);
      }
    },
    status: () => aiStatusStore.get(),
    onStatus: (listener) => aiStatusStore.subscribe(() => listener(aiStatusStore.get())),
    setEnabled: (enabled) =>
      void bridge.invoke('ai:setEnabled', { enabled }).then((s) => aiStatusStore.set(s)),
    log: (limit) => bridge.invoke('ai:log', limit === undefined ? {} : { limit }),
  };
}

/** The AI, for every UI. */
export const ai: AiGateway = createIpcAiGateway({ invoke, on });

export const useAiStatus = (): AiStatus => useStore(aiStatusStore, (s) => s);

/** The request a logged call sent (prompt text and params), or null if it isn't kept. */
export const aiRequest = (
  id: string,
): Promise<{ text: string; params: Record<string, unknown> } | null> =>
  invoke('ai:request', { id });
