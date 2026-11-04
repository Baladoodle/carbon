import type { ReactNode } from 'react';
import { setUi, useUi } from '../state/ui';
import { VIEWS } from '../views/registry';

/** The rail: one button per registered view, keys 1–7. */
export function Rail(): ReactNode {
  const view = useUi((s) => s.view);
  return (
    <nav className="rail" aria-label="Views">
      <div className="rail-drag" />
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          className={v.id === view ? 'rail-btn active' : 'rail-btn'}
          title={`${v.label} (${v.key})`}
          aria-current={v.id === view ? 'page' : undefined}
          data-testid={`rail-${v.id}`}
          onClick={() => setUi({ view: v.id })}
        >
          <span className="rail-glyph">{v.glyph}</span>
          <span className="rail-key">{v.key}</span>
        </button>
      ))}
    </nav>
  );
}
