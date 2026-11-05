import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { cmd } from '@core/commands/registry';
import type { Entity } from '@core/model/entity';
import { uniqueId } from '@core/model/ids';
import { ENTITY_KINDS } from '@core/model/kinds';
import { schemaOf, type World } from '@core/model/world';
import { resolvePlacement, type Placements } from '@core/placement';
import { useActions } from '../../actions';
import { flash, focusEntity, setUi, startSpreadAt, useUi } from '../../state/ui';
import { currentWorld, dispatch, useWorld, whenRev } from '../../state/world';
import {
  Button,
  ContextMenu,
  type MenuEntry,
  Combobox,
  Input,
  Empty,
  Kbd,
  StateGlyph,
  Tabs,
  Textarea,
  Tooltip,
  cx,
} from '../../ui';
import { IconCodex } from '../../ui/icons';
import {
  canHave,
  imageMenu,
  KEYS as IMAGE_KEYS,
  requestBatch,
  requestImage,
} from '../../images/actions';
import { selected as selectedImage } from '../../images/model';
import { usePending } from '../../images/store';
import { Shimmer, Thumb, describe } from '../../images/Thumb';
import { defineView } from '../define';
import {
  columnsFor,
  commandForEdit,
  draftOf,
  sortEntities,
  visibleSelection,
  type Column,
} from './columns';
import { compileQuery, type QueryError } from './query';
import { StateDialog } from './StateDialog';
import {
  clampWidth,
  cycleSort,
  EMPTY_PREFS,
  parsePrefs,
  TABS,
  withWidth,
  type Prefs,
  type Tab,
} from './prefs';
import './codex.css';

/** Row height in px; fixed, so the table can be virtualised by arithmetic. */
export const ROW_H = 32;
const OVERSCAN = 8;

const PREFS_KEY = 'carbon.codex';
function loadPrefs(): Prefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return EMPTY_PREFS;
  }
}
/** How far `<` and `>` narrow and widen a column. */
const WIDTH_STEP = 24;

interface Editing {
  id: string;
  col: string;
  draft: string;
  error: string | null;
}

