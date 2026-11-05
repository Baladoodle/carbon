/**
 * Expanding a text field into the large editor (Input, Textarea and the
 * Numbers formula editor). The editor is the same field, made big: the same
 * value, draft and handlers, so suggestions, the AI marker and the draft
 * conflict prompt keep working in it. These are its pure rules and the one
 * registry `ctrl+shift+e` reads; the components are in `Input.tsx`.
 *
 * - **Keys in the editor:** `ctrl+enter` commits (what the field's enter or
 *   leaving does) and closes. `esc` closes and keeps the edit as the field's
 *   draft: it commits the way the field always does, when you press enter or
 *   leave it. With something in the editor waiting for `esc` (an AI
 *   suggestion, three alternatives, an open completion list), `esc` goes to
 *   that first. In a one-line field, `enter` is the field's own enter, then
 *   closes; in a multi-line one it breaks the line.
 * - **Focus:** moving between the field and its editor is not leaving the
 *   field: the field's own blur and focus handlers don't run, so a field that
 *   commits (the Bench) or cancels (a Codex cell) on blur does neither.
 *   Leaving the editor for somewhere else is leaving the field.
 * - **Clicking outside** closes it, keeping the edit, and the click goes no further.
 */

/** What a key does in the open editor. */
export type EditorKey = 'close' | 'commit' | 'enter' | null;

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * The editor's own keys. `waiting`: something inside wants `esc` first.
 * `multiline`: enter breaks the line rather than being the field's enter.
 */
export function editorKey(e: KeyLike, o: { multiline: boolean; waiting: boolean }): EditorKey {
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.metaKey)
    return o.waiting ? null : 'close';
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) return 'commit';
  if (e.key === 'Enter' && !o.multiline && !e.ctrlKey && !e.metaKey && !e.altKey) return 'enter';
  return null;
}

/**
 * Whether the field's own blur handler should run when its control (or its
 * editor) loses focus to `next`. Focus handed between the field and its
 * editor, or moving within the editor, is not leaving the field.
 */
export function leavesField(o: {
  handoff: boolean;
  next: Node | null;
  editor: Node | null;
}): boolean {
  if (o.handoff) return false;
  if (o.next && o.editor && o.editor.contains(o.next)) return false;
  return true;
}

/** Fields inside an overlay (the palette, a dialog, a popover) don't expand: no overlay over an overlay. */
export const IN_OVERLAY = '[role="dialog"], [data-radix-popper-content-wrapper], .palette-scrim';
export const inOverlay = (el: Element | null): boolean => !!el?.closest(IN_OVERLAY);

/**
 * Marks an element inside an expanded field that wants `esc` before the
 * editor does (an AI proposal and its reject, three alternatives, a list of
 * completions). Put it on that element as an attribute.
 */
export const WAITS_FOR_ESC = 'data-expand-esc';

/**
 * Marks a field's container as what grows into the editor (`data-expand-host`):
 * its label, AI marker, proposals and conflict prompt come along. Without
 * one, the control alone grows.
 */
export const HOST = 'data-expand-host';

// ── The focused field, for ctrl+shift+e ─────────────────────────────────────

export interface Expander {
  toggle: () => void;
  expanded: () => boolean;
}

let focused: Expander | null = null;

export const focusExpander = (x: Expander): void => {
  focused = x;
};
export const blurExpander = (x: Expander): void => {
  if (focused === x) focused = null;
};

/** Whether the focused field can expand (or close) now. */
export const canToggleFocused = (): boolean => focused !== null;

/** `ctrl+shift+e`: expands the focused field, or closes its editor. */
export function toggleFocused(): boolean {
  if (!focused) return false;
  focused.toggle();
  return true;
}

// ── An open editor's host ───────────────────────────────────────────────────

export interface HostOptions {
  /** Keep the host's place in its panel with a spacer while it floats (a host the kit doesn't render). */
  hold: boolean;
  multiline: () => boolean;
  /** Something besides the marked elements wants `esc` first (the kit's own ghost suggestion). */
  waiting?: () => boolean;
  /** `ctrl+enter` (commit) or `esc` and clicks outside (close). */
  onClose: (commit: boolean) => void;
}

/**
 * Makes `box` the open editor: marks it `data-expanded` (the kit's CSS floats
 * it, centred), takes its `esc` and `ctrl+enter` before anything else sees
 * them, and closes it on a click outside, which goes no further. Returns the
 * function that puts everything back.
 */
export function openHost(box: HTMLElement, o: HostOptions): () => void {
  let hold: HTMLDivElement | null = null;
  if (o.hold) {
    hold = document.createElement('div');
    hold.className = 'ui-expand-spacer';
    hold.style.height = `${box.getBoundingClientRect().height}px`;
    box.after(hold);
  }
  box.setAttribute('data-expanded', '');
  const onKey = (e: KeyboardEvent): void => {
    if (e.isComposing) return;
    const waiting = (o.waiting?.() ?? false) || box.querySelector(`[${WAITS_FOR_ESC}]`) !== null;
    const k = editorKey(e, { multiline: o.multiline(), waiting });
    if (k !== 'close' && k !== 'commit') return;
    e.preventDefault();
    e.stopPropagation();
    o.onClose(k === 'commit');
  };
  const swallow = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  const outside = (e: PointerEvent): void => {
    if (!(e.target instanceof Node) || box.contains(e.target)) return;
    if (e.target instanceof Element && e.target.closest('.ui-tooltip')) return;
    swallow(e);
    // The rest of this press goes nowhere either. These outlive the editor (it closes now),
    // until the press is over.
    window.addEventListener('mousedown', swallow, { capture: true, once: true });
    window.addEventListener('click', swallow, { capture: true, once: true });
    window.addEventListener(
      'pointerup',
      () =>
        setTimeout(() => {
          window.removeEventListener('mousedown', swallow, true);
          window.removeEventListener('click', swallow, true);
        }, 0),
      { capture: true, once: true },
    );
    o.onClose(false);
  };
  // A press on the editor's own text or padding keeps focus where it is.
  const keep = (e: MouseEvent): void => {
    const t = e.target instanceof Element ? e.target : null;
    if (t && !t.closest('input, textarea, button, select, a, [tabindex], [role="option"]'))
      e.preventDefault();
  };
  box.addEventListener('keydown', onKey);
  box.addEventListener('mousedown', keep);
  window.addEventListener('pointerdown', outside, true);
  return () => {
    box.removeEventListener('keydown', onKey);
    box.removeEventListener('mousedown', keep);
    window.removeEventListener('pointerdown', outside, true);
    hold?.remove();
    box.removeAttribute('data-expanded');
  };
}
