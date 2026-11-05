import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeUnhandled, watchUnhandled, type UnhandledRecord } from './unhandled';

/**
 * The listener is called directly (emitting the real process event would trip
 * Vitest's own unhandled-error handling): the e2e self-test in
 * e2e/main-errors.spec.ts covers the real thing in the built app.
 */
const last = (event: 'unhandledRejection' | 'uncaughtException') =>
  process.listeners(event as 'unhandledRejection').at(-1) as (reason: unknown) => void;

describe('watchUnhandled', () => {
  it('records each rejection to the file and the log, and stops cleanly', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'carbon-unhandled-')), 'u.jsonl');
    const logged: UnhandledRecord[] = [];
    const before = process.listenerCount('unhandledRejection');
    const stop = watchUnhandled({ file, log: (r) => logged.push(r), exceptions: true });
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1);
    last('unhandledRejection')(new Error('save failed'));
    last('uncaughtException')('thrown string');
    stop();
    expect(process.listenerCount('unhandledRejection')).toBe(before);
    const lines = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as UnhandledRecord);
    expect(lines.map((l) => [l.kind, l.message])).toEqual([
      ['unhandledRejection', 'save failed'],
      ['uncaughtException', 'thrown string'],
    ]);
    expect(logged).toHaveLength(2);
  });

  it('leaves uncaught exceptions to Electron outside tests', () => {
    const before = process.listenerCount('uncaughtException');
    const stop = watchUnhandled({ log: () => undefined });
    expect(process.listenerCount('uncaughtException')).toBe(before);
    stop();
  });

  it('describes anything thrown', () => {
    expect(describeUnhandled('unhandledRejection', { code: 1 }).message).toBe('{"code":1}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(describeUnhandled('unhandledRejection', cyclic).message).toBe('[object Object]');
    expect(describeUnhandled('unhandledRejection', undefined).message).toBe('undefined');
  });
});
