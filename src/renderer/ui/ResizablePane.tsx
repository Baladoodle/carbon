import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cx } from './cx';
import {
  arrowDir,
  clampSize,
  collapsing,
  dragSize,
  notePaneFocus,
  registerPane,
  resolveMax,
  setPaneSize,
  settle,
  stepSize,
  usePaneSize,
  type PaneEdge,
  type PaneLimits,
  type PaneMax,
} from './pane';

export interface ResizablePaneProps {
  /** Where the size is remembered (per machine): `bench`, `numbers-side`, … */
  id: string;
  /** The edge that resizes: `start` (left, or top) or `end` (right, or bottom). */
  edge: PaneEdge;
  /** `x` resizes the width (the default), `y` the height. */
  axis?: 'x' | 'y';
  /** The size double-click goes back to; without one, the pane's CSS decides until it's resized. */
  defaultSize?: number;
  min: number;
  /** px, or a share of the window or of the pane's parent: `({ window }) => window * 0.6`. */
  max?: PaneMax;
  /** Given, dragging or stepping below the minimum hides the pane: call to hide it. */
  onCollapse?: () => void;
  /** The edge's accessible name (it has no visible text). */
  label: string;
  className?: string;
  style?: CSSProperties;
  /** One element: the panel itself (it keeps its own scrolling). */
  children: ReactNode;
}

interface Space {
  window: number;
  parent: number;
}

const measure = (el: HTMLElement | null): Space => ({
  window: typeof window === 'undefined' ? 0 : window.innerWidth,
  parent: el?.parentElement?.getBoundingClientRect().width ?? 0,
});
const measureY = (el: HTMLElement | null): Space => ({
  window: typeof window === 'undefined' ? 0 : window.innerHeight,
  parent: el?.parentElement?.getBoundingClientRect().height ?? 0,
});

// Focus moving between panes: one listener for the whole window.
let listening = false;
function listenForFocus(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('focusin', (e) => notePaneFocus(e.target), true);
}

/**
 * A panel with a draggable inner edge (VISUAL.md §4: hairlines carry the
 * structure). The edge is a 4px hit area holding a hairline that brightens on
 * hover and while dragging. Double-click (or enter) puts the default size
 * back; arrows step it by 16px, shift by 64px. Sizes stay within `min` and
 * `max` and are remembered per machine. While a drag moves, only this
 * element's style changes, once a frame: the size is committed (one render,
 * one write) when the drag ends.
 */
export function ResizablePane({
  id,
  edge,
  axis = 'x',
  defaultSize,
  min,
  max,
  onCollapse,
  label,
  className,
  style,
  children,
}: ResizablePaneProps): ReactNode {
  const wrap = useRef<HTMLDivElement>(null);
  const stored = usePaneSize(id);
  const read = axis === 'x' ? measure : measureY;
  const [space, setSpace] = useState<Space>(() => read(null));
  const limits = (s: Space = space): PaneLimits => ({
    min,
    max: resolveMax(max, s),
    collapsible: onCollapse !== undefined,
  });
  const wanted = stored ?? defaultSize ?? null;
  const size = wanted === null ? null : clampSize(wanted, limits());
  const dim = axis === 'x' ? 'width' : 'height';

  // The space it has: the window and its parent (the Bench widening narrows a view's panes).
  useLayoutEffect(() => {
    const el = wrap.current;
    const update = (): void =>
      setSpace((prev) => {
        const next = read(el);
        return prev.window === next.window && prev.parent === next.parent ? prev : next;
      });
    update();
    window.addEventListener('resize', update);
    const parent = el?.parentElement;
    const ro = typeof ResizeObserver === 'undefined' || !parent ? null : new ResizeObserver(update);
    if (parent) ro?.observe(parent);
    return () => {
      window.removeEventListener('resize', update);
      ro?.disconnect();
    };
  }, [read]);

  const current = (): number => {
    const r = wrap.current?.getBoundingClientRect();
    return Math.round(r ? (axis === 'x' ? r.width : r.height) : (size ?? min));
  };
  const apply = (next: { size: number; collapse: boolean }): void => {
    if (next.collapse) return onCollapse?.();
    setPaneSize(id, next.size === defaultSize ? null : next.size);
  };
  const step = (dir: 1 | -1, big: boolean): void => {
    const l = limits(read(wrap.current));
    apply(stepSize(current(), dir, big, l));
  };

  useEffect(listenForFocus, []);
  // Registered for the palette's "Widen panel" / "Narrow panel".
  const stepRef = useRef(step);
  useLayoutEffect(() => {
    stepRef.current = step;
  });
  useEffect(
    () => registerPane({ id, element: () => wrap.current, step: (d) => stepRef.current(d, true) }),
    [id],
  );

  const drag = useRef<{ start: number; origin: number; raw: number; frame: number } | null>(null);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus({ preventScroll: true });
    const start = current();
    drag.current = { start, origin: axis === 'x' ? e.clientX : e.clientY, raw: start, frame: 0 };
    e.currentTarget.dataset['dragging'] = '';
    document.documentElement.dataset['paneDrag'] = axis;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    d.raw = dragSize(d.start, (axis === 'x' ? e.clientX : e.clientY) - d.origin, edge);
    if (d.frame) return;
    // Once a frame, and only this element's style: the views inside re-measure from their
    // own ResizeObserver, so a fast drag costs one layout a frame, not one per event.
    d.frame = requestAnimationFrame(() => {
      d.frame = 0;
      const el = wrap.current;
      if (!el || drag.current !== d) return;
      const l = limits(read(el));
      el.style[dim] = `${clampSize(d.raw, l)}px`;
      el.style.flex = '0 0 auto';
      if (collapsing(d.raw, l)) el.dataset['collapsing'] = '';
      else delete el.dataset['collapsing'];
    });
  };
  const end = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    delete e.currentTarget.dataset['dragging'];
    delete document.documentElement.dataset['paneDrag'];
    const el = wrap.current;
    if (el) {
      // React owns the size again from here.
      el.style[dim] = size === null ? '' : `${size}px`;
      el.style.flex = size === null ? '' : '0 0 auto';
      delete el.dataset['collapsing'];
    }
    if (d.raw === d.start) return;
    apply(settle(d.raw, limits(read(el))));
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const dir = arrowDir(e.key, axis, edge);
    if (dir !== 0) {
      e.preventDefault();
      e.stopPropagation();
      step(dir, e.shiftKey);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      setPaneSize(id, null);
    }
  };

  return (
    <div
      ref={wrap}
      className={cx('ui-pane', `ui-pane-${axis}`, className)}
      data-pane={id}
      data-sized={size === null ? undefined : ''}
      style={{ ...style, ...(size === null ? {} : { [dim]: size, flex: '0 0 auto' }) }}
    >
      {children}
      <div
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
        aria-valuenow={size ?? undefined}
        aria-valuemin={min}
        className={cx('ui-pane-edge', `ui-pane-edge-${edge}`)}
        data-testid={`pane-edge-${id}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => setPaneSize(id, null)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
