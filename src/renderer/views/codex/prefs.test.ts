import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  clampWidth,
  cycleSort,
  EMPTY_PREFS,
  MAX_COL_W,
  MIN_COL_W,
  parsePrefs,
  withWidth,
  type Prefs,
} from './prefs';

describe('codex prefs', () => {
  it('round-trips through storage', () => {
    let p: Prefs = { ...EMPTY_PREFS, tab: 'item', query: 'state:idea' };
    p = cycleSort(p, 'item', 'f:rarity');
    p = withWidth(p, 'item', 'name', 260);
    p = withWidth(p, 'all', 'identity', 5000);
    expect(parsePrefs(JSON.stringify(p))).toEqual({
      tab: 'item',
      query: 'state:idea',
      sort: { item: { col: 'f:rarity', dir: 'asc' } },
      widths: { item: { name: 260 }, all: { identity: MAX_COL_W } },
    });
  });

  it('cycles a column ascending, descending, off, per tab', () => {
    let p = cycleSort(EMPTY_PREFS, 'band', 'name');
    expect(p.sort.band).toEqual({ col: 'name', dir: 'asc' });
    p = cycleSort(p, 'item', 'name');
    p = cycleSort(p, 'band', 'name');
    expect(p.sort.band).toEqual({ col: 'name', dir: 'desc' });
    p = cycleSort(p, 'band', 'name');
    expect(p.sort.band).toBeUndefined();
    expect(p.sort.item).toEqual({ col: 'name', dir: 'asc' });
    expect(cycleSort(p, 'item', 'identity').sort.item).toEqual({ col: 'identity', dir: 'asc' });
  });

  it('resets a width to the default', () => {
    const p = withWidth(withWidth(EMPTY_PREFS, 'all', 'name', 300), 'all', 'name', null);
    expect(p.widths.all).toEqual({});
    expect(clampWidth(1)).toBe(MIN_COL_W);
  });

  it('never throws on junk and keeps what is good (property)', () => {
    expect(parsePrefs(null)).toEqual(EMPTY_PREFS);
    expect(parsePrefs('{')).toEqual(EMPTY_PREFS);
    expect(
      parsePrefs(
        JSON.stringify({
          tab: 'nope',
          sort: { item: { col: 'name', dir: 'up' }, band: { col: 'name', dir: 'desc' }, x: {} },
          widths: { item: { name: 'wide', identity: 120 }, nope: { name: 100 } },
        }),
      ),
    ).toEqual({
      tab: 'all',
      query: '',
      sort: { band: { col: 'name', dir: 'desc' } },
      widths: { item: { identity: 120 } },
    });
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const p = parsePrefs(JSON.stringify(v));
        for (const ws of Object.values(p.widths))
          for (const w of Object.values(ws)) expect(w >= MIN_COL_W && w <= MAX_COL_W).toBe(true);
      }),
    );
  });
});
