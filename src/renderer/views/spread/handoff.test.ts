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
  it('reads ui.spot, and the names W1 and W2 used', () => {
    expect(handedSpot(base)).toBeNull();
    expect(handedSpot({ ...base, spot: cell })).toEqual(cell);
    expect(handedSpot({ ...base, spreadSpot: cell } as UiState)).toEqual(cell);
    expect(handedSpot({ ...base, spreadRequest: { spot: cell, seq: 3 } } as UiState)).toEqual(cell);
    expect(handedSpot({ ...base, spreadSpot: { type: 'cell' } } as UiState)).toBeNull();
  });

  it('changes its key on every request, even for the same spot', () => {
    const a = handoffKey({ ...base, spreadRequest: { spot: cell, seq: 1 } } as UiState);
    const b = handoffKey({ ...base, spreadRequest: { spot: cell, seq: 2 } } as UiState);
    expect(a).not.toBe(b);
    expect(handoffKey(base)).toBe('');
  });

  it('clears only the keys that exist', () => {
    expect(clearHandoff(base)).toEqual({ spot: null });
    expect(clearHandoff({ ...base, spreadSpot: cell, spreadRequest: null } as UiState)).toEqual({
      spot: null,
      spreadSpot: null,
      spreadRequest: null,
    });
  });
});
