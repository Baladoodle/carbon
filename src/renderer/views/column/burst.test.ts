import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Burst } from './burst';

describe('Burst', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const setup = () => {
    const sent: [string, number][] = [];
    let land: () => void = () => {};
    const b = new Burst<number>((k, v) => {
      sent.push([k, v]);
      return new Promise<void>((r) => (land = r));
    }, 500);
    return { b, sent, land: () => land() };
  };

  it('commits a burst once, after the keys go quiet, building on the draft', async () => {
    const { b, sent, land } = setup();
    b.push('a', (b.get('a') ?? 0) + 1);
    vi.advanceTimersByTime(300);
    b.push('a', (b.get('a') ?? 0) + 1);
    vi.advanceTimersByTime(300);
    b.push('a', (b.get('a') ?? 0) + 1);
    expect(sent).toEqual([]);
    expect(b.waiting).toBe(true);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([['a', 3]]);
    // The draft shows until the world has it.
    expect(b.get('a')).toBe(3);
    land();
    await vi.runAllTimersAsync();
    expect(b.get('a')).toBeUndefined();
  });

  it('keeps a newer draft that started while the last one landed', async () => {
    const { b, sent, land } = setup();
    b.push('a', 1);
    vi.advanceTimersByTime(500);
    b.push('a', 2);
    land();
    await Promise.resolve();
    await Promise.resolve();
    expect(b.get('a')).toBe(2);
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([
      ['a', 1],
      ['a', 2],
    ]);
  });

  it('commits a draft for another key first', () => {
    const { b, sent } = setup();
    b.push('a', 1);
    b.push('b', 5);
    expect(sent).toEqual([['a', 1]]);
    b.flush();
    expect(sent).toEqual([
      ['a', 1],
      ['b', 5],
    ]);
    b.flush();
    expect(sent).toHaveLength(2);
  });

  it('cancels only a draft that has not been sent, and tells subscribers', () => {
    const { b, sent } = setup();
    const seen = vi.fn();
    const off = b.subscribe(seen);
    expect(b.cancel()).toBe(false);
    b.push('a', 1);
    expect(b.current).toEqual({ key: 'a', value: 1 });
    expect(b.cancel()).toBe(true);
    expect(b.current).toBeNull();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    b.push('a', 2);
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
