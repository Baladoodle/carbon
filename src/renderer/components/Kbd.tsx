import type { ReactNode } from 'react';

/** A key cap: `<Kbd>ctrl+k</Kbd>`. */
export const Kbd = ({ children }: { children: ReactNode }): ReactNode => (
  <kbd className="kbd">{children}</kbd>
);
