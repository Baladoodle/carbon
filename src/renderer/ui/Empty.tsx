import type { ReactNode } from 'react';
import { cx } from './cx';

/**
 * The one empty state (docs/VISUAL.md §7): what's missing and the one key that
 * fixes it, centred in the region the missing content would fill. The inner
 * span keeps the sentence one line of text around its key caps.
 */
export function Empty({
  children,
  className,
  ...rest
}: {
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
}): ReactNode {
  return (
    <div className={cx('ui-empty', className)} {...rest}>
      <span>{children}</span>
    </div>
  );
}
