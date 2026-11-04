import { describe, expect, it } from 'vitest';
import { totals } from './AiLog';

describe('AI log totals', () => {
  it('sums cost and cache reads over real calls; cached hits cost nothing', () => {
    const meta = (cost: number, input: number, read: number, cached = false) => ({
      moment: 'critique' as const,
      requestHash: 'h',
      model: 'm',
      usage: { input, output: 10, cacheRead: read, cacheWrite: 0 },
      costUsd: cost,
      latencyMs: 1,
      cached,
      dropped: 0,
    });
    const t = totals([
      { id: '1', at: 'x', moment: 'critique', outcome: 'ok', meta: meta(0.002, 1000, 3000) },
      { id: '2', at: 'x', moment: 'critique', outcome: 'cached', meta: meta(0, 0, 0, true) },
      {
        id: '3',
        at: 'x',
        moment: 'critique',
        outcome: 'error',
        error: { code: 'disabled', message: 'off', retryable: false },
      },
    ]);
    expect(t).toEqual({ calls: 1, costUsd: 0.002, cacheRate: 0.75, cached: 1 });
    expect(totals([])).toEqual({ calls: 0, costUsd: 0, cacheRate: 0, cached: 0 });
  });
});
