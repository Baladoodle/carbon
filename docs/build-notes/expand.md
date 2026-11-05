# Build notes: `expand` (resizable panes, expandable text fields)

Branch `claude/blissful-einstein-8u27ty-expand`, from
`claude/blissful-einstein-8u27ty`. The base was merged in as I went (with
critique's Bench AI changes). Scope: the kit (`src/renderer/ui/`), the shell
layout, and small hooks in the views and the Bench. API spend: **$0.00**. I
used only the fake gateway.

- **Resizable panes:** §1
- **Expandable text fields:** §2
- **Keys and the guide:** §3
- **Shared files touched:** §4
- **Tests:** §5
- **Left out, and what's next:** §6

---

## 1. Resizable panes

### 1.1 The component

`ResizablePane` (`ui/ResizablePane.tsx`) wraps one panel element, and the
panel keeps its own scrolling. The pure rules are in `ui/pane.ts`:
`clampSize`, `dragSize`, `settle`, `stepSize`, `arrowDir`, `resolveMax`,
`parseSizes` and `withSize`. They are unit-tested.

```tsx
<ResizablePane id="numbers-side" edge="start" defaultSize={340} min={240}
               max={({ parent }) => parent * 0.6} label="Side panel width">
  <aside className="numbers-side">…</aside>
</ResizablePane>
```

- **The edge:** a 4px hit area (`role="separator"`, focusable) holds one
  hairline. The hairline is transparent at rest, `--text-3` on hover and
  `--accent` while dragging or focused. The cursor is `col-resize` (or
  `row-resize`), and it stays that way across the whole window while a drag
  runs. There is no visible label and no tooltip (VISUAL.md §1). The
  separator's accessible name is its only text.
- **Drag:** uses pointer capture. While the drag moves, only the wrapper's
  inline width changes, once a frame (`requestAnimationFrame`). React and the
  store see one change, when the drag ends. A release where the pointer
  didn't move writes nothing. That's what lets a double-click land.
- **Double-click on the edge, or `enter` on it:** goes back to the default.
  The stored size is dropped, so "default" follows the code if the default
  changes.
- **Keyboard on the focused edge:** the arrows move the edge itself, 16px a
  step, or 64px with `shift`. On a start edge (the Bench's left edge), `←`
  widens it. The keydown is stopped there, so a view's arrow keys don't also
  fire.
- **Palette:** "Widen panel" and "Narrow panel" (group Window, no key) step
  64px. They act on the pane that holds focus. Failing that, the pane focus
  was last in before the palette opened (a window-wide `focusin` listener
  tracks it, and ignores overlays). Failing that, the Bench, then the first
  pane mounted.
- **Limits:** `min` in px. `max` in px, or as a function of the window and of
  the pane's parent. The pane re-clamps when either changes: a window
  `resize` listener, and a `ResizeObserver` on the parent, because widening
  the Bench narrows a view's panes.
- **Collapse:** only panes that are given an `onCollapse` can collapse (today,
  only the Bench).
  - **By drag:** a drag that ends below half the minimum hides the pane.
    While the drag is past that point, the pane dims to 50%, so you can see
    what releasing will do.
  - **By keyboard:** narrowing by keyboard or the palette at the minimum hides
    it too.
  - **What's kept:** the stored size stays, so `b` brings the Bench back at
    the width it had.
  - **Other panes:** they stop at their minimum.

### 1.2 Where sizes live

The sizes are kept per machine in the renderer's `localStorage` under
`carbon.panes`. Electron keeps that store in `userData/Local Storage`. That's
the same place as the view and Bench state (`carbon.ui`), the Codex's column
widths and the Column's zoom.

The sizes never go in the world directory, the undo history or a file write.
The e2e test checks that `carbon.json` doesn't mention them.

I didn't add a userData `settings.json` channel. `settings.json` holds the
world's location and is main-side. The renderer's existing per-machine
preferences all use local storage, and this follows that precedent rather
than adding IPC for the same result.

### 1.3 Where it's applied

| Pane | Edge | Default | Min | Max |
|---|---|---|---|---|
| **Bench** (shell) | left | 360px | 300px | 60% of the window; collapses below 150px, as `b` does |
| **Numbers' side panel** (variables, attributes) | left | 340px | 240px | 60% of the view |
| **Spread detail** (the panel under the field) | top, `y` | its content (92–180px) | 64px | 60% of the view |
| **Taste: Rules column** | right, in the gap | its share (1.1 of 3.2) | 200px | 60% of the view |
| **Taste: Kill reasons column** | right, in the gap | its share (0.8 of 3.2) | 200px | 60% of the view |
| **Export: the list** (choose) | right | 360px | 240px | 60% of the view |

**Not applied:**

- **The AI log:** a centred overlay (`min(960px, 94vw)`), not a side panel.
- **The Codex:** no side panel. Its columns already resize from their header
  edges.
- **The formula editor's values gutter:** a column inside one editor, not a
  pane. See §6.

**Layout changes this needed:**

- The shell's grid is `rail | minmax(0, 1fr) | auto`. The Bench's wrapper
  sizes the last track, and `--bench-w` is gone.
- Numbers and Export changed their fixed track to `auto`.
- Taste changed from a three-track grid to flex. The columns keep their
  1.1 : 0.8 : 1.3 shares until you resize one, and then that column is fixed
  in px and the third takes the rest. Taste's edges sit in the middle of the
  12px gap (`--pane-edge-offset`).

### 1.4 The Column and the 2,000-entity budgets

The Column already measures its width with a `ResizeObserver`
(`column/view.tsx`), so it re-measures on every change of the Bench's width.

A drag moves the width once a frame, not once per pointer event. So a fast
drag costs at most one Column layout per frame. Nothing reads layout inside
the frame write except the wrapper's own `getBoundingClientRect` at drag
start, so there's no thrash.

`column.spec`'s 2,000-entity perf test and `SYSTEM.md` §9's budgets ran in
the full suites (§5), unchanged.

## 2. Expandable text fields

### 2.1 Textarea grows

The kit's `Textarea` grows with its content up to **40% of its pane** (the
closest `[data-pane]` or `.main`, else the window), then scrolls.

- **By hand:** dragging its corner (`resize: vertical`) still works. Once
  you size it by hand, that size wins from then on, for that element.
- **On a new element:** a new element starts over at its own size. A
  suggestion wrapping it is a new element, and so is the editor closing.

### 2.2 One field, made big: the design

`Input` and `Textarea` take `expandable`. It's on by default for a text-typed
`Input` and for every `Textarea`.

**Opening it:**

- **The button:** shown on hover and on focus, in the field's top-right
  corner. It's placed with CSS anchor positioning, so the field's DOM and
  layout don't change: no wrapper.
  - **Tooltip:** "Expand", with the key cap.
  - **Focus:** `tabIndex=-1`, so tab order doesn't change. A press on it
    doesn't take focus away from the field.
- **The key:** `ctrl+shift+e` (§3).

**What it opens:** a large editor overlay, centred, 720px wide (at most the
window less 32px), with the window dimmed behind it.

**The point of the design:** the overlay is **the same field**, not a copy
with its own state.

- **The swap:** opening swaps the control for a multi-line `<textarea>` in
  place, in the same component. The value, `onChange`, `onKeyDown`, the
  suggestion and the ref are the field's own.
- **The draft:** the Bench's `useTypedDraft` (`bench/draft.tsx`,
  `draft-state.ts`) is untouched and is the only draft. There is no parallel
  path.
