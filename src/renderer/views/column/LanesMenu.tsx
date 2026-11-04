import { useState, type ReactNode } from 'react';
import { LANES, type Lane } from '@core/model/kinds';
import type { World } from '@core/model/world';
import type { Command } from '@core/commands/registry';
import { useActions, type Action } from '../../actions';
import { flash } from '../../state/ui';
import { transact } from '../../state/world';
import {
  Button,
  Dialog,
  Field,
  IconButton,
  IconCheck,
  Input,
  Menu,
  type MenuEntry,
} from '../../ui';
import { IconLanes } from './icons';
import {
  applyLayout,
  columnSettings,
  currentLayout,
  deleteLayout,
  saveLayout,
  setGraveyard,
  toggleLane,
} from './lanes';
import type { ColumnModel } from './model';
import { createStore, useStore } from '../../state/store';

const saveOpen = createStore(false);

const run = (label: string, c: Command | null): void => {
  if (!c) return;
  void transact(label, [c]).then((r) => {
    if (!r.ok) flash(r.error.message, 'error');
  });
};

const Check = ({ on }: { on: boolean }): ReactNode => (
  <span className="column-menu-check" aria-hidden="true">
    {on ? <IconCheck /> : null}
  </span>
);

/** Lanes, layouts and the graveyard switch: a menu on the Column's corner and palette actions. */
export function LanesMenu({ world, model }: { world: World; model: ColumnModel }): ReactNode {
  const s = columnSettings(world);
  const current = currentLayout(s);
  const items: MenuEntry[] = [
    ...LANES.map((l: Lane): MenuEntry => ({
      label: (
        <span className="column-menu-item">
          <Check on={s.lanes.includes(l)} />
          {model.laneLabels[l]}
        </span>
      ),
      onSelect: () =>
        run(`${s.lanes.includes(l) ? 'Hide' : 'Show'} ${model.laneLabels[l]}`, toggleLane(s, l)),
    })),
    'separator',
    {
      label: (
        <span className="column-menu-item">
          <Check on={s.graveyard} />
          Graveyard
        </span>
      ),
      onSelect: () =>
        run(
          s.graveyard ? 'Hide the graveyard' : 'Show the graveyard',
          setGraveyard(s, !s.graveyard),
        ),
    },
    ...(s.layouts.length > 0 ? (['separator'] as MenuEntry[]) : []),
    ...s.layouts.map((l): MenuEntry => ({
      label: (
        <span className="column-menu-item">
          <Check on={l.name === current} />
          {l.name}
        </span>
      ),
      onSelect: () => run(`Use layout ${l.name}`, applyLayout(s, l.name)),
    })),
    'separator',
    { label: 'Save layout…', onSelect: () => saveOpen.set(true) },
    ...(current
      ? [
          {
            label: `Delete ${current}`,
            destructive: true,
            onSelect: () => run(`Delete layout ${current}`, deleteLayout(s, current)),
          },
        ]
      : []),
  ];
  return (
    <>
      <Menu
        trigger={
          <IconButton size="sm" label="Lanes" icon={<IconLanes />} data-testid="column-lanes" />
        }
        items={items}
      />
      <SaveLayoutDialog world={world} />
    </>
  );
}

function SaveLayoutDialog({ world }: { world: World }): ReactNode {
  const open = useStore(saveOpen, (x) => x);
  const [name, setName] = useState('');
  const s = columnSettings(world);
  const trimmed = name.trim();
  const replaces = s.layouts.some((l) => l.name === trimmed);
  const submit = (): void => {
    if (!trimmed) return;
    run(`Save layout ${trimmed}`, saveLayout(s, trimmed));
    saveOpen.set(false);
    setName('');
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => saveOpen.set(o)}
      title="Save layout"
      showTitle
      footer={
        <>
          <Button variant="ghost" onClick={() => saveOpen.set(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!trimmed}
            onClick={submit}
            data-testid="column-layout-save"
          >
            {replaces ? 'Replace' : 'Save'}
          </Button>
        </>
      }
    >
      <Field>
        <Input
          autoFocus
          aria-label="Layout name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
          data-testid="column-layout-name"
        />
      </Field>
    </Dialog>
  );
}

/** The same choices as palette actions. */
export function useLaneActions(world: World, model: ColumnModel): void {
  const s = columnSettings(world);
  const current = currentLayout(s);
  const actions: Action[] = [
    ...LANES.map((l): Action => ({
      id: `column.lane.toggle.${l}`,
      label: `${s.lanes.includes(l) ? 'Hide' : 'Show'} the ${model.laneLabels[l]} lane`,
      group: 'Column',
      run: () =>
        run(`${s.lanes.includes(l) ? 'Hide' : 'Show'} ${model.laneLabels[l]}`, toggleLane(s, l)),
    })),
    {
      id: 'column.graveyard',
      label: s.graveyard ? 'Hide the graveyard' : 'Show the graveyard',
      group: 'Column',
      run: () =>
        run(
          s.graveyard ? 'Hide the graveyard' : 'Show the graveyard',
          setGraveyard(s, !s.graveyard),
        ),
    },
    {
      id: 'column.layout.save',
      label: 'Save layout…',
      group: 'Column',
      run: () => saveOpen.set(true),
    },
    ...s.layouts.map((l): Action => ({
      id: `column.layout.use.${l.name}`,
      label: `Use layout ${l.name}`,
      group: 'Column',
      run: () => run(`Use layout ${l.name}`, applyLayout(s, l.name)),
    })),
    ...(current
      ? [
          {
            id: 'column.layout.delete',
            label: `Delete layout ${current}`,
            group: 'Column',
            run: () => run(`Delete layout ${current}`, deleteLayout(s, current)),
          },
        ]
      : []),
  ];
  useActions(actions);
}
