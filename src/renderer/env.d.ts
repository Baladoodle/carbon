import type { CarbonBridge } from '@shared/ipc';

declare global {
  interface Window {
    /** The typed IPC bridge from src/preload (see src/shared/ipc.ts). */
    carbon: CarbonBridge;
  }
}

export {};
