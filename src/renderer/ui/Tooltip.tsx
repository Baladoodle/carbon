import { Tooltip as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { Kbd } from './Kbd';

/** Wraps the app once (the shell does this). */
export const TooltipProvider = ({ children }: { children: ReactNode }): ReactNode => (
  <T.Provider delayDuration={400} skipDelayDuration={200}>
    {children}
  </T.Provider>
);

export interface TooltipProps {
  /** What the control does. Keep it to a few words. */
  content: ReactNode;
  /** Its key, shown as a key cap: keyboard hints live here, not on screen (VISUAL.md §1). */
  keys?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  /** One focusable element (a Button, a link …). */
  children: ReactNode;
}

export function Tooltip({ content, keys, side = 'top', children }: TooltipProps): ReactNode {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content className="ui-tooltip" side={side} sideOffset={6} collisionPadding={8}>
          {content}
          {keys && <Kbd>{keys}</Kbd>}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
