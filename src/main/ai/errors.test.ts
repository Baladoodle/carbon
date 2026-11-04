import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { sampleWorld } from '@core/testing/sample';
import { ResultCache } from './cache';
import { backoffMs, classifyError, DEFAULT_RETRY, retryAfterMs } from './errors';
import { aiSettings, costOf, DEFAULT_PRICING, MODEL, priceFor } from './settings';

const headers = (h: Record<string, string> = {}): Headers => new Headers(h);
const apiError = (status: number, h: Record<string, string> = {}) =>
  Anthropic.APIError.generate(
    status,
    { type: 'error', error: { type: 'x', message: `m${status}` } },
    `m${status}`,
    headers(h),
  );

describe('classifyError (typed, most specific first)', () => {
  it.each([
    [400, 'bad_request', false],
    [401, 'no_key', false],
    [403, 'no_key', false],
    [404, 'bad_request', false],
    [409, 'server', true],
    [413, 'too_large', false],
    [422, 'bad_request', false],
    [429, 'rate_limited', true],
    [500, 'server', true],
    [529, 'server', true],
    [418, 'unknown', false],
  ])('HTTP %i → %s (retryable %s)', (status, code, retryable) => {
    expect(classifyError(apiError(status), false)).toMatchObject({ code, retryable });
  });

  it('connection failures, timeouts, aborts and unknown throwables', () => {
    expect(classifyError(new Anthropic.APIConnectionError({ message: 'x' }), false)).toMatchObject({
      code: 'network',
      retryable: true,
    });
    expect(classifyError(new Anthropic.APIConnectionTimeoutError(), false)).toMatchObject({
      code: 'network',
      retryable: true,
    });
    expect(classifyError(new Anthropic.APIUserAbortError(), false)).toMatchObject({
      code: 'cancelled',
    });
    expect(classifyError(new Error('boom'), true)).toMatchObject({ code: 'cancelled' });
    expect(classifyError(new Error('boom'), false)).toMatchObject({
      code: 'unknown',
      message: 'boom',
    });
    expect(classifyError('?', false)).toMatchObject({ code: 'unknown' });
  });

  it('reads retry-after and backs off exponentially with jitter, capped', () => {
    expect(retryAfterMs(apiError(429, { 'retry-after': '3' }))).toBe(3000);
    expect(retryAfterMs(apiError(429, { 'retry-after': '999' }))).toBe(60_000);
    expect(retryAfterMs(apiError(429, { 'retry-after': 'soon' }))).toBeUndefined();
    expect(retryAfterMs(apiError(429))).toBeUndefined();
    expect(retryAfterMs(new Error('x'))).toBeUndefined();
    expect([0, 1, 2, 3, 10].map((a) => backoffMs(DEFAULT_RETRY, a, () => 1))).toEqual([
      500, 1000, 2000, 4000, 8000,
    ]);
    expect(backoffMs(DEFAULT_RETRY, 0, () => 0)).toBe(250);
    expect(backoffMs(DEFAULT_RETRY, 0, () => 0, 1234)).toBe(1234);
  });
});

describe('settings and pricing', () => {
  it('defaults everything, honours overrides, and falls back on invalid settings', () => {
    const w = sampleWorld();
    expect(aiSettings(w.settings)).toMatchObject({
      budget: { sessionUsd: 2, monthUsd: 20 },
      packBudget: 60_000,
      debug: false,
    });
    w.settings.ai = {
      budget: { sessionUsd: 1, monthUsd: 5 },
      effort: { spread: 'high' },
      pricing: { [MODEL]: { outputPerMTok: 1 } },
    };
    const s = aiSettings(w.settings);
    expect(s.effort.spread).toBe('high');
    expect(priceFor(s, MODEL)).toMatchObject({ inputPerMTok: 0.1, outputPerMTok: 1 });
    expect(priceFor(s, 'other-model')).toEqual(DEFAULT_PRICING[MODEL]);
    w.settings.ai = { budget: { sessionUsd: -1, monthUsd: 20 } };
    expect(aiSettings(w.settings).budget.sessionUsd).toBe(2);
  });

  it('costs usage at Haiku 5.5 prices, 5× above 100k input tokens', () => {
    const p = DEFAULT_PRICING[MODEL]!;
    expect(
      costOf(
        { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
        { ...p, longContextThreshold: 2_000_000 },
      ),
    ).toBeCloseTo(0.1, 10);
    expect(costOf({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, p)).toBeCloseTo(
      0.5,
      10,
    );
    expect(
      costOf({ input: 10_000, output: 1_000, cacheRead: 50_000, cacheWrite: 20_000 }, p),
    ).toBeCloseTo((10_000 * 0.1 + 1_000 * 0.5 + 50_000 * 0.01 + 20_000 * 0.125) / 1e6, 12);
    expect(costOf({ input: 60_000, output: 0, cacheRead: 41_000, cacheWrite: 0 }, p)).toBeCloseTo(
      ((60_000 * 0.1 + 41_000 * 0.01) / 1e6) * 5,
      12,
    );
  });
});

describe('ResultCache', () => {
  it('evicts the least recently used entry', () => {
    const c = new ResultCache<number>(2);
    c.set('a', 1);
    c.set('b', 2);
    expect(c.get('a')).toBe(1);
    c.set('c', 3);
    expect(c.get('b')).toBeUndefined();
    expect(c.get('a')).toBe(1);
    expect(c.size).toBe(2);
    c.clear();
    expect(c.size).toBe(0);
  });
});
