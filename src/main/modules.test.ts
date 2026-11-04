import { describe, expect, it, vi } from 'vitest';
import { defineMainModule, MAIN_MODULES, startModules, type MainContext } from './modules';

describe('main modules', () => {
  it('starts modules in order and stops them in reverse, surviving failures', async () => {
    const log: string[] = [];
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ctx = {} as MainContext;
    const stop = await startModules(ctx, [
      defineMainModule({ name: 'a', start: () => () => void log.push('stop a') }),
      defineMainModule({
        name: 'b',
        start: () => {
          throw new Error('boom');
        },
      }),
      defineMainModule({
        name: 'c',
        start: () =>
          Promise.resolve(() => {
            log.push('stop c');
            throw new Error('x');
          }),
      }),
      defineMainModule({ name: 'd', start: () => void log.push('start d') }),
    ]);
    await stop();
    expect(log).toEqual(['start d', 'stop c', 'stop a']);
    expect(err).toHaveBeenCalledTimes(2);
    expect(Array.isArray(MAIN_MODULES)).toBe(true);
  });
});
