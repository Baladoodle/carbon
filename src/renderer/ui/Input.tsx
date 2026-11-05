import {
  forwardRef,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type ForwardedRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { IconButton } from './Button';
import { cx } from './cx';
import {
  HOST,
  blurExpander,
  editorKey,
  focusExpander,
  inOverlay,
  leavesField,
  openHost,
  type Expander,
} from './expand';
import { IconExpand } from './icons';

interface SuggestionProps {
  /**
   * An AI suggestion shown inline after the typed text, in --ai at 70% (VISUAL.md §5).
   * Accepting it (tab) is the caller's job: set the value and clear the suggestion.
   */
  suggestion?: string | null | undefined;
  /** Error state (the border); use Field to show the message. */
  invalid?: boolean;
  /** Numbers, ids and formulas use the mono face with tabular numerals. */
  mono?: boolean;
  /**
   * The expand affordance and `ctrl+shift+e` (expand.ts): on by default for a
   * controlled text field. Turn it off for numbers and other short values.
   */
  expandable?: boolean;
  /**
   * What committing the field does: `ctrl+enter` in the large editor runs it.
   * Without it, `ctrl+enter` leaves the field (fields commit when you leave them).
   */
  onCommit?: () => void;
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & SuggestionProps;
export type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & SuggestionProps;

/** Completion text to show: the part of the suggestion after what's typed, or the whole suggestion after a space. */
export function ghostText(value: string, suggestion: string | null | undefined): string {
  if (!suggestion) return '';
  if (value === '') return suggestion;
  if (suggestion.toLowerCase().startsWith(value.toLowerCase()))
    return suggestion.slice(value.length);
  return ` → ${suggestion}`;
}

type Control = HTMLInputElement | HTMLTextAreaElement;
type Handlers = {
  onFocus?: ((e: FocusEvent<never>) => void) | undefined;
  onBlur?: ((e: FocusEvent<never>) => void) | undefined;
  onKeyDown?: ((e: KeyboardEvent<never>) => void) | undefined;
  onCommit?: (() => void) | undefined;
};

function setRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) ref.current = value;
}

/** The space a textarea grows into before it scrolls: 40% of its pane (or of the window). */
function growLimit(el: HTMLElement): number {
  const pane = el.closest<HTMLElement>('[data-pane], .main');
  return Math.max(96, Math.round((pane?.clientHeight ?? window.innerHeight) * 0.4));
}

/**
 * The field and its large editor as one control (expand.ts has the rules).
 * Opening swaps the control for the editor's textarea in place, so React
 * keeps the field's state; the handoff between them is hidden from the
 * field's own focus and blur handlers.
 */
