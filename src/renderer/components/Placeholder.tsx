import type { ReactNode } from 'react';

/** A clear "not built yet" panel for views a package will fill in. */
export function Placeholder({
  title,
  owner,
  children,
}: {
  title: string;
  owner: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="placeholder">
      <h1>{title}</h1>
      <p className="dim">Coming in package {owner}.</p>
      {children}
    </div>
  );
}
