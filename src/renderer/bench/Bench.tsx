import type { ReactNode } from 'react';
import { schemaOf } from '@core/model/world';
import { useUi } from '../state/ui';
import { useEntity, useWorld } from '../state/world';
import { StateGlyph } from '../ui';

const show = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

/**
 * The Bench (package W1 replaces this): the entity in focus, read-only. With
 * nothing in focus it shows nothing (VISUAL.md §1).
 */
export function Bench(): ReactNode {
  const focus = useUi((s) => s.focus);
  const entity = useEntity(focus);
  const kind = useWorld((w) => (entity ? schemaOf(w).kinds[entity.kind] : undefined));
  if (!entity || !kind) return <div data-testid="bench-empty" />;
  return (
    <div className="bench-stub" data-testid="bench-entity" data-entity={entity.id}>
      <div className="bench-head">
        <StateGlyph state={entity.state} size={12} />
        <span className="t-2 t-meta">{kind.label}</span>
      </div>
      <h2 className="bench-title">{entity.name}</h2>
      {entity.identity && <p className="bench-identity">{entity.identity}</p>}
      <dl className="bench-fields">
        {kind.fields.map((f) =>
          entity.fields[f.key] === undefined ? null : (
            <div key={f.key} className="bench-field">
              <dt className="section-label">{f.label}</dt>
              <dd>{show(entity.fields[f.key])}</dd>
            </div>
          ),
        )}
      </dl>
    </div>
  );
}