- **The host:** if the field sits in a container marked `data-expand-host`,
  the whole container floats into the editor. That's the Bench's field row:
  its label, the `ai` marker, the AI proposal with Accept and Reject, the
  three alternatives, the error, and the **Keep mine / Use theirs** prompt.
  The kit's `Field` (label and error) is also a host.
  - **Its place:** a spacer keeps the host's place in its panel, so nothing
    below it jumps.
  - **Without a host:** the control alone floats (a Codex cell, the Spread
    direction), with a spacer of its size.
- **Keys still reach the Bench:** the editor stays inside the Bench's DOM, so
  the Bench's keys keep working with no change to `actions.ts`. That covers
  `tab` and `shift+tab`, `1`–`3` and `escape`. It works because the
  keymap's "focus inside this panel" rule and the Bench's `closest()` checks
  see the editor inside the field.
- **Uncontrolled inputs** (Taste's "New rule" and "New reason") expand too:
  the editor holds the text and hands it back on close.

**Focus between the field and its editor isn't leaving the field**
(`leavesField`, unit-tested):

- **The handoff:** the field's own `onFocus` and `onBlur` don't run when focus
  moves between the field and the editor, or within the editor (to its
  Accept button, or Keep mine).
- **Why it matters:** a Bench field commits on blur and a Codex cell cancels
  on blur. Opening the editor must do neither.
- **Leaving for real:** leaving the editor for somewhere else, such as
  tabbing out, is leaving the field. The editor closes, and the field's blur
  runs as always.

### 2.3 Commit rules, and what `esc` does

| In the editor | Does |
|---|---|
| `ctrl+enter` | **Commits and closes.** Runs the field's `onCommit`: the Bench's commit, or a Codex cell's commit. A field without one gets a blur, because fields commit when you leave them. Focus returns to the field |
| `esc` | **Closes and keeps the edit** as the field's draft, uncommitted. It commits the way the field always does: `enter`, or leaving it |
| `esc` while something waits for it | That goes first: an AI ghost suggestion, a proposal, three alternatives, the formula editor's completion list (`data-expand-esc`, or the kit's own ghost). The next `esc` closes |
| `enter`, one-line field | The field's own `enter` (the Bench commits; a Codex cell commits; a form submits), then closes. A name never gets a newline |
| `enter`, multi-line field | A line break, as in the field. A Codex long-text cell still commits on `enter`, its own rule |
| A click outside | Closes it, keeping the edit. The click goes no further, so one click never both closes the editor and presses a button behind it |
| `ctrl+shift+e` | Closes it, like `esc` |

