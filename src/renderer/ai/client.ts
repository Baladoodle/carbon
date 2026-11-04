import type { AiGateway, AiLogEntry, AiOutcome, AiRunOptions, AiStatus } from '@core/ai/gateway';
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
let seq = 0;
let started = false;

/** Follows AI status. Called once by the shell. */
export function startAiSync(): void {
  if (started) return;
  started = true;
  on('ai:status', (s) => aiStatusStore.set(s));
  void invoke('ai:status', null).then((s) => aiStatusStore.set(s));
}

const partialListeners = new Map<string, (p: unknown) => void>();
let partialsWired = false;
function wirePartials(): void {
  if (partialsWired) return;
  partialsWired = true;
  on('ai:partial', (e) => partialListeners.get(e.requestId)?.(e.partial));
}

class IpcAiGateway implements AiGateway {
  async run<M extends Moment>(
    moment: M,
    request: MomentRequest<M>,
    options: AiRunOptions<M> = {},
  ): Promise<AiOutcome<M>> {
    wirePartials();
    const requestId = `r${Date.now().toString(36)}-${++seq}`;
    const { onPartial, signal } = options;
    if (onPartial) partialListeners.set(requestId, onPartial as (p: unknown) => void);
    const abort = (): void => void invoke('ai:cancel', { requestId });
    signal?.addEventListener('abort', abort);
    try {
      if (signal?.aborted)
        return { ok: false, error: { code: 'cancelled', message: 'cancelled', retryable: false } };
      const out = await invoke('ai:run', { requestId, moment, request });
      if (!out.ok) return out;
      const result = MOMENT_SCHEMAS[moment].result.safeParse(out.result);
      if (!result.success)
        return {
          ok: false,
          error: { code: 'invalid_output', message: result.error.message, retryable: false },
          meta: out.meta,
        };
      return { ok: true, result: result.data as MomentResult<M>, meta: out.meta };
    } finally {
      partialListeners.delete(requestId);
      signal?.removeEventListener('abort', abort);
    }
  }

  status(): AiStatus {
    return aiStatusStore.get();
  }

  onStatus(listener: (s: AiStatus) => void): () => void {
    return aiStatusStore.subscribe(() => listener(aiStatusStore.get()));
  }

  setEnabled(enabled: boolean): void {
    void invoke('ai:setEnabled', { enabled }).then((s) => aiStatusStore.set(s));
  }

  log(limit?: number): Promise<AiLogEntry[]> {
    return invoke('ai:log', limit === undefined ? {} : { limit });
  }
}

/** The AI, for every UI. */
export const ai: AiGateway = new IpcAiGateway();

export const useAiStatus = (): AiStatus => useStore(aiStatusStore, (s) => s);

/** The request a logged call sent (prompt text and params), or null if it isn't kept. */
export const aiRequest = (
  id: string,
): Promise<{ text: string; params: Record<string, unknown> } | null> =>
  invoke('ai:request', { id });
