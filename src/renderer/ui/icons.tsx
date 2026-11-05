import type { ReactNode, SVGProps } from 'react';

/** Carbon's small icon set: 16px, 1.5px strokes, currentColor. Add icons here as needed. */
const Svg = ({ children, ...p }: SVGProps<SVGSVGElement>): ReactNode => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...p}
  >
    {children}
  </svg>
);

export const IconColumn = (): ReactNode => (
  <Svg>
    <path d="M5.5 1.5v13M10.5 1.5v13M5.5 5h5M5.5 9h5" />
  </Svg>
);
export const IconClimate = (): ReactNode => (
  <Svg>
    <rect x="2" y="2" width="12" height="12" rx="1.5" />
    <rect x="4.5" y="6" width="5" height="4.5" rx="1" />
  </Svg>
);
export const IconCodex = (): ReactNode => (
  <Svg>
    <path d="M2.5 4h11M2.5 8h11M2.5 12h11M6 2.5v11" />
  </Svg>
);
export const IconNumbers = (): ReactNode => (
  <Svg>
    <path d="M2 13.5c3 0 4-11 7-11 2 0 3 4 5 4" />
  </Svg>
);
export const IconSpread = (): ReactNode => (
  <Svg>
    <circle cx="8" cy="8" r="1.5" />
    <circle cx="3" cy="4" r="1" />
    <circle cx="13" cy="4" r="1" />
    <circle cx="3.5" cy="12" r="1" />
    <circle cx="12.5" cy="12.5" r="1" />
  </Svg>
);
export const IconTaste = (): ReactNode => (
  <Svg>
    <path d="M8 2 13.5 8 8 14 2.5 8Z" />
  </Svg>
);
export const IconExport = (): ReactNode => (
  <Svg>
    <path d="M9 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h5M7 8h7M11.5 5.5 14 8l-2.5 2.5" />
  </Svg>
);
export const IconCheck = (): ReactNode => (
  <Svg>
    <path d="m3.5 8.5 3 3 6-7" />
  </Svg>
);
export const IconChevronDown = (): ReactNode => (
  <Svg>
    <path d="m4.5 6.5 3.5 3.5 3.5-3.5" />
  </Svg>
);
export const IconClose = (): ReactNode => (
  <Svg>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Svg>
);
export const IconPlus = (): ReactNode => (
  <Svg>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
export const IconSpark = (): ReactNode => (
  <Svg>
    <path d="M8 2v3M8 11v3M2 8h3M11 8h3M4 4l1.8 1.8M10.2 10.2 12 12M4 12l1.8-1.8M10.2 5.8 12 4" />
  </Svg>
);
/** A dashed curve with a square control point (Numbers: the intent curve). */
export const IconIntent = (): ReactNode => (
  <Svg>
    <path d="M2 13c3-1 4-6 7-7.5S12.5 4 14 3" strokeDasharray="2 2" />
    <rect x="7.5" y="4.5" width="3" height="3" />
  </Svg>
);
/** Expand a field into the large editor: two corners pulling out. */
export const IconExpand = (): ReactNode => (
  <Svg>
    <path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" />
  </Svg>
);
