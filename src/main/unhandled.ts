import { appendFileSync } from 'node:fs';

/**
 * Unhandled promise rejections and uncaught exceptions in the main process.
 * Each one is a bug: a promise nobody waits for failed, so whatever it was
 * doing (a save, a snapshot, a watcher scan) failed silently.
 *
 * They are always logged. Under e2e (`file` set), each is also appended to a
 * JSON-lines file in the run's userData, and the e2e harness fails the test
 * whose app wrote any (e2e/harness.ts, `close()`).
 */
export interface UnhandledRecord {
  kind: 'unhandledRejection' | 'uncaughtException';
  message: string;
  stack?: string;
}

/** The file the e2e harness reads, inside the run's userData. */
export const UNHANDLED_FILE = 'unhandled.jsonl';

/** JSON.stringify, typed as it behaves: undefined for undefined (and functions). */
const json = (v: unknown): string | undefined => JSON.stringify(v);

export function describeUnhandled(kind: UnhandledRecord['kind'], reason: unknown): UnhandledRecord {
  if (reason instanceof Error)
    return { kind, message: reason.message, ...(reason.stack ? { stack: reason.stack } : {}) };
  let message: string | undefined;
  try {
    message = typeof reason === 'string' ? reason : json(reason);
  } catch {
    message = String(reason);
  }
  return { kind, message: message ?? String(reason) };
}

export interface WatchOptions {
  /** Where to append records (e2e). */
  file?: string;
  log?: (record: UnhandledRecord) => void;
  /**
   * Also catch uncaught exceptions (e2e). Outside tests Electron's own
   * handling (a dialog, then the crash) is kept.
   */
  exceptions?: boolean;
}

/** Starts watching; returns a function that stops. */
export function watchUnhandled(opts: WatchOptions = {}): () => void {
  const log = opts.log ?? ((r) => console.error(`carbon: ${r.kind}:`, r.stack ?? r.message));
  const record = (kind: UnhandledRecord['kind'], reason: unknown): void => {
    const r = describeUnhandled(kind, reason);
    log(r);
    if (opts.file) {
      try {
        appendFileSync(opts.file, `${JSON.stringify(r)}\n`);
      } catch {
        // Nowhere to write: the log above still has it.
      }
    }
  };
  const onRejection = (reason: unknown): void => record('unhandledRejection', reason);
  const onException = (error: unknown): void => record('uncaughtException', error);
  process.on('unhandledRejection', onRejection);
  if (opts.exceptions) process.on('uncaughtException', onException);
  return () => {
    process.off('unhandledRejection', onRejection);
    process.off('uncaughtException', onException);
  };
}