function useExpand(
  o: Handlers & { enabled: boolean; multiline: boolean; ghost: boolean; controlled: boolean },
) {
  const [open, setOpen] = useState(false);
  // Read by handlers between a setOpen and its render, so set where it changes.
  const openRef = useRef(false);
  const node = useRef<Control | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const host = useRef<HTMLElement | null>(null);
  const handoff = useRef(false);
  const caret = useRef<[number, number] | null>(null);
  const after = useRef<'commit' | 'submit' | null>(null);
  // An uncontrolled field's text while its editor is open, handed back when it closes.
  const [own, setOwn] = useState('');
  const handBack = useRef<string | null>(null);
  const [spacer, setSpacer] = useState<{ width: number; height: number } | null>(null);
  // Whether the field's container grows (a host), or the editor's own panel.
  const [hosted, setHosted] = useState(false);
  const latest = useRef(o);
  useLayoutEffect(() => {
    latest.current = o;
  });

  const keepCaret = (): void => {
    const el = node.current;
    caret.current = el
      ? [el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length]
      : null;
  };
  const expand = useCallback((): void => {
    const el = node.current;
    if (!el || openRef.current || !latest.current.enabled || inOverlay(el)) return;
    keepCaret();
    setOwn(el.value);
    host.current = el.parentElement?.closest<HTMLElement>(`[${HOST}]`) ?? null;
    const box = (el.closest('.ui-suggest') ?? el).getBoundingClientRect();
    setSpacer(host.current ? null : { width: box.width, height: box.height });
    setHosted(host.current !== null);
    handoff.current = true;
    openRef.current = true;
    setOpen(true);
  }, []);
  const close = useCallback((then: 'commit' | 'submit' | null = null): void => {
    if (!openRef.current) return;
    keepCaret();
    handBack.current = node.current?.value ?? null;
    handoff.current = true;
    after.current = then;
    openRef.current = false;
    setOpen(false);
  }, []);
  const expander: Expander = useMemo(
    () => ({
      toggle: () => (openRef.current ? close() : expand()),
      expanded: () => openRef.current,
    }),
    [close, expand],
  );

  // After the swap: focus the new control with the caret where it was, then commit if asked.
  useLayoutEffect(() => {
    if (!handoff.current) return;
    const el = node.current;
    if (el && !open && !latest.current.controlled && handBack.current !== null)
      el.value = handBack.current;
    handBack.current = null;
    if (el) {
      el.focus({ preventScroll: true });
      const c = caret.current;
      if (c) el.setSelectionRange(Math.min(c[0], el.value.length), Math.min(c[1], el.value.length));
      if (open) el.scrollTop = el.scrollHeight;
    }
    handoff.current = false;
    const then = after.current;
    after.current = null;
    if (then === 'commit') {
      const commit = latest.current.onCommit;
      if (commit) commit();
      else el?.blur();
    }
    // A one-line field's enter in a form submits it, as it would have in the field.
    if (then === 'submit' && el instanceof HTMLInputElement) el.form?.requestSubmit();
  }, [open]);

  // While open: the host grows into the editor; its keys, and clicks outside it.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const box = host.current ?? panel.current;
    if (!box) return undefined;
    return openHost(box, {
      hold: host.current !== null,
      multiline: () => latest.current.multiline,
      waiting: () => latest.current.ghost,
      onClose: (commit) => close(commit ? 'commit' : null),
    });
  }, [open, close]);

  useLayoutEffect(() => () => blurExpander(expander), [expander]);

  const editor = (): Node | null => host.current ?? panel.current;
  const getNode = useCallback((): Control | null => node.current, []);
  const setNode = useCallback((el: Control | null): void => {
    node.current = el;
  }, []);
  const setPanel = useCallback((el: HTMLDivElement | null): void => {
    panel.current = el;
  }, []);
  const handlers = {
    onFocus: (e: FocusEvent<Control>): void => {
      if (latest.current.enabled) focusExpander(expander);
      if (!handoff.current) latest.current.onFocus?.(e as FocusEvent<never>);
    },
    onBlur: (e: FocusEvent<Control>): void => {
      const next = e.relatedTarget instanceof Node ? e.relatedTarget : null;
      if (
        !leavesField({ handoff: handoff.current, next, editor: openRef.current ? editor() : null })
      )
        return;
      blurExpander(expander);
      // Focus went somewhere behind the editor (tab, a click the editor let through): it closes.
      if (openRef.current && next) {
        openRef.current = false;
        setOpen(false);
      }
      latest.current.onBlur?.(e as FocusEvent<never>);
    },
    onKeyDown: (e: KeyboardEvent<Control>): void => {
      latest.current.onKeyDown?.(e as KeyboardEvent<never>);
      if (!openRef.current) return;
      const k = editorKey(e, { multiline: latest.current.multiline, waiting: false });
      if (k !== 'enter') return;
      // One line: enter was the field's own enter (above); the newline isn't the field's.
      const handled = e.defaultPrevented;
      e.preventDefault();
      close(handled ? null : 'submit');
    },
  };
  return {
    open,
    hosted,
    spacer,
    own,
    setOwn,
    expand,
    handlers,
    getNode,
    setNode,
    setPanel,
  };
}

type X = ReturnType<typeof useExpand>;

/** The expand affordance: shown on hover and focus, pinned to its field's top-right corner. */
function ExpandButton({ x, anchor }: { x: X; anchor: string }): ReactNode {
  return (
    <IconButton
      size="sm"
      label="Expand"
      keys="ctrl+shift+e"
      icon={<IconExpand />}
      className="ui-expand-btn"
      tabIndex={-1}
      style={{ '--ui-anchor': anchor } as CSSProperties}
      // Keeps focus in the field: a press here isn't leaving it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={x.expand}
    />
  );
}

type EditorProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  own: string;
  setOwn: (v: string) => void;
  hosted: boolean;
  spacer: { width: number; height: number } | null;
  setPanel: (el: HTMLDivElement | null) => void;
  handlers: X['handlers'];
  text: string;
  ghost: string;
  mono: boolean | undefined;
  invalid: boolean | undefined;
  refOut: (el: HTMLTextAreaElement | null) => void;
};

