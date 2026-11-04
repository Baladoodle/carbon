import { DropdownMenu as M } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from './cx';
import { Kbd } from './Kbd';

export type MenuEntry =
  | {
      label: ReactNode;
      onSelect: () => void;
      keys?: string;
      destructive?: boolean;
      disabled?: boolean;
    }
  | 'separator';

export interface MenuProps {
  trigger: ReactNode;
  items: MenuEntry[];
  align?: 'start' | 'center' | 'end';
}

/** A dropdown menu of actions. Keys appear here (they are allowed in menus). */
export function Menu({ trigger, items, align = 'start' }: MenuProps): ReactNode {
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal>
        <M.Content className="ui-overlay ui-menu" align={align} sideOffset={4} collisionPadding={8}>
          {items.map((it, i) =>
            it === 'separator' ? (
              <M.Separator key={`s${i}`} className="ui-menu-sep" />
            ) : (
              <M.Item
                key={i}
                className={cx('ui-menu-item', it.destructive && 'ui-menu-destructive')}
                onSelect={it.onSelect}
                {...(it.disabled ? { disabled: true } : {})}
              >
                <span>{it.label}</span>
                {it.keys && <Kbd>{it.keys}</Kbd>}
              </M.Item>
            ),
          )}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}
