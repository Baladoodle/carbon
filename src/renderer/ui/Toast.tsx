import { Toast as T } from 'radix-ui';
import type { ReactNode } from 'react';
import { createStore, useStore } from '../state/store';
import { cx } from './cx';

export type ToastTone = 'info' | 'error' | 'ai';

export interface ToastItem {
  id: number;
  text: string;
  tone: ToastTone;
  /** One action, e.g. Undo. */
  action?: { label: string; run: () => void };
  /** ms; default 4000 (errors 6000). */
  duration?: number;
}

const toasts = createStore<ToastItem[]>([]);
let next = 1;

/** Shows a short message. Use for results the user needs to know about (an error, an undo). */
export function toast(
  text: string,
  opts: { tone?: ToastTone; action?: ToastItem['action']; duration?: number } = {},
): number {
  const id = next++;
  const tone = opts.tone ?? 'info';
  toasts.set((ts) => [
    ...ts.slice(-3),
    {
      id,
      text,
      tone,
      ...(opts.action ? { action: opts.action } : {}),
      duration: opts.duration ?? (tone === 'error' ? 6000 : 4000),
    },
  ]);
  return id;
}

export const dismissToast = (id: number): void => toasts.set((ts) => ts.filter((t) => t.id !== id));

/** Renders toasts; mounted once by the shell. */
export function Toaster(): ReactNode {
  const items = useStore(toasts, (t) => t);
  return (
    <T.Provider swipeDirection="right">
      {items.map((t) => (
        <T.Root
          key={t.id}
          className={cx('ui-overlay', 'ui-toast', `ui-toast-${t.tone}`)}
          {...(t.duration !== undefined ? { duration: t.duration } : {})}
          onOpenChange={(open) => {
            if (!open) dismissToast(t.id);
          }}
          data-testid="toast"
        >
          <T.Description className="ui-toast-text">{t.text}</T.Description>
          {t.action && (
            <T.Action
              altText={t.action.label}
              className="ui-btn ui-btn-ghost ui-btn-sm"
              onClick={t.action.run}
            >
              {t.action.label}
            </T.Action>
          )}
        </T.Root>
      ))}
      <T.Viewport className="ui-toast-viewport" />
    </T.Provider>
  );
}
