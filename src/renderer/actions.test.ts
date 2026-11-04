import { describe, expect, it, vi } from 'vitest';
import { actionStore, allActions, handleKey, keyOf, registerActions } from './actions';

const ev = (
  key: string,
  mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {},
): KeyboardEvent =>
  ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    target: null,
    preventDefault: vi.fn(),
    ...mods,
  }) as unknown as KeyboardEvent;

describe('keyOf', () => {
  it('normalises keys and modifiers', () => {
    expect(keyOf(ev('k', { ctrlKey: true }))).toBe('ctrl+k');
    expect(keyOf(ev('Z', { ctrlKey: true, shiftKey: true }))).toBe('ctrl+shift+z');
    expect(keyOf(ev('?', { shiftKey: true }))).toBe('?');
    expect(keyOf(ev(' '))).toBe('space');
    expect(keyOf(ev('Tab', { shiftKey: true }))).toBe('shift+tab');
    expect(keyOf(ev('Esc'))).toBe('escape');
    expect(keyOf(ev('Shift', { shiftKey: true }))).toBe('shift');
    expect(keyOf(ev('ArrowUp', { altKey: true, metaKey: true }))).toBe('alt+meta+arrowup');
  });
});

describe('action layers', () => {
  it('lets the newest layer win a key and skips disabled actions', () => {
    const calls: string[] = [];
    const offShell = registerActions([
      { id: 'a', label: 'A', keys: ['1'], run: () => calls.push('shell-1') },
      { id: 'b', label: 'B', keys: ['2'], run: () => calls.push('shell-2') },
    ]);
    const offView = registerActions([
      { id: 'a', label: 'A2', keys: ['1'], run: () => calls.push('view-1') },
      { id: 'c', label: 'C', keys: ['2'], enabled: () => false, run: () => calls.push('view-2') },
    ]);
    const prevent = vi.fn();
    expect(handleKey(ev('1', {}, prevent))).toBe(true);
    expect(prevent).toHaveBeenCalled();
    handleKey(ev('2'));
    expect(handleKey(ev('3'))).toBe(false);
    expect(calls).toEqual(['view-1', 'shell-2']);
    expect(allActions().map((a) => `${a.id}:${a.label}`)).toEqual(['a:A2', 'c:C', 'b:B']);
    offView();
    handleKey(ev('1'));
    expect(calls.at(-1)).toBe('shell-1');
    offShell();
    expect(actionStore.get()).toEqual([]);
  });
});
