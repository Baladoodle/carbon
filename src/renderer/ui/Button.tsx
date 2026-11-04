import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';
import { Tooltip } from './Tooltip';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

/** primary = accent fill; secondary = surface + hairline; ghost; destructive. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ui-btn', `ui-btn-${variant}`, `ui-btn-${size}`, className)}
      {...rest}
    />
  );
});

export interface IconButtonProps extends Omit<ButtonProps, 'children'> {
  /** Required: shown as the tooltip and used as the accessible name. */
  label: string;
  /** Its key, shown in the tooltip. */
  keys?: string;
  icon: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** Marks it as the current choice (e.g. the active view). */
  active?: boolean;
}

/** An icon-only button. It always has a tooltip (VISUAL.md §5). */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, keys, icon, side, active, variant = 'ghost', size = 'md', className, ...rest },
  ref,
) {
  return (
    <Tooltip content={label} {...(keys ? { keys } : {})} {...(side ? { side } : {})}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        data-active={active ? '' : undefined}
        className={cx('ui-btn', 'ui-icon-btn', `ui-btn-${variant}`, `ui-btn-${size}`, className)}
        {...rest}
      >
        {icon}
      </button>
    </Tooltip>
  );
});
