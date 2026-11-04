import type { ReactNode } from 'react';

/** The Column's own icons, drawn like the kit's (16px, 1.5px strokes, currentColor). */
export const IconLanes = (): ReactNode => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M3 2.5v11M8 2.5v11M13 2.5v11" />
  </svg>
);
