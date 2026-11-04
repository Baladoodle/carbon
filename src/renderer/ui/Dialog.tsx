import { Dialog as D, VisuallyHidden } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The accessible title. Shown only when `showTitle` (most dialogs show their content, not a heading). */
  title: string;
  showTitle?: boolean;
  children: ReactNode;
  /** Buttons, right-aligned. */
  footer?: ReactNode;
  className?: string;
}

/** A modal dialog (e.g. the Why gate, a conflict prompt), with overlay depth and blur. */
export function Dialog({
  open,
  onOpenChange,
  title,
  showTitle,
  children,
  footer,
  className,
}: DialogProps): ReactNode {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="ui-scrim" />
        <D.Content
          className={cx('ui-overlay', 'ui-dialog', className)}
          aria-describedby={undefined}
        >
          {showTitle ? (
            <D.Title className="ui-dialog-title">{title}</D.Title>
          ) : (
            <VisuallyHidden.Root>
              <D.Title>{title}</D.Title>
            </VisuallyHidden.Root>
          )}
          <div className="ui-dialog-body">{children}</div>
          {footer && <div className="ui-dialog-footer">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
