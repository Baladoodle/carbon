import type { ReactNode } from 'react';

/** A key cap, e.g. `<Kbd>ctrl+k</Kbd>`. Only inside tooltips, the palette and help (VISUAL.md §1). */
export const Kbd = ({ children }: { children: ReactNode }): ReactNode => (
  <kbd className="ui-kbd">{children}</kbd>
);
