import { describe, expect, it } from 'vitest';
import type { UiState } from '../../state/ui';
import { clearHandoff, handedSpot, handoffKey } from './handoff';

const base: UiState = {
  view: 'spread',
  benchOpen: true,
  focus: null,
  selection: [],
  overlay: null,
  spot: null,
};
const cell = { type: 'cell', band: 'low-sky', lane: 'items' } as const;

describe('the spread hand-off', () => {
  it('reads ui.spot and ignores a malformed one', () => {
    expect(handedSpot(base)).toBeNull();
    expect(handedSpot({ ...base, spot: cell })).toEqual(cell);
    expect(handedSpot({ ...base, spot: { type: 'cell' } } as unknown as UiState)).toBeNull();
  });

  it('keys each spot', () => {
    expect(handoffKey(base)).toBe('');
    expect(handoffKey({ ...base, spot: cell })).not.toBe(
      handoffKey({ ...base, spot: { ...cell, lane: 'feats' } }),
    );
  });

  it('clears the spot', () => {
    expect(clearHandoff()).toEqual({ spot: null });
  });
});
