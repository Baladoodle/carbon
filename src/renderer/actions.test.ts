import { describe, expect, it, vi } from 'vitest';
import {
  actionStore,
  allActions,
  handleKey,
  keyOf,
  RANK,
  registerActions,
  duplicateKeys,
  type Action,
} from './actions';

type Mods = Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>>;
const ev = (key: string, mods: Mods = {}, preventDefault: () => void = vi.fn()): KeyboardEvent =>
  ({
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    target: null,
    preventDefault,
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

describe('duplicate keys within a layer', () => {
  const a = (id: string, keys: string[]): Action => ({ id, label: id, keys, run: () => {} });

  it('finds keys bound by two actions of one layer, and only those', () => {
    expect(duplicateKeys([a('x.one', ['j', 'arrowdown']), a('x.two', ['k'])])).toEqual([]);
    expect(
      duplicateKeys([a('x.one', ['j', 'd']), a('x.two', ['d']), a('x.three', ['j', 'j'])]),
    ).toEqual([
      { key: 'd', ids: ['x.one', 'x.two'] },
      { key: 'j', ids: ['x.one', 'x.three'] },
    ]);
  });

  it('reports them when a layer registers', () => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => void errors.push(m);
    try {
      const off = registerActions([a('y.one', ['n']), a('y.two', ['n'])]);
      off();
    } finally {
      console.error = orig;
    }
    expect(errors).toEqual(['carbon: duplicate key "n" in one layer: y.one, y.two']);
  });
});

describe('which layer wins a key', () => {
  const act = (id: string, key: string, ran: string[]): Action => ({
    id,
    label: id,
    keys: [key],
    run: () => void ran.push(id),
  });

  it('views beat the Bench, the Bench beats the shell, whatever the mount order', () => {
    const ran: string[] = [];
    const offView = registerActions([act('view.draft', 'ctrl+enter', ran)], { rank: RANK.view });
    const offBench = registerActions([act('bench.fill', 'ctrl+enter', ran)], { rank: RANK.panel });
    const offShell = registerActions([act('shell.x', 'ctrl+enter', ran)], { rank: RANK.shell });
    handleKey(ev('Enter', { ctrlKey: true }));
    offView();
    handleKey(ev('Enter', { ctrlKey: true }));
    offBench();
    handleKey(ev('Enter', { ctrlKey: true }));
    offShell();
    expect(ran).toEqual(['view.draft', 'bench.fill', 'shell.x']);
  });

  it('a panel wins while focus is inside it', () => {
    const ran: string[] = [];
    const inside = { id: 'inside' };
    const panel = { contains: (n: unknown) => n === inside } as unknown as Element;
    const g = globalThis as { Node?: unknown };
    const hadNode = 'Node' in g;
    if (!hadNode) g.Node = Object;
    try {
      const offView = registerActions([act('view.save', 'ctrl+s', ran)], { rank: RANK.view });
      const offBench = registerActions([act('bench.save', 'ctrl+s', ran)], {
        rank: RANK.panel,
        within: () => panel,
      });
      handleKey(Object.assign(ev('s', { ctrlKey: true }), { target: inside }));
      handleKey(ev('s', { ctrlKey: true }));
      offView();
      offBench();
    } finally {
      if (!hadNode) delete g.Node;
    }
    expect(ran).toEqual(['bench.save', 'view.save']);
  });
});
