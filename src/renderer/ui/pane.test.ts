import { describe, expect, it } from 'vitest';
import {
  BIG_STEP,
  STEP,
  arrowDir,
  clampSize,
  collapsing,
  dragSize,
  parseSizes,
  resolveMax,
  settle,
  stepSize,
  withSize,
  type PaneLimits,
} from './pane';

// The Bench in a 1440px window: min 300, max 60%.
const bench: PaneLimits = { min: 300, max: 1440 * 0.6, collapsible: true };
const side: PaneLimits = { min: 240, max: 600, collapsible: false };

describe('pane limits', () => {
  it('clamps to min and max, rounding; a max under the min yields the min', () => {
    expect(clampSize(250, bench)).toBe(300);
    expect(clampSize(2000, bench)).toBe(864);
    expect(clampSize(400.6, bench)).toBe(401);
    expect(clampSize(500, { min: 300, max: 200 })).toBe(300);
  });

  it('resolves a max given as px, as a share of the space, or none', () => {
    expect(resolveMax(500, { window: 1440, parent: 900 })).toBe(500);
    expect(resolveMax(({ window }) => window * 0.6, { window: 1000, parent: 0 })).toBe(600);
    expect(resolveMax(({ parent }) => parent / 2, { window: 0, parent: 900 })).toBe(450);
    expect(resolveMax(undefined, { window: 1, parent: 1 })).toBe(Infinity);
  });
});

describe('dragging an edge', () => {
  it('widens toward the outside: left for a start edge, right for an end edge', () => {
    expect(dragSize(360, -100, 'start')).toBe(460);
    expect(dragSize(360, 100, 'start')).toBe(260);
    expect(dragSize(360, 100, 'end')).toBe(460);
  });

  it('settles within the limits, and far below the minimum collapses a collapsible pane', () => {
    expect(settle(460, bench)).toEqual({ size: 460, collapse: false });
    expect(settle(260, bench)).toEqual({ size: 300, collapse: false });
    expect(settle(149, bench)).toEqual({ size: 300, collapse: true });
    expect(collapsing(149, bench)).toBe(true);
    expect(collapsing(151, bench)).toBe(false);
    // A pane that can't hide stops at its minimum.
    expect(settle(10, side)).toEqual({ size: 240, collapse: false });
  });
});

describe('keyboard steps', () => {
  it('steps 16px, 64px with shift, within the limits', () => {
    expect(stepSize(360, 1, false, bench)).toEqual({ size: 360 + STEP, collapse: false });
    expect(stepSize(360, 1, true, bench)).toEqual({ size: 360 + BIG_STEP, collapse: false });
    expect(stepSize(310, -1, false, bench)).toEqual({ size: 300, collapse: false });
    expect(stepSize(860, 1, true, bench)).toEqual({ size: 864, collapse: false });
  });

  it('narrowing at the minimum hides a collapsible pane, and only that', () => {
    expect(stepSize(300, -1, false, bench)).toEqual({ size: 300, collapse: true });
    expect(stepSize(300, 1, false, bench).collapse).toBe(false);
    expect(stepSize(240, -1, true, side)).toEqual({ size: 240, collapse: false });
  });

  it('maps arrows to the edge: the arrow pointing out of the pane widens it', () => {
    expect(arrowDir('ArrowLeft', 'x', 'start')).toBe(1);
    expect(arrowDir('ArrowRight', 'x', 'start')).toBe(-1);
    expect(arrowDir('ArrowRight', 'x', 'end')).toBe(1);
    expect(arrowDir('ArrowUp', 'y', 'start')).toBe(1);
    expect(arrowDir('ArrowDown', 'y', 'start')).toBe(-1);
    expect(arrowDir('ArrowDown', 'y', 'end')).toBe(1);
    expect(arrowDir('ArrowUp', 'x', 'start')).toBe(0);
    expect(arrowDir('a', 'x', 'end')).toBe(0);
  });
});

describe('remembered sizes', () => {
  it('reads leniently: a bad entry is dropped, never the rest', () => {
    expect(parseSizes(null)).toEqual({});
    expect(parseSizes('not json')).toEqual({});
    expect(parseSizes('[1,2]')).toEqual({});
    expect(
      parseSizes(JSON.stringify({ bench: 480.4, numbers: 'wide', x: -3, y: null, z: 1e9 })),
    ).toEqual({ bench: 480 });
  });

  it('sets and forgets one size, keeping the others; unchanged is the same object', () => {
    const a = withSize({}, 'bench', 480);
    expect(a).toEqual({ bench: 480 });
    expect(withSize(a, 'bench', 480)).toBe(a);
    const b = withSize(a, 'numbers-side', 400);
    expect(b).toEqual({ bench: 480, 'numbers-side': 400 });
    expect(withSize(b, 'bench', null)).toEqual({ 'numbers-side': 400 });
    expect(withSize(a, 'nope', null)).toBe(a);
    // What's stored reads back the same.
    expect(parseSizes(JSON.stringify(b))).toEqual(b);
  });
});
