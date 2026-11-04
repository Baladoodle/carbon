import type { ReactNode } from 'react';
import { heightValue, type Height } from '@core/model/fields';
import { entitiesOfKind } from '@core/model/world';
import { useWorld } from '../../state/world';
import { depthTint } from '../../ui/tokens';
import { IconColumn } from '../../ui/icons';
import { defineView } from '../define';

const fmt = (h: unknown): string =>
  h === '+inf' ? '+∞' : h === '-inf' ? '−∞' : typeof h === 'number' ? String(h) : '';
const top = (f: Record<string, unknown>): number =>
  heightValue((f.y_top as Height | undefined) ?? 0);
const mid = (f: Record<string, unknown>): number => {
  const a = heightValue((f.y_bottom as Height | undefined) ?? 0);
  const b = heightValue((f.y_top as Height | undefined) ?? 0);
  if (Number.isFinite(a) && Number.isFinite(b)) return (a + b) / 2;
  return Number.isFinite(a) ? a + 1000 : b - 1000;
};

/** Stand-in for the Column (package W1 replaces it): the bands, top to bottom, with the depth tint. */
function ColumnView(): ReactNode {
  const bands = useWorld((w) =>
    entitiesOfKind(w, 'band').sort((a, b) => top(b.fields) - top(a.fields)),
  );
  return (
    <ol className="column-stub" data-testid="column-bands">
      {(bands ?? []).map((b) => (
        <li key={b.id} style={{ background: depthTint(mid(b.fields)) }}>
          <span className="num t-3">
            {fmt(b.fields.y_bottom)} … {fmt(b.fields.y_top)}
          </span>
          <span>{b.name}</span>
        </li>
      ))}
    </ol>
  );
}

export default defineView({
  id: 'column',
  label: 'Column',
  key: '1',
  order: 1,
  icon: IconColumn,
  component: ColumnView,
});
