import type { ReactNode } from 'react';
import { setUi, useUi } from '../state/ui';
import { IconButton } from '../ui';
import { VIEWS } from '../views/registry';

/** The rail: one icon per registered view; the name and key live in the tooltip. */
export function Rail(): ReactNode {
  const view = useUi((s) => s.view);
  return (
    <nav className="rail" aria-label="Views">
      <div className="rail-drag" />
      {VIEWS.map((v) => {
        const Icon = v.icon;
        return (
          <IconButton
            key={v.id}
            label={v.label}
            keys={v.key}
            side="right"
            icon={<Icon />}
            active={v.id === view}
            aria-current={v.id === view ? 'page' : undefined}
            data-testid={`rail-${v.id}`}
            onClick={() => setUi({ view: v.id })}
          />
        );
      })}
    </nav>
  );
}
