import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Who a main-process call is for. The agent socket runs each tool call inside
 * `asAgent`, so the gateways can log `via: 'agent'` (docs/MCP.md §6) without
 * every method growing a parameter. Async context follows awaits, timers and
 * promises started inside the call.
 */
const store = new AsyncLocalStorage<'agent'>();

export const asAgent = <T>(fn: () => Promise<T>): Promise<T> => store.run('agent', fn);

/** `'agent'` inside an agent's tool call, else undefined. */
export const currentVia = (): 'agent' | undefined => store.getStore();
