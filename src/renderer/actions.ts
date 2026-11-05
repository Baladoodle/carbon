import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
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
  /** Higher ranks win a key over lower ones; within a rank, the newest layer wins. */
  rank: number;
  /** A panel's element: while keyboard focus is inside it, its layer wins over every other. */
  within?: () => Element | null;
}

/**
 * Ranks of layers. The shell's keys are the floor; the Bench sits above the
 * shell and below the views (a view's `ctrl+enter` or `d` means the view's
 * action while you're in the view), except while focus is inside the Bench,
 * where its keys win; views and overlays share the top rank, so an overlay
 * opened over a view (mounted later) wins.
 */
export const RANK = { shell: 0, panel: 1, view: 2 } as const;

/** Layers in mount order (see `ordered` for which one wins a key). */
export const actionStore = createStore<Layer[]>([]);
let nextLayer = 1;

/**
 * Keys bound twice within one layer: each entry is a key and the ids of the
 * actions that bind it. Within a layer the first match would always win and
 * the second could never run, so every layer must be free of them (layers
 * shadowing each other is by design: an overlay over a view over the shell).
 */
export function duplicateKeys(actions: readonly Action[]): { key: string; ids: string[] }[] {
  const byKey = new Map<string, string[]>();
  for (const a of actions)
    for (const k of new Set(a.keys ?? [])) byKey.set(k, [...(byKey.get(k) ?? []), a.id]);
  return [...byKey]
    .filter(([, ids]) => ids.length > 1)
    .map(([key, ids]) => ({ key, ids }))
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

function reportDuplicates(actions: readonly Action[]): void {
  for (const d of duplicateKeys(actions))
    console.error(`carbon: duplicate key "${d.key}" in one layer: ${d.ids.join(', ')}`);
}

/** Registers a layer of actions; returns a function that removes it. */
export function registerActions(
  actions: Action[],
  opts: { rank?: number; within?: () => Element | null } = {},
): () => void {
  const id = nextLayer++;
  reportDuplicates(actions);
  actionStore.set((ls) => [
    ...ls,
    { id, actions, rank: opts.rank ?? RANK.view, ...pickWithin(opts) },
  ]);
  return () => actionStore.set((ls) => ls.filter((l) => l.id !== id));
}

const pickWithin = (o: { within?: () => Element | null }): Pick<Layer, 'within'> =>
  o.within ? { within: o.within } : {};

/** Replaces a layer's actions where it stands, keeping its place in the stack. */
function replaceActions(id: number, actions: Action[]): void {
  reportDuplicates(actions);
  actionStore.set((ls) => ls.map((l) => (l.id === id ? { ...l, actions } : l)));
}

/**
 * Layers in the order they get a key, winner first: a panel holding the
 * focused element, then by rank, then the newest.
 */
export function ordered(layers: readonly Layer[], target?: EventTarget | null): Layer[] {
  const inside = (l: Layer): boolean => {
    const el = l.within?.();
    return !!el && typeof Node !== 'undefined' && target instanceof Node && el.contains(target);
  };
  return [...layers].sort(
    (a, b) => Number(inside(b)) - Number(inside(a)) || b.rank - a.rank || b.id - a.id,
  );
}

/**
 * Registers actions while the component is mounted. Pass a fresh array each
 * render freely: the latest closures are always used, and the layer keeps its
 * place in the stack when its actions change (a label that follows the undo
 * history, say), so a layer mounted first never jumps above later ones.
 */
export function useActions(
  actions: Action[],
  enabled = true,
  opts: { rank?: number; within?: RefObject<Element | null> } = {},
): void {
  const ref = useRef(actions);
  const layer = useRef<number | null>(null);
  const rank = opts.rank ?? RANK.view;
  const within = opts.within;
  useLayoutEffect(() => {
    ref.current = actions;
  });
  const signature = actions
    .map((a) => `${a.id}:${(a.keys ?? []).join(',')}:${a.label}:${a.hidden ? 1 : 0}`)
    .join('|');
  // Mount and unmount (or enable and disable): add the layer, remove it.
  useEffect(() => {
    if (!enabled) return undefined;
    const id = nextLayer++;
    layer.current = id;
    const l: Layer = { id, actions: [], rank, ...(within ? { within: () => within.current } : {}) };
    actionStore.set((ls) => [...ls, l]);
    return () => {
      layer.current = null;
      actionStore.set((ls) => ls.filter((x) => x.id !== id));
    };
  }, [enabled, rank, within]);
  // The actions themselves, replaced in place when they change.
  useEffect(() => {
    const id = layer.current;
    if (!enabled || id === null) return;
    const proxies: Action[] = ref.current.map((a, i) => ({
      ...a,
      run: () => ref.current[i]?.run(),
      enabled: () => ref.current[i]?.enabled?.() ?? true,
    }));
    replaceActions(id, proxies);
  }, [signature, enabled, rank, within]);
}

/** All actions, winning layer first, one per id. */
export function allActions(layers: Layer[] = actionStore.get()): Action[] {
  const seen = new Set<string>();
  const out: Action[] = [];
  for (const l of ordered(layers))
    for (const a of l.actions) {
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
  for (const l of ordered(actionStore.get(), e.target)) {
    for (const a of l.actions) {
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

/** One keyed action as the guide's key table lists it (docs/GUIDE.md, e2e/keys.spec.ts). */
export interface KeyRow {
  id: string;
  label: string;
  group: string;
  keys: string[];
  hidden: boolean;
}

/** Every action with keys in the layers mounted now, winning layer first. */
export const keyRows = (): KeyRow[] =>
  allActions()
    .filter((a) => (a.keys?.length ?? 0) > 0)
    .map((a) => ({
      id: a.id,
      label: a.label,
      group: a.group ?? '',
      keys: [...(a.keys ?? [])],
      hidden: a.hidden === true,
    }));

/** Installs the single window keydown listener. Called once by the shell. */
export function installKeymap(): () => void {
  const listener = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.isComposing) return;
    handleKey(e);
  };
  // Read-only: the key table in the guide is generated from what's registered.
  (window as unknown as { carbonKeyRows?: () => KeyRow[] }).carbonKeyRows = keyRows;
  window.addEventListener('keydown', listener);
  return () => window.removeEventListener('keydown', listener);
}
