import { Tabs as T } from 'radix-ui';
import type { ReactNode, RefObject } from 'react';
import { cx } from './cx';

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: ReactNode; count?: number }[];
  /** Content for the active tab (render it yourself; the kit only draws the strip). */
  children?: ReactNode;
  className?: string;
  'aria-label'?: string;
  /**
   * Where a pointer click on a tab hands focus: the surface the tabs switch (a plane, a
   * table). Without it the strip lets go of focus, so the app's keys apply again.
   */
  focusAfterClick?: RefObject<HTMLElement | null>;
}

/**
 * A tab strip with an accent underline (not pills). E.g. the Codex's kind tabs.
 *
 * A click on a tab, even the current one, never leaves focus in the strip: there the
 * arrow keys would switch tabs instead of reaching the view. The keyboard still walks
 * the strip (tab into it, arrows between tabs).
 */
export function Tabs({
  value,
  onValueChange,
  tabs,
  children,
  className,
  focusAfterClick,
  ...aria
}: TabsProps): ReactNode {
  return (
    <T.Root value={value} onValueChange={onValueChange} className={cx('ui-tabs', className)}>
      <T.List
        className="ui-tabs-list"
        {...aria}
        onPointerUp={(e) => {
          // At once, not on a later frame: by then something else (the palette, opened
          // right after the click) may have focus, and taking it would swallow its keys.
          const active = document.activeElement;
          if (!(active instanceof HTMLElement) || !e.currentTarget.contains(active)) return;
          const target = focusAfterClick?.current;
          if (target) target.focus();
          else active.blur();
        }}
      >
        {tabs.map((t) => (
          <T.Trigger key={t.value} value={t.value} className="ui-tab">
            {t.label}
            {t.count !== undefined && <span className="ui-tab-count num">{t.count}</span>}
          </T.Trigger>
        ))}
      </T.List>
      {children !== undefined && (
        <T.Content value={value} className="ui-tabs-content" tabIndex={-1}>
          {children}
        </T.Content>
      )}
    </T.Root>
  );
}
