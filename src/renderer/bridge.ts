import {
  EVENTS,
  INVOKE,
  type EventChannel,
  type EventPayload,
  type InvokeChannel,
  type InvokeRequest,
  type InvokeResponse,
} from '@shared/ipc';

/**
 * Typed, validated access to the main process. Every response and event is
 * parsed with its zod schema from src/shared/ipc.ts before the UI sees it.
 */
export async function invoke<C extends InvokeChannel>(
  channel: C,
  request: InvokeRequest<C>,
): Promise<InvokeResponse<C>> {
  const raw: unknown = await window.carbon.invoke(channel, request);
  return INVOKE[channel].response.parse(raw) as InvokeResponse<C>;
}

export function on<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void,
): () => void {
  return window.carbon.on(channel, (raw: unknown) => {
    const parsed = EVENTS[channel].safeParse(raw);
    if (parsed.success) listener(parsed.data as EventPayload<C>);
    else console.error(`carbon: invalid ${channel} event`, parsed.error);
  });
}