/** The filter input, with error spans underlined in place and the messages underneath. */
function FilterBar({
  value,
  onChange,
  errors,
  inputRef,
  onDone,
}: {
  value: string;
  onChange: (v: string) => void;
  errors: QueryError[];
  inputRef: React.RefObject<HTMLInputElement | null>;
  onDone: () => void;
}): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [i, e] of errors.entries()) {
    if (e.from < at) continue;
    parts.push(value.slice(at, e.from));
    parts.push(
      <span key={i} className="codex-err-span">
        {value.slice(e.from, Math.max(e.to, e.from + 1)) || ' '}
      </span>,
    );
    at = Math.max(e.to, e.from + 1);
  }
  parts.push(value.slice(at));
  return (
    <div className="codex-filter">
      <div className="codex-filter-box">
        <Input
          ref={inputRef}
          mono
          value={value}
          invalid={errors.length > 0}
          spellCheck={false}
          aria-label="Filter"
          // The syntax isn't guessable: an example, shown only while the filter is empty.
          placeholder='Filter: state:idea band:"Low Sky" lane:items'
          data-testid="codex-filter"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Escape') {
              e.preventDefault();
              if (e.key === 'Escape' && value !== '') onChange('');
              else onDone();
            }
          }}
        />
        {errors.length > 0 && (
          <div className="codex-filter-mirror mono" aria-hidden="true">
            {parts}
          </div>
        )}
      </div>
      {errors.length > 0 && (
        <ul className="codex-filter-errors" data-testid="codex-filter-errors" role="alert">
          {errors.map((e, i) => (
            <li key={i}>{e.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One editable cell's input. */
function CellEditor({
  column,
  entity,
  editing,
  world,
  onDraft,
  onCommit,
  onCancel,
}: {
  column: Column;
  entity: Entity;
  editing: Editing;
  world: World;
  onDraft: (d: string) => void;
  onCommit: (draft: string) => void;
  onCancel: () => void;
}): ReactNode {
  const edit = column.edit;
  const keys = (e: ReactKeyboardEvent): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      onCommit(editing.draft);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  if (edit?.type === 'enum' || edit?.type === 'ref') {
    const items =
      edit.type === 'enum'
        ? [{ value: '', label: '—' }, ...edit.options.map((o) => ({ value: o, label: o }))]
        : [
            { value: '', label: '—' },
            ...Object.values(world.entities)
              .filter((t) => edit.refKinds.length === 0 || edit.refKinds.includes(t.kind))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((t) => ({ value: t.id, label: t.name })),
          ];
    const current = draftOf(edit, entity);
    return (
      <div
        className="codex-editor"
        onKeyDown={(e) => {
          // The Combobox handles escape while its list is open; a second one cancels.
          if (e.key === 'Escape' && !e.defaultPrevented) {
            e.preventDefault();
            onCancel();
          }
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) onCancel();
        }}
      >
        <Combobox
          autoFocus
          items={items}
          value={current}
          aria-label={column.label}
          onChange={(v) => onCommit(v)}
        />
      </div>
    );
  }
  if (edit?.type === 'longtext')
    return (
      <Textarea
        autoFocus
        className="codex-editor codex-editor-long"
        rows={Math.min(6, Math.max(2, editing.draft.split('\n').length + 1))}
        value={editing.draft}
        invalid={editing.error !== null}
        title={editing.error ?? undefined}
        aria-label={column.label}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => onDraft(e.target.value)}
        onCommit={() => onCommit(editing.draft)}
        onKeyDown={(e) => {
          // Enter commits like every cell; shift+enter breaks the line.
          if (e.key === 'Enter' && e.shiftKey) return;
          keys(e);
        }}
        onBlur={onCancel}
      />
    );
  return (
    <Input
      autoFocus
      className="codex-editor"
      mono={column.mono}
      value={editing.draft}
      invalid={editing.error !== null}
      title={editing.error ?? undefined}
      aria-label={column.label}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => onDraft(e.target.value)}
      onCommit={() => onCommit(editing.draft)}
      onKeyDown={keys}
      onBlur={onCancel}
    />
  );
}

function CodexView(): ReactNode {
  const world = useWorld((w) => w, Object.is);
  // The tab, the filter, and each tab's sort and column widths, remembered (prefs.ts).
  const [prefs, setPrefs] = useState(loadPrefs);
  const { tab, query } = prefs;
  const setTab = (t: Tab): void => setPrefs((p) => ({ ...p, tab: t }));
  const setQueryRaw = (q: string): void => setPrefs((p) => ({ ...p, query: q }));
  const sort = prefs.sort[tab] ?? null;
  const toggleSort = (col: string): void => setPrefs((p) => cycleSort(p, tab, col));
  // A column being resized by its header edge: its live width. The pointer handlers read the
  // ref: pointer events can come faster than a render, and a stale read would drop the drag.
  type Resize = { col: string; x0: number; w0: number; w: number };
  const [resizing, setResizingState] = useState<Resize | null>(null);
  const resizeRef = useRef<Resize | null>(null);
  const setResizing = (r: Resize | null): void => {
    resizeRef.current = r;
    setResizingState(r);
  };
  const [cursor, setCursor] = useState<{ id: string | null; col: number }>({ id: null, col: 0 });
  const [anchor, setAnchor] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [stateDialog, setStateDialog] = useState<{ ids: string[]; preset?: 'decided' } | null>(
    null,
  );
  const selection = useUi((s) => s.selection);
  const focus = useUi((s) => s.focus);
  const filterRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 800 });

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // storage unavailable
    }
  }, [prefs]);

  const placements: Placements = useMemo(() => (world ? resolvePlacement(world) : {}), [world]);
  const compiled = useMemo(() => (world ? compileQuery(query, world) : null), [query, world]);
  const schema = world ? schemaOf(world) : null;

  /** Sets the query; `lane:items` or `kind:item` narrows to one kind, so the tab follows. */
  const setQuery = (v: string): void => {
    setQueryRaw(v);
    const w = currentWorld();
    const kinds = w ? compileQuery(v, w).kinds : null;
    if (kinds?.length === 1 && kinds[0]) setTab(kinds[0]);
  };
  const columns = useMemo(() => (schema ? columnsFor(tab, schema) : []), [tab, schema]);
  const widthOf = (c: Column): number =>
    resizing?.col === c.id ? resizing.w : (prefs.widths[tab]?.[c.id] ?? c.width);
  const ctx = useMemo(() => (world ? { world, placements } : null), [world, placements]);

  const matching = useMemo(() => {
    if (!world || !compiled) return [];
    return Object.values(world.entities).filter((e) =>
      compiled.match({ entity: e, placement: placements[e.id] }),
    );
  }, [world, compiled, placements]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: matching.length };
    for (const k of ENTITY_KINDS) c[k] = 0;
    for (const e of matching) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [matching]);

  const rows = useMemo(() => {
    if (!ctx) return [];
    const inTab = tab === 'all' ? matching : matching.filter((e) => e.kind === tab);
    return sortEntities(
      inTab,
      sort ? columns.find((c) => c.id === sort.col) : undefined,
      sort?.dir ?? 'asc',
      ctx,
    );
  }, [matching, tab, sort, columns, ctx]);

  const index = useMemo(() => new Map(rows.map((e, i) => [e.id, i])), [rows]);
  // A cursor that left the rows (filtered out, deleted) falls back to the first row.
  const cursorRow =
    cursor.id !== null && index.has(cursor.id)
      ? (index.get(cursor.id) ?? -1)
      : rows.length > 0 && cursor.id !== null
        ? 0
        : -1;
  const curEntity = cursorRow >= 0 ? rows[cursorRow] : undefined;
  const colIdx = Math.min(cursor.col, Math.max(columns.length - 1, 0));
  const curCol = columns[colIdx];

  // Keep the viewport measured, for virtualisation.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const measure = (): void => setViewport({ top: el.scrollTop, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const moveTo = useCallback(
    (i: number, extend = false) => {
      const e = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!e) return;
      setCursor((c) => ({ ...c, id: e.id }));
      focusEntity(e.id);
      if (extend) {
        const from = index.get(anchor ?? curEntity?.id ?? e.id) ?? 0;
        const to = index.get(e.id) ?? 0;
        const [a, b] = from <= to ? [from, to] : [to, from];
        setUi({ selection: rows.slice(a, b + 1).map((r) => r.id) });
        if (!anchor) setAnchor(curEntity?.id ?? e.id);
      } else setAnchor(e.id);
      // Scroll the row into view.
      const el = scrollRef.current;
      const at = (index.get(e.id) ?? 0) * ROW_H;
      const header = ROW_H;
      if (el) {
        if (at < el.scrollTop) el.scrollTop = at;
        else if (at + ROW_H + header > el.scrollTop + el.clientHeight)
          el.scrollTop = at + ROW_H + header - el.clientHeight;
      }
    },
    [rows, index, anchor, curEntity],
  );

  const toggle = (id: string): void => {
    const s = new Set(selection);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setUi({ selection: [...s] });
  };

  // Bulk actions reach the selected rows on screen; the filter's hidden ones wait.
  const { acting, hidden } = visibleSelection(selection, index);
  const targets = (): string[] => (acting.length > 0 ? acting : curEntity ? [curEntity.id] : []);

  const canIcon = (id: string): boolean => !!world && canHave(world, id, 'icon');
  // A row's menu: its image actions, and the batch over the selection it's part of.
  const rowMenu = (t: Element): MenuEntry[] | null => {
    const id = t.closest('[data-entity]')?.getAttribute('data-entity');
    if (!id || !world?.entities[id]) return null;
    const own = imageMenu(world, id);
    if (!(acting.length > 1 && acting.includes(id))) return own;
    const icons = acting.filter((x) => canIcon(x)).length;
    return [
      {
        label: `Generate concepts (${acting.length})`,
        onSelect: () => requestBatch(acting, 'concept'),
      },
      ...(icons > 0
        ? [{ label: `Generate icons (${icons})`, onSelect: () => requestBatch(acting, 'icon') }]
        : []),
      'separator',
      ...own,
    ];
  };

  const startEdit = (e: Entity | undefined, col: Column | undefined): void => {
    if (!e || !col?.edit) {
      if (e) focusEntity(e.id);
      return;
    }
    if (col.edit.type === 'boolean') {
      const c = commandForEdit(col.edit, e, '');
      if (c.ok) void dispatch(c.value).then((r) => !r.ok && flash(r.error.message, 'error'));
      return;
    }
    setEditing({ id: e.id, col: col.id, draft: draftOf(col.edit, e), error: null });
  };

  const commit = async (draft: string): Promise<void> => {
    if (!editing) return;
    const e = world?.entities[editing.id];
    const col = columns.find((c) => c.id === editing.col);
    if (!e || !col?.edit) return setEditing(null);
    if (draft === draftOf(col.edit, e)) return setEditing(null);
    const c = commandForEdit(col.edit, e, draft);
    if (!c.ok) {
      setEditing({ ...editing, draft, error: c.error.message });
      flash(c.error.message, 'error');
      return;
    }
    const r = await dispatch(c.value);
    if (!r.ok) {
      setEditing({ ...editing, draft, error: r.error.message });
      flash(r.error.message, 'error');
      return;
    }
    setEditing(null);
  };

  const createHere = async (): Promise<void> => {
    const w = currentWorld();
    if (!w || tab === 'all' || !schema) return;
    const name = `New ${schema.kinds[tab].label.toLowerCase()}`;
    const id = uniqueId(name, (c) => c in w.entities);
    const r = await dispatch(cmd('entity.create', { kind: tab, name, id }));
    if (!r.ok) return flash(r.error.message, 'error');
    // The cursor and the editor go to the new row once the mirror has it.
    await whenRev(r.rev);
    if (compiled && !compiled.empty) setQuery('');
    setCursor({ id, col: 0 });
    focusEntity(id);
    setEditing({ id, col: 'name', draft: name, error: null });
  };

  const pin = async (unpin: boolean): Promise<void> => {
    if (!curEntity) return;
    const r = await dispatch(
      cmd(unpin ? 'placement.unpin' : 'placement.pin', { id: curEntity.id }),
    );
    if (!r.ok) flash(r.error.message, 'error');
  };

  const switchTab = (d: 1 | -1): void => {
    const i = TABS.indexOf(tab);
    const next = TABS[(i + d + TABS.length) % TABS.length];
    if (next) setTab(next);
  };

  const idle = (): boolean => editing === null && stateDialog === null;
  useActions([
    {
      id: 'codex.down',
      label: 'Next row',
      keys: ['j', 'arrowdown'],
      hidden: true,
      enabled: idle,
      run: () => moveTo(cursorRow + 1),
    },
    {
      id: 'codex.up',
      label: 'Previous row',
      keys: ['k', 'arrowup'],
      hidden: true,
      enabled: idle,
      run: () => moveTo(cursorRow - 1),
    },
    {
      id: 'codex.extend-down',
      label: 'Extend selection down',
      keys: ['shift+j', 'shift+arrowdown'],
      hidden: true,
      enabled: idle,
      run: () => moveTo(cursorRow + 1, true),
    },
    {
      id: 'codex.extend-up',
      label: 'Extend selection up',
      keys: ['shift+k', 'shift+arrowup'],
      hidden: true,
      enabled: idle,
      run: () => moveTo(cursorRow - 1, true),
    },
    {
      id: 'codex.top',
      label: 'First row',
      keys: ['g', 'home'],
      hidden: true,
      enabled: idle,
      run: () => moveTo(0),
    },
    {
      id: 'codex.bottom',
      label: 'Last row',
      keys: ['shift+g', 'end'],
      hidden: true,
      enabled: idle,
      run: () => moveTo(rows.length - 1),
    },
    {
      id: 'codex.left',
      label: 'Previous column',
      keys: ['h', 'arrowleft'],
      hidden: true,
      enabled: idle,
      run: () => setCursor((c) => ({ ...c, col: Math.max(0, colIdx - 1) })),
    },
    {
      id: 'codex.right',
      label: 'Next column',
      keys: ['l', 'arrowright'],
      hidden: true,
      enabled: idle,
      run: () => setCursor((c) => ({ ...c, col: Math.min(columns.length - 1, colIdx + 1) })),
    },
    {
      id: 'codex.prev-tab',
      label: 'Previous kind',
      group: 'Codex',
      keys: ['['],
      enabled: idle,
      run: () => switchTab(-1),
    },
    {
      id: 'codex.next-tab',
      label: 'Next kind',
      group: 'Codex',
      keys: [']'],
      enabled: idle,
      run: () => switchTab(1),
    },
    {
      id: 'codex.edit',
      label: 'Edit cell',
      group: 'Codex',
      keys: ['enter'],
      enabled: () => idle() && !!curEntity,
      run: () => startEdit(curEntity, curCol),
    },
    {
      id: 'codex.select',
      label: 'Select row',
      group: 'Codex',
      keys: ['x'],
      enabled: () => idle() && !!curEntity,
      run: () => curEntity && toggle(curEntity.id),
    },
    // Images on the rows the filter shows (the shell's keys would also reach hidden ones).
    {
      id: 'codex.images.concept',
      label:
        acting.length > 1
          ? `Generate concepts (${acting.length})`
          : curEntity
            ? `Generate concept: ${curEntity.name}`
            : 'Generate concept',
      group: 'Images',
      keys: [IMAGE_KEYS.concept],
      enabled: () => idle() && targets().length > 0,
      run: () => {
        const t = targets();
        if (t.length > 1) requestBatch(t, 'concept');
        else if (t[0]) requestImage(t[0], 'concept');
      },
    },
    {
      id: 'codex.images.icon',
      label:
        acting.length > 1
          ? `Generate icons (${acting.filter((id) => canIcon(id)).length})`
          : curEntity
            ? `Generate icon: ${curEntity.name}`
            : 'Generate icon',
      group: 'Images',
      keys: [IMAGE_KEYS.icon],
      enabled: () => idle() && targets().some((id) => canIcon(id)),
      run: () => {
        const t = targets();
        if (t.length > 1) requestBatch(t, 'icon');
        else if (t[0]) requestImage(t[0], 'icon');
      },
    },
    {
      id: 'codex.select-all',
      label: 'Select all rows',
      group: 'Codex',
      keys: ['ctrl+a'],
      enabled: idle,
      run: () => setUi({ selection: rows.map((r) => r.id) }),
    },
    {
      id: 'codex.clear',
      label: 'Clear selection',
      keys: ['escape'],
      hidden: true,
      enabled: () => idle() && selection.length > 0,
      run: () => setUi({ selection: [] }),
    },
    {
      id: 'codex.filter',
      label: 'Filter',
      group: 'Codex',
      keys: ['/'],
      enabled: idle,
      run: () => filterRef.current?.focus(),
    },
    {
      id: 'codex.sort',
      label: 'Sort by column',
      group: 'Codex',
      keys: ['o'],
      enabled: () => idle() && !!curCol,
      run: () => curCol && toggleSort(curCol.id),
    },
    {
      id: 'codex.widen',
      label: 'Widen column',
      group: 'Codex',
      keys: ['>'],
      enabled: () => idle() && !!curCol,
      run: () =>
        curCol && setPrefs((p) => withWidth(p, tab, curCol.id, widthOf(curCol) + WIDTH_STEP)),
    },
    {
      id: 'codex.narrow',
      label: 'Narrow column',
      group: 'Codex',
      keys: ['<'],
      enabled: () => idle() && !!curCol,
      run: () =>
        curCol && setPrefs((p) => withWidth(p, tab, curCol.id, widthOf(curCol) - WIDTH_STEP)),
    },
    {
      id: 'codex.width-reset',
      label: 'Reset column width',
      group: 'Codex',
      enabled: () => idle() && !!curCol && prefs.widths[tab]?.[curCol.id] !== undefined,
      run: () => curCol && setPrefs((p) => withWidth(p, tab, curCol.id, null)),
    },
    {
      id: 'codex.state',
      label: 'Set state',
      group: 'Codex',
      keys: ['s'],
      enabled: () => idle() && targets().length > 0,
      run: () => setStateDialog({ ids: targets() }),
    },
    {
      id: 'codex.decide',
      label: 'Mark decided',
      group: 'Codex',
      keys: ['d'],
      enabled: () => idle() && targets().length > 0,
      run: () => setStateDialog({ ids: targets(), preset: 'decided' }),
    },
    {
      id: 'codex.new',
      label: 'New entity',
      group: 'Codex',
      keys: ['n'],
      enabled: () => idle() && tab !== 'all',
      run: () => void createHere(),
    },
    {
      id: 'codex.pin',
      label: 'Pin placement',
      group: 'Codex',
      keys: ['p'],
      enabled: () => idle() && placements[curEntity?.id ?? '']?.mode === 'inferred',
      run: () => void pin(false),
    },
    {
      id: 'codex.unpin',
      label: 'Unpin placement',
      group: 'Codex',
      keys: ['shift+p'],
      enabled: () => idle() && placements[curEntity?.id ?? '']?.reason === 'pin.relation',
      run: () => void pin(true),
    },
    {
      id: 'codex.spread',
      label: 'Spread over selection',
      group: 'Codex',
      keys: ['space'],
      enabled: () => idle() && targets().length > 0,
      run: () => {
        const ids = targets();
        const first = ids[0];
        if (!first) return;
        startSpreadAt(
          ids.length === 1
            ? { type: 'entity', entity: first }
            : { type: 'selection', entities: ids },
        );
      },
    },
  ]);

  const clickRow = (e: Entity, ev: ReactMouseEvent, col: number): void => {
    if (ev.shiftKey) {
      const from = index.get(anchor ?? curEntity?.id ?? e.id) ?? 0;
      const to = index.get(e.id) ?? 0;
      const [a, b] = from <= to ? [from, to] : [to, from];
      setUi({ selection: rows.slice(a, b + 1).map((r) => r.id) });
    } else if (ev.ctrlKey || ev.metaKey) {
      toggle(e.id);
      setAnchor(e.id);
    } else setAnchor(e.id);
    setCursor({ id: e.id, col });
    focusEntity(e.id);
  };

  if (!world || !schema || !ctx || !compiled) return <div className="view-empty" />;

  const first = Math.max(0, Math.floor(viewport.top / ROW_H) - OVERSCAN);
  const last = Math.min(
    rows.length,
    Math.ceil((viewport.top + viewport.height) / ROW_H) + OVERSCAN,
  );
  const width = 28 + 28 + IMG_W + columns.reduce((s, c) => s + widthOf(c), 0);
  const selected = new Set(selection);

  return (
    <div className="codex" data-testid="codex">
      <div className="codex-top">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as Tab)}
          aria-label="Kind"
          focusAfterClick={scrollRef}
          tabs={TABS.map((t) => ({
            value: t,
            label: t === 'all' ? 'All' : schema.kinds[t].plural,
            count: counts[t] ?? 0,
          }))}
        />
        <FilterBar
          value={query}
          onChange={setQuery}
          errors={compiled.errors}
          inputRef={filterRef}
          onDone={() => {
            filterRef.current?.blur();
            if (!curEntity) moveTo(0);
          }}
        />
        {selection.length > 0 && (
          <div className="codex-selection" data-testid="codex-selection">
            {acting.length > 0 && (
              <>
                <span className="num">{acting.length}</span>
                <Tooltip content="Set state" keys="s">
                  <Button variant="ghost" size="sm" onClick={() => setStateDialog({ ids: acting })}>
                    State…
                  </Button>
                </Tooltip>
              </>
            )}
            {acting.length > 0 && (
              <>
                <Tooltip content={`Generate concepts (${acting.length})`} keys={IMAGE_KEYS.concept}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => requestBatch(acting, 'concept')}
                    data-testid="codex-bulk-concepts"
                  >
                    Concepts…
                  </Button>
                </Tooltip>
                {acting.some((id) => canIcon(id)) && (
                  <Tooltip
                    content={`Generate icons (${acting.filter((id) => canIcon(id)).length})`}
                    keys={IMAGE_KEYS.icon}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => requestBatch(acting, 'icon')}
                      data-testid="codex-bulk-icons"
                    >
                      Icons…
                    </Button>
                  </Tooltip>
                )}
              </>
            )}
            {hidden > 0 && (
              <Tooltip content="Selected, but not shown: bulk actions skip them">
                <span className="codex-selection-hidden num" data-testid="codex-selection-hidden">
                  {hidden} hidden
                </span>
              </Tooltip>
            )}
            <Tooltip content="Clear selection" keys="esc">
              <Button variant="ghost" size="sm" onClick={() => setUi({ selection: [] })}>
                Clear
              </Button>
            </Tooltip>
          </div>
        )}
      </div>
      <ContextMenu itemsAt={rowMenu}>
        <div
          className="codex-scroll"
          ref={scrollRef}
          tabIndex={-1}
          data-testid="codex-scroll"
          onScroll={(e) =>
            setViewport({ top: e.currentTarget.scrollTop, height: e.currentTarget.clientHeight })
          }
        >
          {rows.length === 0 ? (
            <Empty className="codex-empty" data-testid="codex-empty">
              {compiled.empty ? (
                tab === 'all' ? (
                  <>
                    No entities yet. <Kbd>1</Kbd> to start on the Column.
                  </>
                ) : (
                  <>
                    No {schema.kinds[tab].plural.toLowerCase()} yet. <Kbd>n</Kbd> to add one.
                  </>
                )
              ) : (
                'Nothing matches.'
              )}
            </Empty>
          ) : (
            <table
              className="ui-table codex-table"
              style={{ width }}
              data-testid="codex-table"
              aria-rowcount={rows.length}
            >
              <colgroup>
                <col style={{ width: 28 }} />
                <col style={{ width: 28 }} />
                <col style={{ width: IMG_W }} />
                {columns.map((c) => (
                  <col key={c.id} style={{ width: widthOf(c) }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="selected" />
                  <th aria-label="state" />
                  <th aria-label="image" />
                  {columns.map((c, i) => (
                    <th
                      key={c.id}
                      className={cx(
                        c.numeric && 'ui-num',
                        'codex-th',
                        i === colIdx && 'codex-th-current',
                      )}
                      aria-sort={
                        sort?.col === c.id
                          ? sort.dir === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : undefined
                      }
                      onClick={() => toggleSort(c.id)}
                      data-col={c.id}
                    >
                      {c.label}
                      {sort?.col === c.id && (
                        <span className="codex-sort">{sort.dir === 'asc' ? '↑' : '↓'}</span>
                      )}
                      {/* Drag to resize; double-click for the default width. */}
                      <span
                        className="codex-resize"
                        data-resizing={resizing?.col === c.id ? '' : undefined}
                        aria-hidden="true"
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          setPrefs((p) => withWidth(p, tab, c.id, null));
                        }}
                        onPointerDown={(e) => {
                          if (e.button !== 0) return;
                          e.stopPropagation();
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          const w0 = widthOf(c);
                          setResizing({ col: c.id, x0: e.clientX, w0, w: w0 });
                        }}
                        onPointerMove={(e) => {
                          const r = resizeRef.current;
                          if (r?.col !== c.id) return;
                          const w = clampWidth(r.w0 + e.clientX - r.x0);
                          if (w !== r.w) setResizing({ ...r, w });
                        }}
                        onPointerUp={(e) => {
                          const r = resizeRef.current;
                          if (r?.col !== c.id) return;
                          // Where the pointer let go, not the last move that happened to render.
                          const w = clampWidth(r.w0 + e.clientX - r.x0);
                          setResizing(null);
                          if (w !== r.w0) setPrefs((p) => withWidth(p, tab, c.id, w));
                        }}
                        onPointerCancel={() => setResizing(null)}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {first > 0 && <tr aria-hidden="true" style={{ height: first * ROW_H }} />}
                {rows.slice(first, last).map((e) => {
                  const isSel = selected.has(e.id);
                  const isCur = e.id === curEntity?.id;
                  return (
                    <tr
                      key={e.id}
                      data-entity={e.id}
                      data-selected={isSel ? '' : undefined}
                      data-current={isCur ? '' : undefined}
                      data-focus={e.id === focus ? '' : undefined}
                      aria-selected={isSel}
                      className="codex-row"
                    >
                      <td className="codex-check" onClick={() => toggle(e.id)}>
                        <span className={cx('codex-box', isSel && 'codex-box-on')} />
                      </td>
                      <td onClick={(ev) => clickRow(e, ev, 0)}>
                        <StateGlyph state={e.state} />
                      </td>
                      <td className="codex-img" onClick={(ev) => clickRow(e, ev, 0)}>
                        <RowImage world={world} id={e.id} />
                      </td>
                      {columns.map((c, i) => {
                        const isEditing = editing?.id === e.id && editing.col === c.id;
                        return (
                          <td
                            key={c.id}
                            className={cx(
                              c.numeric && 'ui-num',
                              c.mono && 'mono',
                              c.dim?.(e, ctx) && 't-3',
                              isCur && i === colIdx && 'codex-cell-current',
                              isEditing && 'codex-cell-editing',
                              e.ai_fields.includes(
                                c.id.replace(/^[fa]:/, (m) => (m === 'a:' ? 'attributes.' : '')),
                              ) && 'codex-ai',
                              e.agent_fields?.includes(
                                c.id.replace(/^[fa]:/, (m) => (m === 'a:' ? 'attributes.' : '')),
                              ) && 'codex-agent',
                            )}
                            data-col={c.id}
                            onClick={(ev) => clickRow(e, ev, i)}
                            onDoubleClick={() => startEdit(e, c)}
                          >
                            {isEditing ? (
                              <CellEditor
                                column={c}
                                entity={e}
                                editing={editing}
                                world={world}
                                onDraft={(d) => setEditing({ ...editing, draft: d, error: null })}
                                onCommit={(d) => void commit(d)}
                                onCancel={() => setEditing(null)}
                              />
                            ) : (
                              c.text(e, ctx)
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {last < rows.length && (
                  <tr aria-hidden="true" style={{ height: (rows.length - last) * ROW_H }} />
                )}
              </tbody>
            </table>
          )}
        </div>
      </ContextMenu>
      {stateDialog && (
        <StateDialog
          ids={stateDialog.ids}
          {...(stateDialog.preset ? { preset: stateDialog.preset } : {})}
          onClose={() => setStateDialog(null)}
        />
      )}
    </div>
  );
}

export default defineView({
  id: 'codex',
  label: 'Codex',
  key: '3',
  order: 3,
  icon: IconCodex,
  component: CodexView,
});

const IMG_W = 34;

/** The Codex's image cell: the icon (pixelated), else a concept thumbnail. */
function RowImage({ world, id }: { world: World; id: string }): ReactNode {
  const icon = selectedImage(world, id, 'icon');
  const concept = selectedImage(world, id, 'concept');
  const pending = usePending(id, icon || !concept ? 'icon' : 'concept');
  const pendingConcept = usePending(id, 'concept');
  if (pending || (pendingConcept && !icon)) return <Shimmer className="codex-img-thumb" />;
  const m = icon ?? concept;
  if (!m) return null;
  return <Thumb meta={m} className="codex-img-thumb" title={describe(m)} testId="codex-image" />;
}
