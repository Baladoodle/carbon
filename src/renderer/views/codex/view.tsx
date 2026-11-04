import type { ReactNode } from 'react';
import { focusEntity, useUi } from '../../state/ui';
import { useWorld } from '../../state/world';
import { IconCodex } from '../../ui/icons';
import { StateGlyph, Table, TBody, TD, TH, THead, TR } from '../../ui';
import { defineView } from '../define';

/** Stand-in for the Codex (package W2 replaces it): every entity; click to put it on the Bench. */
function CodexView(): ReactNode {
  const rows = useWorld((w) =>
    Object.values(w.entities).sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name),
    ),
  );
  const focus = useUi((s) => s.focus);
  return (
    <div className="view-scroll">
      <Table data-testid="codex-table">
        <THead>
          <tr>
            <TH style={{ width: 28 }} aria-label="state" />
            <TH>name</TH>
            <TH>kind</TH>
            <TH>identity</TH>
          </tr>
        </THead>
        <TBody>
          {(rows ?? []).map((e) => (
            <TR
              key={e.id}
              selected={e.id === focus}
              onClick={() => focusEntity(e.id)}
              data-entity={e.id}
            >
              <TD>
                <StateGlyph state={e.state} tooltip={false} />
              </TD>
              <TD>{e.name}</TD>
              <TD className="t-2">{e.kind}</TD>
              <TD className="t-2">{e.identity}</TD>
            </TR>
          ))}
        </TBody>
      </Table>
    </div>
  );
}

export default defineView({
  id: 'codex',
  label: 'Codex',
  key: '3',
  order: 3,
  icon: IconCodex,
  component: CodexView,
});
