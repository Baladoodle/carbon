import type { ReactNode } from 'react';
import { Placeholder } from '../../components/Placeholder';
import { focusEntity, useUi } from '../../state/ui';
import { useWorld } from '../../state/world';
import { defineView } from '../define';

/** Placeholder for the Codex (package W2): every entity, click to put it on the Bench. */
function CodexView(): ReactNode {
  const rows = useWorld((w) =>
    Object.values(w.entities).sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    ),
  );
  const focus = useUi((s) => s.focus);
  return (
    <Placeholder title="Codex" owner="W2 (world)">
      <table className="table" data-testid="codex-table">
        <thead>
          <tr>
            <th>kind</th>
            <th>name</th>
            <th>state</th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).map((e) => (
            <tr
              key={e.id}
              className={e.id === focus ? 'selected' : undefined}
              onClick={() => focusEntity(e.id)}
              data-entity={e.id}
            >
              <td className="dim">{e.kind}</td>
              <td>{e.name}</td>
              <td className={`state state-${e.state}`}>{e.state}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Placeholder>
  );
}

export default defineView({
  id: 'codex',
  label: 'Codex',
  key: '3',
  order: 3,
  glyph: '☰',
  component: CodexView,
});
