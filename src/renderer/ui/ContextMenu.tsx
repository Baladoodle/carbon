import { ContextMenu as C } from 'radix-ui';
import { useState, type MouseEvent, type ReactNode } from 'react';
import { cx } from './cx';
import { Kbd } from './Kbd';
import type { MenuEntry } from './Menu';

export interface ContextMenuProps {
  /**
   * The menu for a right-click at this target, or null for none. Called on
   * every right-click, so one menu can serve a whole surface (the Column's
   * chips, the Codex's rows, the Climate plane's panels).
   */
  itemsAt: (target: Element, at: { clientX: number; clientY: number }) => MenuEntry[] | null;
  /** One element: the surface. */
  children: ReactNode;
}

/** A right-click menu of actions: the same entries and look as `Menu`. */
export function ContextMenu({ itemsAt, children }: ContextMenuProps): ReactNode {
  const [items, setItems] = useState<MenuEntry[]>([]);
  const onContextMenu = (e: MouseEvent): void => {
    const next = e.target instanceof Element ? itemsAt(e.target, e) : null;
    // Nothing to offer here: no menu (and no native one either).
    if (!next || next.length === 0) e.preventDefault();
    else setItems(next);
  };
  return (
    <C.Root modal={false}>
      <C.Trigger asChild onContextMenu={onContextMenu}>
        {children}
      </C.Trigger>
      <C.Portal>
        <C.Content className="ui-overlay ui-menu" collisionPadding={8} data-testid="context-menu">
          {items.map((it, i) =>
            it === 'separator' ? (
              <C.Separator key={`s${i}`} className="ui-menu-sep" />
            ) : (
              <C.Item
                key={i}
                className={cx('ui-menu-item', it.destructive && 'ui-menu-destructive')}
                onSelect={it.onSelect}
                {...(it.disabled ? { disabled: true } : {})}
              >
                <span>{it.label}</span>
                {it.keys && <Kbd>{it.keys}</Kbd>}
              </C.Item>
            ),
          )}
        </C.Content>
      </C.Portal>
    </C.Root>
  );
}
