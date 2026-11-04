import type { ReactNode } from 'react';
import { heightValue, type Height } from '@core/model/fields';
import { entitiesOfKind } from '@core/model/world';
import { Placeholder } from '../../components/Placeholder';
import { useWorld } from '../../state/world';
import { defineView } from '../define';

const fmt = (h: unknown): string =>
  h === '+inf' ? '+∞' : h === '-inf' ? '−∞' : typeof h === 'number' ? String(h) : '?';

/** Placeholder for the Column (package W1): the bands, top to bottom. */
function ColumnView(): ReactNode {
  const bands = useWorld((w) =>
    entitiesOfKind(w, 'band').sort(
      (a, b) =>
        heightValue((b.fields.y_top as Height | undefined) ?? 0) -
        heightValue((a.fields.y_top as Height | undefined) ?? 0),
    ),
  );
  return (
    <Placeholder title="Column" owner="W1 (column)">
      <ol className="plain-list" data-testid="column-bands">
        {(bands ?? []).map((b) => (
          <li key={b.id}>
            <span className="mono dim">
              {fmt(b.fields.y_bottom)} … {fmt(b.fields.y_top)}
            </span>{' '}
            {b.name}
          </li>
        ))}
      </ol>
    </Placeholder>
  );
}

export default defineView({
  id: 'column',
  label: 'Column',
  key: '1',
  order: 1,
  glyph: '║',
  component: ColumnView,
});
