import { describe, expect, it } from 'vitest';
import {
  blurExpander,
  canToggleFocused,
  editorKey,
  focusExpander,
  leavesField,
  toggleFocused,
  type Expander,
  type KeyLike,
} from './expand';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
const line = { multiline: false, waiting: false };
const area = { multiline: true, waiting: false };

describe('the large editor’s keys', () => {
  it('ctrl+enter commits and closes; esc closes, keeping the edit', () => {
    expect(editorKey(key('Enter', { ctrlKey: true }), area)).toBe('commit');
    expect(editorKey(key('Enter', { metaKey: true }), line)).toBe('commit');
    expect(editorKey(key('Escape'), area)).toBe('close');
    expect(editorKey(key('Escape', { shiftKey: true }), line)).toBe('close');
  });

  it('esc goes first to what waits for it (a suggestion, three, completions)', () => {
    expect(editorKey(key('Escape'), { multiline: true, waiting: true })).toBeNull();
    expect(editorKey(key('Enter', { ctrlKey: true }), { multiline: true, waiting: true })).toBe(
      'commit',
    );
  });

  it('enter is the field’s own enter on one line, and a line break in a multi-line field', () => {
    expect(editorKey(key('Enter'), line)).toBe('enter');
    expect(editorKey(key('Enter', { shiftKey: true }), line)).toBe('enter');
    expect(editorKey(key('Enter'), area)).toBeNull();
    expect(editorKey(key('Enter', { altKey: true }), line)).toBeNull();
  });

  it('leaves every other key to the field and the keymap (tab, shift+tab, ctrl+shift+e)', () => {
    expect(editorKey(key('Tab'), line)).toBeNull();
    expect(editorKey(key('Tab', { shiftKey: true }), area)).toBeNull();
    expect(editorKey(key('E', { ctrlKey: true, shiftKey: true }), area)).toBeNull();
    expect(editorKey(key('Enter', { ctrlKey: true, shiftKey: true }), area)).toBeNull();
    expect(editorKey(key('a'), line)).toBeNull();
  });
});

describe('focus between a field and its editor', () => {
  // A tiny stand-in for DOM containment.
  const node = (kids: object[] = []): Node =>
    ({ contains: (n: unknown) => n === self || kids.includes(n as object) }) as unknown as Node;
  const inside = {} as Node;
  const editor = node([inside]);
  const self = editor;

  it('the handoff, and moving within the editor, are not leaving the field', () => {
    expect(leavesField({ handoff: true, next: null, editor: null })).toBe(false);
    expect(leavesField({ handoff: false, next: inside, editor })).toBe(false);
  });

  it('focus going anywhere else is leaving it (its own blur runs: commit, or a Codex cancel)', () => {
    expect(leavesField({ handoff: false, next: {} as Node, editor })).toBe(true);
    expect(leavesField({ handoff: false, next: null, editor })).toBe(true);
    expect(leavesField({ handoff: false, next: inside, editor: null })).toBe(true);
  });
});

describe('ctrl+shift+e', () => {
  it('toggles the focused field, and nothing once it has lost focus', () => {
    let open = false;
    const x: Expander = { toggle: () => (open = !open), expanded: () => open };
    expect(canToggleFocused()).toBe(false);
    expect(toggleFocused()).toBe(false);
    focusExpander(x);
    expect(canToggleFocused()).toBe(true);
    expect(toggleFocused()).toBe(true);
    expect(open).toBe(true);
    toggleFocused();
    expect(open).toBe(false);
    // Another field's blur doesn't clear this one.
    blurExpander({ toggle: () => undefined, expanded: () => false });
    expect(canToggleFocused()).toBe(true);
    blurExpander(x);
    expect(canToggleFocused()).toBe(false);
  });
});