/** The large editor: the field's own value and handlers in a centred, multi-line textarea. */
function Editor({
  own,
  setOwn,
  hosted,
  spacer,
  setPanel,
  handlers,
  text: given,
  ghost,
  mono,
  invalid,
  refOut,
  controlled,
  onChange,
  ...rest
}: EditorProps & { controlled: boolean }): ReactNode {
  const mirror = useRef<HTMLDivElement>(null);
  const text = controlled ? given : own;
  const area = (
    <div
      className={cx('ui-suggest', 'ui-suggest-area', 'ui-expand-area', mono && 'mono')}
      data-suggesting={ghost ? '' : undefined}
    >
      <textarea
        {...rest}
        ref={refOut}
        value={text}
        onChange={(e) => {
          if (!controlled) setOwn(e.target.value);
          onChange?.(e);
        }}
        aria-invalid={invalid || rest['aria-invalid'] || undefined}
        className={cx('ui-input', 'ui-textarea', 'ui-expand-control', mono && 'mono')}
        data-testid="expand-editor"
        onFocus={handlers.onFocus}
        onBlur={handlers.onBlur}
        onKeyDown={handlers.onKeyDown}
        onScroll={(e) => {
          if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
        }}
      />
      {ghost && (
        <div ref={mirror} className="ui-suggest-mirror" aria-hidden="true">
          <span className="ui-suggest-typed">{text}</span>
          <span className="ui-suggest-ghost">{ghost}</span>
        </div>
      )}
    </div>
  );
  if (hosted) return area;
  return (
    <>
      {spacer && <div className="ui-expand-spacer" style={spacer} />}
      <div ref={setPanel} className="ui-expand-panel" data-expanded="">
        {area}
      </div>
    </>
  );
}

/** Attributes an <input> has and a <textarea> must not get. */
const INPUT_ONLY = ['type', 'size', 'pattern', 'min', 'max', 'step', 'list', 'accept', 'multiple'];
const forTextarea = (rest: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(rest).filter(([k]) => !INPUT_ONLY.includes(k)));

const TEXT_TYPES = new Set([undefined, 'text', 'search', 'url', 'email']);

const anchorOf = (id: string): string => `--x${id.replace(/[^a-zA-Z0-9_-]/g, '')}`;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    suggestion,
    invalid,
    mono,
    className,
    value,
    placeholder,
    expandable,
    onCommit,
    onFocus,
    onBlur,
    onKeyDown,
    style,
    ...rest
  },
  ref,
) {
  const text = typeof value === 'string' ? value : value === undefined ? '' : String(value);
  const ghost = ghostText(text, suggestion);
  const controlled = value !== undefined;
  const enabled = expandable ?? TEXT_TYPES.has(rest.type);
  const x = useExpand({
    enabled,
    controlled,
    multiline: false,
    ghost: ghost !== '',
    onFocus,
    onBlur,
    onKeyDown,
    onCommit,
  });
  const anchor = anchorOf(useId());
  const { setNode } = x;
  const refOut = useCallback(
    (el: Control | null) => {
      setNode(el);
      setRef(ref, el as HTMLInputElement | null);
    },
    [ref, setNode],
  );
  if (x.open)
    return (
      <Editor
        {...(forTextarea(rest) as TextareaHTMLAttributes<HTMLTextAreaElement>)}
        own={x.own}
        setOwn={x.setOwn}
        hosted={x.hosted}
        spacer={x.spacer}
        setPanel={x.setPanel}
        handlers={x.handlers}
        text={text}
        ghost={ghost}
        mono={mono}
        invalid={invalid}
        refOut={refOut}
        controlled={controlled}
        placeholder={ghost ? undefined : placeholder}
      />
    );
  const anchorStyle = enabled ? ({ ...style, '--ui-anchor': anchor } as CSSProperties) : style;
  const input = (
    <input
      ref={refOut}
      value={value}
      placeholder={ghost ? undefined : placeholder}
      aria-invalid={invalid || rest['aria-invalid'] || undefined}
      className={cx(
        'ui-input',
        mono && 'mono',
        enabled && !ghost && 'ui-expandable',
        !ghost && className,
      )}
      style={ghost ? style : anchorStyle}
      {...rest}
      onFocus={x.handlers.onFocus}
      onBlur={x.handlers.onBlur}
      onKeyDown={x.handlers.onKeyDown}
    />
  );
  const button = enabled ? <ExpandButton x={x} anchor={anchor} /> : null;
  if (!ghost)
    return (
      <>
        {input}
        {button}
      </>
    );
  return (
    <>
      <div
        className={cx('ui-suggest', mono && 'mono', enabled && 'ui-expandable', className)}
        data-suggesting=""
        style={enabled ? ({ '--ui-anchor': anchor } as CSSProperties) : undefined}
      >
        {input}
        <div className="ui-suggest-mirror" aria-hidden="true">
          <span className="ui-suggest-typed">{text}</span>
          <span className="ui-suggest-ghost">{ghost}</span>
        </div>
      </div>
      {button}
    </>
  );
});

