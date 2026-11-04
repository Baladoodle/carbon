import type { Spot } from '@core/ai/moments';
import { LANES } from '@core/model/kinds';
import { entitiesOfKind, schemaOf, type World } from '@core/model/world';
import { spotLabel } from '@core/spreads/spot';
import { useMemo, type ReactNode } from 'react';
import { Combobox, StateGlyph, type ComboboxItem } from '../../ui';

/** Every spot you can pick by name: each band's lanes (Column cells) and every entity. */
export function spotItems(world: World): { items: ComboboxItem[]; spots: Map<string, Spot> } {
  const spots = new Map<string, Spot>();
  const items: ComboboxItem[] = [];
  for (const band of entitiesOfKind(world, 'band'))
    for (const lane of LANES) {
      const spot: Spot = { type: 'cell', band: band.id, lane };
      const value = `cell:${band.id}:${lane}`;
      spots.set(value, spot);
      items.push({ value, label: spotLabel(world, spot), hint: 'cell' });
    }
  const schema = schemaOf(world);
  for (const e of Object.values(world.entities).sort((a, b) => a.name.localeCompare(b.name))) {
    const value = `entity:${e.id}`;
    spots.set(value, { type: 'entity', entity: e.id });
    items.push({
      value,
      label: e.name,
      hint: schema.kinds[e.kind].label.toLowerCase(),
      glyph: <StateGlyph state={e.state} tooltip={false} />,
    });
  }
  return { items, spots };
}

/** The spot as a searchable picker, shown in place of its label while you choose. */
export function SpotPicker({
  world,
  onPick,
  onClose,
}: {
  world: World;
  onPick: (spot: Spot) => void;
  onClose: () => void;
}): ReactNode {
  const { items, spots } = useMemo(() => spotItems(world), [world]);
  return (
    <div
      className="spread-spot-picker"
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && onClose()}
      onKeyDownCapture={(e) => {
        // One escape cancels the picker, list and all (before the list takes it).
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <Combobox
        autoFocus
        aria-label="Spot"
        items={items}
        value={null}
        onChange={(v) => {
          const spot = spots.get(v);
          if (spot) onPick(spot);
          onClose();
        }}
      />
    </div>
  );
}
