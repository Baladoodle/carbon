import { Popover as P } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface PopoverProps {
  /** One focusable element that opens it. */
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  className?: string;
}

/** Floating content anchored to a trigger, with overlay depth (VISUAL.md §4). */
export function Popover({
  trigger,
  children,
  open,
  onOpenChange,
  side = 'bottom',
  align = 'start',
  className,
}: PopoverProps): ReactNode {
  return (
    <P.Root {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          className={cx('ui-overlay', 'ui-popover', className)}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

/** The Radix parts, for layouts the wrapper doesn't cover (anchor without trigger, etc.). */
export const PopoverParts = P;