/**
 * A multi-line field. It grows with its content up to 40% of its pane, then
 * scrolls; dragging its corner sizes it by hand (and then it stays that size).
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  {
    suggestion,
    invalid,
    mono,
    className,
    value,
    placeholder,
    expandable,
    onCommit,
    onFocus,
    onBlur,
    onKeyDown,
    style,
    ...rest
  },
  ref,
) {
  const text = typeof value === 'string' ? value : '';
  const ghost = ghostText(text, suggestion);
  const controlled = value !== undefined;
  const enabled = expandable ?? true;
  const x = useExpand({
    enabled,
    controlled,
    multiline: true,
    ghost: ghost !== '',
    onFocus,
    onBlur,
    onKeyDown,
    onCommit,
  });
  const anchor = anchorOf(useId());
  const { setNode } = x;
  const refOut = useCallback(
    (el: Control | null) => {
      setNode(el);
      setRef(ref, el as HTMLTextAreaElement | null);
    },
    [ref, setNode],
  );

  // Grows with its content, up to its limit; a size set by hand wins from then on.
  const auto = useRef<{ el: Control; h: number } | null>(null);
  const manual = useRef(false);
  useLayoutEffect(() => {
    const el = x.getNode();
    if (!el || x.open || manual.current) return;
    // A new element (a suggestion wrapping it, the editor closing) starts over at its own size.
    if (auto.current?.el === el && Math.abs(el.offsetHeight - auto.current.h) > 1) {
      manual.current = true;
      return;
    }
    el.style.height = 'auto';
    const border = el.offsetHeight - el.clientHeight;
    const limit = growLimit(el);
    const h = Math.min(el.scrollHeight + border, limit);
    el.style.height = `${h}px`;
    el.style.overflowY = el.scrollHeight + border > limit ? 'auto' : 'hidden';
    auto.current = { el, h: el.offsetHeight };
  });

  if (x.open)
    return (
      <Editor
        {...rest}
        own={x.own}
        setOwn={x.setOwn}
        hosted={x.hosted}
        spacer={x.spacer}
        setPanel={x.setPanel}
        handlers={x.handlers}
        text={text}
        ghost={ghost}
        mono={mono}
        invalid={invalid}
        refOut={refOut}
        controlled={controlled}
        placeholder={ghost ? undefined : placeholder}
      />
    );
  const area = (
    <textarea
      ref={refOut}
      value={value}
      placeholder={ghost ? undefined : placeholder}
      aria-invalid={invalid || rest['aria-invalid'] || undefined}
      className={cx(
        'ui-input',
        'ui-textarea',
        mono && 'mono',
        enabled && !ghost && 'ui-expandable',
        !ghost && className,
      )}
      style={enabled && !ghost ? ({ ...style, '--ui-anchor': anchor } as CSSProperties) : style}
      {...rest}
      onFocus={x.handlers.onFocus}
      onBlur={x.handlers.onBlur}
      onKeyDown={x.handlers.onKeyDown}
    />
  );
  const button = enabled ? <ExpandButton x={x} anchor={anchor} /> : null;
  if (!ghost)
    return (
      <>
        {area}
        {button}
      </>
    );
  return (
    <>
      <div
        className={cx(
          'ui-suggest',
          'ui-suggest-area',
          mono && 'mono',
          enabled && 'ui-expandable',
          className,
        )}
        data-suggesting=""
        style={enabled ? ({ '--ui-anchor': anchor } as CSSProperties) : undefined}
      >
        {area}
        <div className="ui-suggest-mirror" aria-hidden="true">
          <span className="ui-suggest-typed">{text}</span>
          <span className="ui-suggest-ghost">{ghost}</span>
        </div>
      </div>
      {button}
    </>
  );
});
