/**
 * Type-ahead for create keys. `n` makes an entity and puts its name in focus,
 * but focus can only move once the create command has round-tripped and the
 * Bench has rendered the new entity. Letters typed in that gap would reach the
 * view's keymap instead (and run its keys), so a fast "n, then the name" lost
 * its first letters. From `holdTypeahead()` until the focus request lands (or
 * a short limit passes), printable keys are held here instead, and the field
 * that takes focus receives them.
 */
let held: string | null = null;
let until = 0;
const LIMIT_MS = 1500;
let installed = false;

const typing = (t: EventTarget | null): boolean =>
  t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;

function install(): void {
  if (installed) return;
  installed = true;
  // Capture phase: before the app's keymap sees the key.
  window.addEventListener(
    'keydown',
    (e) => {
      if (held === null) return;
      if (Date.now() > until) {
        held = null;
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || typing(e.target)) return;
      if (e.key.length === 1) held += e.key;
      else if (e.key === 'Backspace') held = held.slice(0, -1);
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
}

/** Starts holding printable keys: call as a create key runs, before its command. */
export function holdTypeahead(): void {
  install();
  held = '';
  until = Date.now() + LIMIT_MS;
}

/** Stops holding and returns what was typed meanwhile (and nothing after the limit). */
export function takeTypeahead(): string {
  const text = held !== null && Date.now() <= until ? held : '';
  held = null;
  return text;
}

/** Types held text into the input that just took focus, as if typed there (React sees it). */
export function typeInto(el: Element | null, text: string, replace: boolean): void {
  if (text === '' || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
  const proto = el instanceof HTMLInputElement ? HTMLInputElement : HTMLTextAreaElement;
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  const next = replace ? text : el.value + text;
  set?.call(el, next);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.setSelectionRange(next.length, next.length);
}