**Why `esc` keeps the edit:** today `esc` in a Bench field leaves the field
(`bench.dismiss` blurs it), and leaving commits. So `esc` never throws typing
away in carbon's Bench.

**Why it doesn't commit either:** the editor is a level above the field, and
`esc` steps back one level, to the field with your text in it. A Codex cell
keeps its own rule one level down: `esc` there still cancels.

**Undo:** the editor adds no commands of its own. One commit is one undo
step, wherever it was typed.

**Suggestions inside the editor:**

- `tab` shows the AI's ghost in the editor, and the mirror scrolls with it.
  A second `tab` accepts it. That's one `entity.update` with
  `source: 'ai'`, so the `ai` marker shows in the editor.
- After an accept, `ctrl+enter` commits nothing more: the draft follows the
  store again. So the accept is the one undo step.
- `shift+tab` and `1`–`3` show and pick the three, inside the editor.

### 2.4 The formula editor

The formula editor expands **in place**. Its root is the host, so the
highlighting layer, the inline error marks, the values gutter, the problem
line and the completion list are the same elements, made 720px wide and
40–64vh tall.

- **Opening it:** `ctrl+shift+e` in the source, or the corner button.
- **Monospace and wrapping:** unchanged.
- **Keys:** completions still open as you type. `esc` closes the list first,
  then the editor. `ctrl+enter` commits now, without waiting for the 600ms
  pause.
- **Undo:** the editor's own `ctrl+z` (drop uncommitted typing) still
  applies.

### 2.5 What's expandable

**Every kit text field:**

- the Bench's name, identity, text and long-text fields, and route steps
- the Codex's inline cell editors (text and long text) and its filter
- Taste's new rule, rule edits and new reason
- Export's spec name and spec editor
- the Spread direction
- the Numbers curve formula
- the Numbers attribute `when` cell
- the formula editor (§2.4)

**Turned off (`expandable={false}`), because the values are short numbers or
ids, not text:**

- the Bench's number pairs (range, climate) and attribute values
- the Numbers variable name and value
- the curve x-range inputs
- the attribute number cells and the new-attribute key

**Never expands:** a field inside an overlay (the palette, a dialog, a
popover), so there's never an overlay over an overlay. Its button is hidden
and the key does nothing. That covers the state dialog's Why, the kill
reason, the AI budget dialog and the Column's lanes menu.

