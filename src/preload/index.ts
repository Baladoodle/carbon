import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, wire, type CarbonBridge } from '@shared/ipc';

/**
 * The only door between the renderer and the main process: `window.carbon`.
 * Channels are allow-listed from src/shared/ipc.ts; requests are validated in
 * the main process, so the preload stays a thin, typed bridge.
 */
const invokeAllowed = new Set<string>(INVOKE_CHANNELS);
const eventAllowed = new Set<string>(EVENT_CHANNELS);

const bridge: CarbonBridge = {
  invoke(channel, request) {
    if (!invokeAllowed.has(channel)) return Promise.reject(new Error(`unknown channel ${channel}`));
    return ipcRenderer.invoke(wire(channel), request) as Promise<never>;
  },
  on(channel, listener) {
    if (!eventAllowed.has(channel)) throw new Error(`unknown event ${channel}`);
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload as never);
    ipcRenderer.on(wire(channel), wrapped);
    return () => {
      ipcRenderer.removeListener(wire(channel), wrapped);
    };
  },
};

contextBridge.exposeInMainWorld('carbon', bridge);
