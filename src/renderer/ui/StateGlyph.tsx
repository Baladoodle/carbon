import type { ReactNode } from 'react';
import type { EntityState } from '@core/model/kinds';
import { Tooltip } from './Tooltip';

const COLOR: Record<EntityState, string> = {
  idea: 'var(--state-idea)',
  shaped: 'var(--state-shaped)',
  decided: 'var(--state-decided)',
  exported: 'var(--state-exported)',
  graveyard: 'var(--text-3)',
};

export interface StateGlyphProps {
  state: EntityState;
  /** Diameter in px (default 10). */
  size?: number;
  /** Wrap in a tooltip with the state's name (default true). Off inside dense lists that show it elsewhere. */
  tooltip?: boolean;
}

/**
 * The state as a shape, not a word (VISUAL.md §5): idea ○, shaped ◐, decided ●,
 * exported ● with a check, graveyard a dashed hollow circle. The word lives in
 * the tooltip and the accessible name.
 */
export function StateGlyph({ state, size = 10, tooltip = true }: StateGlyphProps): ReactNode {
  const c = COLOR[state];
  const r = 4;
  const svg = (
    <svg
      className="ui-state-glyph"
      width={size}
      height={size}
      viewBox="0 0 10 10"
      role="img"
      aria-label={state}
      data-state={state}
      tabIndex={tooltip ? 0 : undefined}
    >
      {state === 'idea' && <circle cx="5" cy="5" r={r} fill="none" stroke={c} strokeWidth="1.2" />}
      {state === 'shaped' && (
        <>
          <circle cx="5" cy="5" r={r} fill="none" stroke={c} strokeWidth="1.2" />
          <path d={`M5 ${5 - r} A${r} ${r} 0 0 0 5 ${5 + r} Z`} fill={c} />
        </>
      )}
      {state === 'decided' && <circle cx="5" cy="5" r={r + 0.6} fill={c} />}
      {state === 'exported' && (
        <>
          <circle cx="5" cy="5" r={r + 0.6} fill={c} />
          <path
            d="M3 5.2 L4.4 6.5 L7 3.8"
            fill="none"
            stroke="var(--bg)"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
      {state === 'graveyard' && (
        <circle
          cx="5"
          cy="5"
          r={r}
          fill="none"
          stroke={c}
          strokeWidth="1.1"
          strokeDasharray="1.6 1.4"
        />
      )}
    </svg>
  );
  return tooltip ? <Tooltip content={state}>{svg}</Tooltip> : svg;
}
