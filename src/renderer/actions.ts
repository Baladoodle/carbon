import { useEffect, useLayoutEffect, useRef } from 'react';
import { createStore, useStore } from './state/store';

/**
 * Actions: everything you can do, with its keys. The keymap and the command
 * palette both read this registry, so an action registered once is reachable
 * from the keyboard and from ctrl+k.
 *
 * Key syntax: modifiers in the order `ctrl+alt+shift+meta+`, then the key in
 * lower case (`k`, `space`, `tab`, `enter`, `escape`, `arrowup`, `[`, `?`).
 * Shift is implied for shifted symbols: write `?`, not `shift+/`.
 */
export interface Action {
  /** Stable id, namespaced by package: `column.new`, `spread.keep`. */
  id: string;
  label: string;
  /** Group heading in the palette (e.g. "Views", "Column"). */
  group?: string;
  keys?: string[];
  run: () => void;
  /** Whether it can run now (default: yes). Disabled actions don't take their keys. */
  enabled?: () => boolean;
  /** Also fire while typing in an input or textarea (default: only with ctrl/alt/meta, or escape). */
  inInputs?: boolean;
  /** Hide from the palette (e.g. the triage keys of a spread). */
  hidden?: boolean;
}

interface Layer {
  id: number;
  actions: Action[];
}

/** Layers in mount order; later layers win a key (a view over the shell, an overlay over a view). */
export const actionStore = createStore<Layer[]>([]);
let nextLayer = 1;

/** Registers a layer of actions; returns a function that removes it. */
export function registerActions(actions: Action[]): () => void {
  const id = nextLayer++;
  actionStore.set((ls) => [...ls, { id, actions }]);
  return () => actionStore.set((ls) => ls.filter((l) => l.id !== id));
}

/**
 * Registers actions while the component is mounted. Pass a fresh array each
 * render freely: the latest closures are always used, and the layer keeps its
 * place in the stack.
 */
export function useActions(actions: Action[], enabled = true): void {
  const ref = useRef(actions);
  useLayoutEffect(() => {
    ref.current = actions;
  });
  const signature = actions
    .map((a) => `${a.id}:${(a.keys ?? []).join(',')}:${a.label}:${a.hidden ? 1 : 0}`)
    .join('|');
  useEffect(() => {
    if (!enabled) return undefined;
    const proxies: Action[] = ref.current.map((a, i) => ({
      ...a,
      run: () => ref.current[i]?.run(),
      enabled: () => ref.current[i]?.enabled?.() ?? true,
    }));
    return registerActions(proxies);
  }, [signature, enabled]);
}

/** All actions, newest layer first, one per id. */
export function allActions(layers: Layer[] = actionStore.get()): Action[] {
  const seen = new Set<string>();
  const out: Action[] = [];
  for (let i = layers.length - 1; i >= 0; i--)
    for (const a of layers[i]?.actions ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(a);
    }
  return out;
}

export const useAllActions = (): Action[] => useStore(actionStore, allActions);

/** Normalises a keyboard event to the key syntax above. */
export function keyOf(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>,
): string {
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'esc') key = 'escape';
  if (key === 'control' || key === 'shift' || key === 'alt' || key === 'meta') return key;
  const printableSymbol = key.length === 1 && !/[a-z0-9]/.test(key);
  const mods = [
    e.ctrlKey && 'ctrl',
    e.altKey && 'alt',
    e.shiftKey && !printableSymbol && 'shift',
    e.metaKey && 'meta',
  ].filter(Boolean);
  return [...mods, key].join('+');
}

const isTyping = (t: EventTarget | null): boolean => {
  if (typeof HTMLElement === 'undefined' || !(t instanceof HTMLElement)) return false;
  return (
    t.isContentEditable ||
    t.tagName === 'INPUT' ||
    t.tagName === 'TEXTAREA' ||
    t.tagName === 'SELECT'
  );
};

/** Finds and runs the action for a key event. Returns whether one ran. */
export function handleKey(e: KeyboardEvent): boolean {
  const key = keyOf(e);
  const typing = isTyping(e.target);
  const layers = actionStore.get();
  for (let i = layers.length - 1; i >= 0; i--) {
    for (const a of layers[i]?.actions ?? []) {
      if (!a.keys?.includes(key)) continue;
      if (typing && !a.inInputs && !/^(ctrl|alt|meta)\+/.test(key) && key !== 'escape') continue;
      if (a.enabled && !a.enabled()) continue;
      e.preventDefault();
      a.run();
      return true;
    }
  }
  return false;
}

/** Installs the single window keydown listener. Called once by the shell. */
export function installKeymap(): () => void {
  const listener = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing) return;
    handleKey(e);
  };
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}
