import { Tabs as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface TabsProps {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: ReactNode; count?: number }[];
  /** Content for the active tab (render it yourself; the kit only draws the strip). */
  children?: ReactNode;
  className?: string;
  'aria-label'?: string;
}

/** A tab strip with an accent underline (not pills). E.g. the Codex's kind tabs. */
export function Tabs({
  value,
  onValueChange,
  tabs,
  children,
  className,
  ...aria
}: TabsProps): ReactNode {
  return (
    <T.Root value={value} onValueChange={onValueChange} className={cx('ui-tabs', className)}>
      <T.List className="ui-tabs-list" {...aria}>
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
