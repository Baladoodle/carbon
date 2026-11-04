import type { ReactNode } from 'react';
import { schemaOf } from '@core/model/world';
import { useUi } from '../state/ui';
import { useEntity, useWorld } from '../state/world';

/**
 * The Bench (package W1 replaces this): the entity in focus. This stub shows
 * it read-only so the shell and the end-to-end harness have something real.
 */
export function Bench(): ReactNode {
  const focus = useUi((s) => s.focus);
  const entity = useEntity(focus);
  const kind = useWorld((w) => (entity ? schemaOf(w).kinds[entity.kind] : undefined));
  if (!entity || !kind)
    return (
      <div className="bench-empty dim" data-testid="bench-empty">
        Nothing on the Bench. Select an entity.
      </div>
    );
  return (
    <div className="bench-stub" data-testid="bench-entity" data-entity={entity.id}>
      <div className="dim small">
        {kind.label} · <span className={`state state-${entity.state}`}>{entity.state}</span>
      </div>
      <h2>{entity.name}</h2>
      {entity.identity && <p className="identity">{entity.identity}</p>}
      <dl>
        {kind.fields.map((f) =>
          entity.fields[f.key] === undefined ? null : (
            <div key={f.key} className="field-row">
              <dt className="dim">{f.label}</dt>
              <dd>
                {typeof entity.fields[f.key] === 'string'
                  ? (entity.fields[f.key] as string)
                  : JSON.stringify(entity.fields[f.key])}
              </dd>
            </div>
          ),
        )}
      </dl>
    </div>
  );
}