## 3. Keys and the guide

- **`ctrl+shift+e`:** `field.expand` "Expand the field", group Edit, shell
  rank, `inInputs`. It's enabled only while a field that can expand has
  focus, so outside a field the key is free for anything else. Before taking
  it, I checked that nothing in the registry binds it, and `e2e/keys.spec.ts`
  (one key per layer) passes.
- **`pane.widen` and `pane.narrow`:** palette only, with no key.
- **`docs/GUIDE.md`:** the key table was regenerated with `npm run
  guide:keys`, and I added one paragraph on resizing and expanding under the
  Bench.

## 4. Shared files touched

These are all additive.

- **`shell/App.tsx` and `shell.css`:** the Bench in a `ResizablePane`, the
  grid's third track `auto`, and three actions.
- **`bench/fields.tsx`:** `data-expand-host` on the field row,
  `data-expand-esc` on the proposal and the three, `onCommit` on text
  controls, and `expandable={false}` on number pairs.
- **`bench/Bench.tsx`:** attribute value input, `expandable={false}`.
- **`bench/bench.css`:** the expanded field's look.
- **Views, one hook each:**
  - **Numbers:** `view.tsx` (pane), `FormulaEditor.tsx` (expand),
    `Variables.tsx`, `Attributes.tsx` and `Curves.tsx` (opt-outs),
    `numbers.css`.
  - **Spread:** `view.tsx` (pane), `spread.css`.
  - **Taste:** `view.tsx` (panes), `taste.css`.
  - **Export:** `view.tsx` (pane), `export.css`.
  - **Codex:** `view.tsx` (`onCommit` on the cell editors).
- **Not touched:** `actions.ts`, `state/`, `ipc.ts` and `package.json`.

## 5. Tests

**Unit tests:**

- **`ui/pane.test.ts`:** limits, max resolution, drag direction, settle and
  collapse, keyboard steps and collapse at the minimum, the arrow mapping,
  and lenient reading and writing of the stored sizes.
- **`ui/expand.test.ts`:** the editor's keys (commit, close, `esc` waiting,
  `enter` by line mode, keys left alone), focus handoff (`leavesField`), and
  the `ctrl+shift+e` registry.

**`e2e/expand.spec.ts` (10 tests, 2 `@smoke`):**

- **Bench edge by mouse:** drag the edge, reload, and it's kept;
  double-click resets it.
- **Bench limits:** max 60% of the window, min 300px, and a drag far below
  hides it. `b` brings it back at its width.
- **Keyboard:** arrows 16px, `shift` 64px, and the palette's Narrow panel and
  Widen panel.
- **The views' panes:** Numbers, Taste, Export and Spread each resize, and
  nothing lands in `carbon.json`.
- **A Bench field:** expand with `ctrl+shift+e`, edit, `tab` to show the
  suggestion, `tab` to accept it (the `ai` marker shows), then `ctrl+enter`.
  The file has it, and one `ctrl+z` puts the original back.
- **Commit rules:** typing then `esc` keeps the draft uncommitted. Reopening
  and `ctrl+enter` commits. One undo.
- **A click outside:** closes the editor and doesn't switch the view.
- **The hover button:** it shows, and opens the editor.
- **The formula editor:** expanded, it keeps its marks, the problem line and
  completions. `esc` closes the list first, then the editor.
- **A long text:** grows with its content and stops at 40% of its pane.

**Full runs:** see the final summary in the last commit's message for the
two full passes of `npm run check` and `npm run test:e2e`.

## 6. Left out, and what's next

- **The formula editor's values gutter** (`minmax(120px, 34%)`) could take a
  `ResizablePane` too. It's a column inside one editor, under a scrolling
  body, so I left it.
- **A field in a dialog or popover doesn't expand** (§2.5). If the state
  dialog's Why ever needs it, the dialog itself could grow instead.
- **`ctrl+a` in any field still selects all Codex rows.** That's the Codex's
  `ctrl+a` action, and the keymap fires ctrl keys while you type. It's not
  new, and not mine to change. It's worth a look by whoever owns the keymap.
