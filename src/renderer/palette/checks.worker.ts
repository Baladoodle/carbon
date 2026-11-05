/// <reference lib="webworker" />
import { createNumbersAdapter } from '@core/checks/numbers';
import { resolvedPlaces } from '@core/checks/placement';
import { createCheckRunner } from '@core/checks/runner';
import { checkWorker, type ToWorker } from './check-feed';

/**
 * The mechanical checks off the renderer's main thread (docs/SYSTEM.md §7):
 * the incremental runner over a world kept up to date by patches
 * (check-feed.ts). Its first run on a large world takes a few hundred ms and
 * each change a few; neither blocks a frame here.
 */
const handle = checkWorker(
  createCheckRunner({ placement: resolvedPlaces, numbers: createNumbersAdapter() }),
);
self.onmessage = (e: MessageEvent<ToWorker>) => {
  const out = handle(e.data);
  if (out) self.postMessage(out);
};
