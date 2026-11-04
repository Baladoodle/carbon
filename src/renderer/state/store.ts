import { useRef, useSyncExternalStore } from 'react';

/** A minimal external store: subscribe/get/set, used by every renderer store. */
export interface Store<T> {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      const value = typeof next === 'function' ? (next as (p: T) => T)(state) : next;
      if (Object.is(value, state)) return;
      state = value;
      for (const l of listeners) l();
    },
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

/**
 * Subscribes a component to a slice of a store. The selector may be an inline
 * closure (it can depend on props); the component re-renders only when the
 * slice changes (by `equal`, default `Object.is`), so selectors that build new
 * arrays or objects should pass `shallowEqual`.
 */
export function useStore<T, S>(
  store: Store<T>,
  selector: (state: T) => S,
  equal: (a: S, b: S) => boolean = Object.is,
): S {
  const memo = useRef<{ state: T; selector: (state: T) => S; slice: S } | null>(null);
  const getSlice = (): S => {
    const state = store.get();
    const m = memo.current;
    if (m && Object.is(m.state, state) && m.selector === selector) return m.slice;
    const slice = selector(state);
    // Keep the previous slice when it's equal, so React sees a stable value.
    const stable = m && equal(m.slice, slice) ? m.slice : slice;
    memo.current = { state, selector, slice: stable };
    return stable;
  };
  return useSyncExternalStore(store.subscribe, getSlice, getSlice);
}

/** Shallow equality for arrays and plain objects (handy for selectors returning lists). */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}
