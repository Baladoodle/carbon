import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import { cmd } from '@core/commands/registry';
import type { Spot } from '@core/ai/moments';
import { uniqueId } from '@core/model/ids';
import { ENTITY_KINDS, LANE_OF_KIND, type EntityKind, type Lane } from '@core/model/kinds';
import { getEntity, schemaOf, type World } from '@core/model/world';
import { useActions, type Action } from '../../actions';
import { requestFieldFocus } from '../../bench/store';
import { useNotes } from '../../state/notes';
import { flash, focusEntity, startSpread, uiStore, useUi } from '../../state/ui';
import { currentWorld, transact, useWorld } from '../../state/world';
import { Kbd } from '../../ui';
import { IconColumn } from '../../ui/icons';
import { defineView } from '../define';
import { at, normalize, side, step, type Cursor } from './cursor';
import {
  clampEdge,
  createBandCommand,
  drawnBandSpan,
  edgeKey,
  edgeLimits,
  edgesOf,
  moveEdgeCommands,
  newBandSpan,
  nudge,
} from './edges';
import {
  BandLabels,
  Cell,
  CursorMark,
  Defs,
  DrawPreview,
  Grid,
  Ruler,
  RowsLayer,
  yAtPx,
} from './Layers';
import { columnSettings, moveLane } from './lanes';
import { LanesMenu, useLaneActions } from './LanesMenu';
import { cellKey, INBOX_ROW, pxOfU, pxOfY, uOfPx, type BandSpan, type Rect } from './layout';
import { Margin } from './Margin';
import { measureChip, measureNote, resetMeasures } from './measure';
import {
  columnModel,
  geometry,
  HEAD_H,
  inboxHasEntities,
  LABEL_W,
  locate,
  navContext,
  RULER_W,
  type ColumnModel,
  type Geometry,
} from './model';
import { placementOf } from './placement';
import { clampZoom, columnStore, setColumn, useColumn } from './store';
import './column.css';

const KIND_OF_LANE = Object.fromEntries(
  ENTITY_KINDS.filter((k) => LANE_OF_KIND[k] !== null).map((k) => [LANE_OF_KIND[k], k]),
) as Record<Lane, EntityKind>;

const OVERSCAN = 800;
const ZOOM_STEP = 1.25;

const typing = (): boolean => {
  const a = document.activeElement;
  return (
    a instanceof HTMLElement &&
    (a.isContentEditable ||
      a.tagName === 'INPUT' ||
      a.tagName === 'TEXTAREA' ||
      a.tagName === 'SELECT')
  );
};

/** The row key holding Y 0 (or the nearest row). */
function rowAtY(model: ColumnModel, y: number): string {
  const r = model.rows.find((x) => y <= x.top && y >= x.bottom);
  return r?.key ?? model.rows[0]?.key ?? INBOX_ROW;
}

/** Bands with a live edge drag applied. */
function draggedBands(
  bands: BandSpan[],
  drag: { key: string; y: number } | null,
): BandSpan[] | undefined {
  if (!drag) return undefined;
  const edge = edgesOf(bands).find((e) => edgeKey(e) === drag.key);
  if (!edge) return undefined;
  return bands.map((b) =>
    b.id === edge.below
      ? { ...b, top: drag.y }
      : b.id === edge.above
        ? { ...b, bottom: drag.y }
        : b,
  );
}

/** The rect to highlight (and keep in view) for a cursor. */
function cursorRect(
  geo: Geometry,
  model: ColumnModel,
  c: Cursor,
): { cell: Rect | null; focus: Rect | null; inbox: boolean } {
  if (c.row === INBOX_ROW) {
    const lane = model.lanes[c.lane];
    const box =
      c.lane < 0
        ? geo.inbox?.bands
        : lane
          ? geo.inbox?.cells.get(cellKey(INBOX_ROW, lane))
          : undefined;
    const rect =
      box?.rect ??
      (c.lane < 0
        ? { x: RULER_W, y: 0, w: LABEL_W, h: geo.inbox?.height ?? 32 }
        : { x: geo.laneX[c.lane] ?? 0, y: 0, w: geo.laneW, h: geo.inbox?.height ?? 32 });
    return { cell: rect, focus: null, inbox: true };
  }
  const row = geo.rows.find((r) => r.row.key === c.row);
  if (!row) return { cell: null, focus: null, inbox: false };
  const x = c.lane < 0 ? RULER_W : (geo.laneX[c.lane] ?? 0);
  const w = c.lane < 0 ? LABEL_W : geo.laneW;
  const cell = { x, y: row.top, w, h: row.bottom - row.top };
  const g =
    c.entity && c.lane >= 0
      ? geo.glyphsOf
          .get(c.entity)
          ?.find((x0) => x0.x >= x && x0.x < x + w && x0.y >= row.top && x0.y <= row.bottom)
      : undefined;
  const lane = model.lanes[c.lane];
  const more = lane ? geo.cells.get(cellKey(c.row, lane))?.more : null;
  // Keep a useful part of tall cells in view: the glyph, the +N chip, or the edge they align to.
  const band = row.row.kind === 'band' ? row.row.band : null;
  const fromBottom = band !== null && band.top === Infinity && Number.isFinite(band.bottom);
  const edge = fromBottom
    ? { ...cell, y: cell.y + Math.max(0, cell.h - 90), h: Math.min(cell.h, 90) }
    : { ...cell, h: Math.min(cell.h, 90) };
  return { cell, focus: g ?? (c.entity && more ? more : edge), inbox: false };
}

interface HoverTip {
  id: string;
  x: number;
  y: number;
}

function tipText(world: World, id: string): string {
  const e = getEntity(world, id);
  if (!e) return id;
  const kind = schemaOf(world).kinds[e.kind].label;
  const p = placementOf(world, id);
  const via = p.via ? getEntity(world, p.via)?.name : undefined;
  const sub =
    e.kind === 'item' && typeof e.fields.subkind === 'string'
      ? e.fields.subkind
      : kind.toLowerCase();
  return [e.name, sub, e.state, p.inferred ? `inferred${via ? ` via ${via}` : ''}` : null]
    .filter(Boolean)
    .join(' · ');
}

function ColumnView(): ReactNode {
  const world = useWorld((w) => w, Object.is);
  const model = useMemo(() => (world ? columnModel(world) : null), [world]);
  if (!world || !model) return null;
  return <Column world={world} model={model} />;
}

function Column({ world, model }: { world: World; model: ColumnModel }): ReactNode {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [viewH, setViewH] = useState(0);
  const [fontVer, setFontVer] = useState(0);
  const [range, setRange] = useState<[number, number]>([0, 2000]);
  const [tip, setTip] = useState<HoverTip | null>(null);
  const pxPerU = useColumn((s) => s.pxPerU);
  const rawCursor = useColumn((s) => s.cursor);
  const edgeDrag = useColumn((s) => s.edgeDrag);
  const draw = useColumn((s) => s.draw);
  const focus = useUi((s) => s.focus);
  const notes = useNotes();

  // Width and height of the viewport; fonts loading changes text widths.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      setWidth(el.clientWidth);
      setViewH(el.clientHeight);
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live) return;
      resetMeasures();
      setFontVer((v) => v + 1);
    });
    return () => {
      live = false;
    };
  }, []);

  const dragBands = useMemo(() => draggedBands(model.bands, edgeDrag), [model.bands, edgeDrag]);
  const geo = useMemo(
    () =>
      geometry(model, {
        pxPerU,
        width: Math.max(width, 600),
        measure: measureChip,
        version: fontVer,
        ...(dragBands ? { bands: dragBands } : {}),
      }),
    [model, pxPerU, width, dragBands, fontVer],
  );
  const showInbox = geo.inbox !== null || rawCursor?.row === INBOX_ROW;
  const nav = useMemo(
    () => navContext(model, inboxHasEntities(model) || rawCursor?.row === INBOX_ROW),
    [model, rawCursor?.row],
  );
  const cursor = useMemo(
    () => normalize(nav, rawCursor ?? at(nav, rowAtY(model, 0), 0), rowAtY(model, 0)),
    [nav, rawCursor, model],
  );
  const cursorRef = useRef(cursor);
  useLayoutEffect(() => {
    cursorRef.current = cursor;
  });

  // ── Scrolling: restore, or centre on Y 0; keep the zoom anchored ──────────
  const anchor = useRef<{ u: number; offset: number } | null>(null);
  const restored = useRef(false);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || width === 0) return;
    if (!restored.current) {
      restored.current = true;
      const saved = columnStore.get().scrollTop;
      el.scrollTop = saved ?? pxOfY(geo.frame, 0) + HEAD_H - el.clientHeight / 2;
    } else if (anchor.current) {
      el.scrollTop = pxOfU(geo.frame, anchor.current.u) + HEAD_H - anchor.current.offset;
      anchor.current = null;
    }
  }, [geo.frame, width]);

  const updateRange = useCallback((): void => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop - HEAD_H - OVERSCAN;
    const bottom = el.scrollTop + el.clientHeight + OVERSCAN;
    // Quantize, so small scrolls don't re-render.
    const q = 400;
    const next: [number, number] = [Math.floor(top / q) * q, Math.ceil(bottom / q) * q];
    setRange((r) => (r[0] === next[0] && r[1] === next[1] ? r : next));
  }, []);
  useEffect(updateRange, [updateRange, geo, viewH]);
  const rafRef = useRef(0);
  const onScroll = (): void => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      updateRange();
      const el = scrollRef.current;
      if (el) columnStore.set((s) => ({ ...s, scrollTop: el.scrollTop }));
    });
  };
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);

  const zoomTo = useCallback(
    (z: number, clientY?: number): void => {
      const el = scrollRef.current;
      const next = clampZoom(z);
      if (!el || next === columnStore.get().pxPerU) return;
      const offset =
        clientY !== undefined ? clientY - el.getBoundingClientRect().top : el.clientHeight / 2;
      anchor.current = { u: uOfPx(geo.frame, el.scrollTop + offset - HEAD_H), offset };
      setColumn({ pxPerU: next });
    },
    [geo.frame],
  );

  // ── The cursor and the Bench follow each other ────────────────────────────
  const scrollPending = useRef(false);
  const moveCursor = useCallback((c: Cursor): void => {
    scrollPending.current = true;
    setColumn({ cursor: c });
    if (c.entity && uiStore.get().focus !== c.entity) focusEntity(c.entity);
  }, []);
  useEffect(() => {
    if (!focus || focus === cursorRef.current.entity) return;
    const where = locate(model, focus);
    if (!where) return;
    scrollPending.current = true;
    setColumn({ cursor: { row: where.row, lane: where.lane, entity: focus } });
  }, [focus, model]);
  const rects = useMemo(() => cursorRect(geo, model, cursor), [geo, model, cursor]);
  useLayoutEffect(() => {
    if (!scrollPending.current) return;
    scrollPending.current = false;
    const el = scrollRef.current;
    const r = rects.focus;
    if (!el || !r || rects.inbox) return;
    const top = r.y + HEAD_H - 24;
    const bottom = r.y + r.h + HEAD_H + 24;
    if (top < el.scrollTop + HEAD_H) el.scrollTop = top - HEAD_H;
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight;
  }, [rects]);

  // ── Creating, spreading ───────────────────────────────────────────────────
  const createAt = useCallback(
    async (c: Cursor): Promise<void> => {
      const w = currentWorld();
      if (!w) return;
      const row = model.rows.find((r) => r.key === c.row);
      if (row?.kind === 'gap') {
        const span = newBandSpan(row);
        const id = uniqueId('New band', (x) => getEntity(w, x) !== undefined);
        const r = await transact('Create band', [createBandCommand(span, id)]);
        if (!r.ok) return flash(r.error.message, 'error');
        focusEntity(id);
        setColumn({ cursor: { row: id, lane: -1, entity: id } });
        requestFieldFocus(id, 'name', true);
        return;
      }
      const lane = model.lanes[c.lane];
      if (!lane) return;
      const kind = KIND_OF_LANE[lane];
      const label = schemaOf(w).kinds[kind].label.toLowerCase();
      const name = `New ${label}`;
      const id = uniqueId(name, (x) => getEntity(w, x) !== undefined);
      const band = row?.kind === 'band' ? row.band.id : null;
      const near = c.entity ? getEntity(w, c.entity) : undefined;
      const fields: Record<string, unknown> = {};
      if (kind === 'biome' && band) fields.band = band;
      if (kind === 'item' && near?.kind === 'item' && typeof near.fields.subkind === 'string')
        fields.subkind = near.fields.subkind;
      const relations = band && kind !== 'biome' ? [{ type: 'in_band', target: band }] : [];
      const r = await transact(`Create ${name}`, [
        cmd('entity.create', { kind, name, id, fields, relations }),
      ]);
      if (!r.ok) return flash(r.error.message, 'error');
      focusEntity(id);
      setColumn({ cursor: { ...c, entity: id } });
      requestFieldFocus(id, 'name', true);
    },
    [model],
  );

  const spotOf = (c: Cursor): Spot | null => {
    const row = model.rows.find((r) => r.key === c.row);
    const lane = model.lanes[c.lane];
    if (row?.kind === 'band' && lane) return { type: 'cell', band: row.band.id, lane };
    if (c.entity) return { type: 'entity', entity: c.entity };
    return null;
  };

  const moveEdge = useCallback(
    (which: 'top' | 'bottom', dir: 1 | -1): void => {
      const c = cursorRef.current;
      const band = model.bands.find((b) => b.id === c.row);
      if (!band) return;
      const edge = edgesOf(model.bands).find((e) =>
        which === 'top' ? e.below === band.id : e.above === band.id,
      );
      if (!edge) return flash(`${band.name} is endless ${which === 'top' ? 'upward' : 'downward'}`);
      const y = clampEdge(edgeLimits(model.bands, edge), nudge(edge.y, dir));
      if (y === edge.y) return;
      void transact(`Move edge of ${band.name}`, moveEdgeCommands(edge, y)).then((r) => {
        if (!r.ok) flash(r.error.message, 'error');
      });
    },
    [model.bands],
  );

  function canMoveLane(): boolean {
    return !typing() && model.lanes[cursorRef.current.lane] !== undefined;
  }
  function moveLaneBy(dir: 1 | -1): void {
    const c0 = cursorRef.current;
    const lane = model.lanes[c0.lane];
    if (!lane) return;
    const c = moveLane(columnSettings(world), lane, dir);
    if (!c) return;
    void transact(`Move ${model.laneLabels[lane]} ${dir < 0 ? 'left' : 'right'}`, [c]).then((r) => {
      if (r.ok) setColumn({ cursor: { ...c0, lane: c0.lane + dir } });
    });
  }

  const actions: Action[] = [
    {
      id: 'column.down',
      label: 'Move down',
      keys: ['j', 'arrowdown'],
      hidden: true,
      run: () => moveCursor(step(nav, cursorRef.current, 1)),
    },
    {
      id: 'column.up',
      label: 'Move up',
      keys: ['k', 'arrowup'],
      hidden: true,
      run: () => moveCursor(step(nav, cursorRef.current, -1)),
    },
    {
      id: 'column.left',
      label: 'Lane left',
      keys: ['h', 'arrowleft'],
      hidden: true,
      run: () => moveCursor(side(nav, cursorRef.current, -1)),
    },
    {
      id: 'column.right',
      label: 'Lane right',
      keys: ['l', 'arrowright'],
      hidden: true,
      run: () => moveCursor(side(nav, cursorRef.current, 1)),
    },
    {
      id: 'column.zoomIn',
      label: 'Zoom in',
      group: 'Column',
      keys: ['+', '='],
      run: () => zoomTo(columnStore.get().pxPerU * ZOOM_STEP),
    },
    {
      id: 'column.zoomOut',
      label: 'Zoom out',
      group: 'Column',
      keys: ['-'],
      run: () => zoomTo(columnStore.get().pxPerU / ZOOM_STEP),
    },
    {
      id: 'column.zero',
      label: 'Jump to Y 0',
      group: 'Column',
      keys: ['0'],
      run: () => {
        const el = scrollRef.current;
        if (el) el.scrollTop = pxOfY(geo.frame, 0) + HEAD_H - el.clientHeight / 2;
        setColumn({ cursor: at(nav, rowAtY(model, 0), Math.max(0, cursorRef.current.lane)) });
      },
    },
    {
      id: 'column.new',
      label: 'New entity here',
      group: 'Column',
      keys: ['n'],
      enabled: () =>
        cursorRef.current.lane >= 0 ||
        model.rows.find((r) => r.key === cursorRef.current.row)?.kind === 'gap',
      run: () => void createAt(cursorRef.current),
    },
    {
      id: 'column.spread',
      label: 'Spread here',
      group: 'Column',
      keys: ['space'],
      enabled: () => spotOf(cursorRef.current) !== null,
      run: () => {
        const spot = spotOf(cursorRef.current);
        if (spot) startSpread(spot);
      },
    },
    {
      id: 'column.open',
      label: 'Edit on the Bench',
      group: 'Column',
      keys: ['enter'],
      enabled: () => cursorRef.current.entity !== null,
      run: () => {
        const id = cursorRef.current.entity;
        if (!id) return;
        focusEntity(id);
        requestFieldFocus(id, 'name');
      },
    },
    {
      id: 'column.inbox',
      label: 'Inbox',
      group: 'Column',
      keys: ['i'],
      run: () => {
        if (!inboxHasEntities(model)) return flash('The Inbox is empty');
        const lane = Math.max(
          0,
          model.lanes.findIndex(
            (l) => (model.index.cells.get(cellKey(INBOX_ROW, l))?.length ?? 0) > 0,
          ),
        );
        moveCursor(
          at(
            navContext(model, true),
            INBOX_ROW,
            model.index.unplacedBands.length > 0 &&
              lane === 0 &&
              !model.index.cells.get(cellKey(INBOX_ROW, model.lanes[0] ?? 'biomes'))
              ? -1
              : lane,
          ),
        );
      },
    },
    {
      id: 'column.edgeTopUp',
      label: 'Raise the top edge of the band',
      group: 'Column',
      keys: ['alt+k'],
      enabled: () => !typing(),
      run: () => moveEdge('top', 1),
    },
    {
      id: 'column.edgeTopDown',
      label: 'Lower the top edge of the band',
      group: 'Column',
      keys: ['alt+j'],
      enabled: () => !typing(),
      run: () => moveEdge('top', -1),
    },
    {
      id: 'column.edgeBottomUp',
      label: 'Raise the bottom edge of the band',
      group: 'Column',
      keys: ['alt+shift+k'],
      enabled: () => !typing(),
      run: () => moveEdge('bottom', 1),
    },
    {
      id: 'column.edgeBottomDown',
      label: 'Lower the bottom edge of the band',
      group: 'Column',
      keys: ['alt+shift+j'],
      enabled: () => !typing(),
      run: () => moveEdge('bottom', -1),
    },
    {
      id: 'column.lane.left',
      label: 'Move this lane left',
      group: 'Column',
      keys: ['alt+h'],
      enabled: canMoveLane,
      run: () => moveLaneBy(-1),
    },
    {
      id: 'column.lane.right',
      label: 'Move this lane right',
      group: 'Column',
      keys: ['alt+l'],
      enabled: canMoveLane,
      run: () => moveLaneBy(1),
    },
  ];
  useActions(actions);
  useLaneActions(world, model);

  // ── Pointer: select, drag edges, draw bands, zoom ────────────────────────
  const contentPoint = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = contentRef.current?.getBoundingClientRect();
    return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
  };
  const laneAt = (x: number): number =>
    x < RULER_W + LABEL_W
      ? -1
      : Math.min(model.lanes.length - 1, Math.floor((x - RULER_W - LABEL_W) / geo.laneW));
  const rowAtPx = (y: number): string | null =>
    geo.rows.find((r) => y >= r.top && y < r.bottom)?.row.key ?? null;

  const dragRef = useRef<
    | { kind: 'edge'; key: string; pointer: number }
    | { kind: 'draw'; gap: string; pointer: number }
    | null
  >(null);
  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    const p = contentPoint(e);
    const edgeEl = target.closest('[data-edge]');
    if (edgeEl) {
      const key = edgeEl.getAttribute('data-edge') ?? '';
      const edge = edgesOf(model.bands).find((x) => edgeKey(x) === key);
      if (!edge) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { kind: 'edge', key, pointer: e.pointerId };
      setColumn({ edgeDrag: { key, y: edge.y } });
      e.preventDefault();
      return;
    }
    const chip = target.closest('[data-id]');
    if (chip) {
      const id = chip.getAttribute('data-id') ?? '';
      const row = chip.getAttribute('data-row') ?? '';
      moveCursor({ row, lane: laneAt(p.x), entity: id });
      return;
    }
    const rowKey = rowAtPx(p.y);
    if (!rowKey) return;
    const lane = laneAt(p.x);
    const row = model.rows.find((r) => r.key === rowKey);
    if (row?.kind === 'gap' && lane < 0) {
      const y = yAtPx(geo.frame, p.y);
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { kind: 'draw', gap: rowKey, pointer: e.pointerId };
      setColumn({ draw: { gap: rowKey, from: y, to: y } });
      return;
    }
    moveCursor(
      normalize(nav, {
        row: rowKey,
        lane,
        entity: lane < 0 && row?.kind === 'band' ? rowKey : null,
      }),
    );
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    const d = dragRef.current;
    if (d) {
      const y = yAtPx(geo.frame, contentPoint(e).y);
      if (d.kind === 'edge') {
        const edge = edgesOf(model.bands).find((x) => edgeKey(x) === d.key);
        if (edge)
          setColumn({ edgeDrag: { key: d.key, y: clampEdge(edgeLimits(model.bands, edge), y) } });
      } else {
        setColumn({ draw: { ...(columnStore.get().draw ?? { gap: d.gap, from: y }), to: y } });
      }
      return;
    }
    const chip = (e.target as Element).closest('[data-id]');
    const id = chip?.getAttribute('data-id') ?? null;
    if (!id) {
      if (tip) setTip(null);
      return;
    }
    if (tip?.id !== id) {
      const r = chip?.getBoundingClientRect();
      if (r) setTip({ id, x: r.left, y: r.bottom + 6 });
    }
  };
  const endDrag = (commit: boolean): void => {
    const d = dragRef.current;
    dragRef.current = null;
    const s = columnStore.get();
    setColumn({ edgeDrag: null, draw: null });
    if (!commit || !d) return;
    if (d.kind === 'edge' && s.edgeDrag) {
      const edge = edgesOf(model.bands).find((x) => edgeKey(x) === d.key);
      if (!edge || edge.y === s.edgeDrag.y) return;
      const name = getEntity(world, edge.below ?? edge.above ?? '')?.name ?? 'band';
      void transact(`Move edge of ${name}`, moveEdgeCommands(edge, s.edgeDrag.y)).then((r) => {
        if (!r.ok) flash(r.error.message, 'error');
      });
    } else if (d.kind === 'draw' && s.draw) {
      const gap = model.rows.find((r) => r.key === d.gap);
      if (gap?.kind !== 'gap') return;
      const span = drawnBandSpan(gap, s.draw.from, s.draw.to);
      const w = currentWorld();
      if (!w) return;
      const id = uniqueId('New band', (x) => getEntity(w, x) !== undefined);
      void transact('Create band', [createBandCommand(span, id)]).then((r) => {
        if (!r.ok) return flash(r.error.message, 'error');
        focusEntity(id);
        setColumn({ cursor: { row: id, lane: -1, entity: id } });
        requestFieldFocus(id, 'name', true);
      });
    }
  };
  useEffect(() => {
    if (!edgeDrag && !draw) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      endDrag(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  const onWheel = (e: ReactWheelEvent): void => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomTo(columnStore.get().pxPerU * Math.pow(1.0015, -e.deltaY), e.clientY);
  };
  useEffect(() => {
    // React's wheel listener is passive; ctrl+wheel zoom needs preventDefault.
    const el = scrollRef.current;
    if (!el) return undefined;
    const stop = (e: WheelEvent): void => {
      if (e.ctrlKey) e.preventDefault();
    };
    el.addEventListener('wheel', stop, { passive: false });
    return () => el.removeEventListener('wheel', stop);
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  const visibleRows = geo.rows.filter((r) => r.bottom >= range[0] && r.top <= range[1]);
  const visibleCells = [...geo.cells.values()].filter(
    (c) => c.rect.y + c.rect.h >= range[0] && c.rect.y <= range[1],
  );
  const edges = useMemo(() => edgesOf(dragBands ?? model.bands), [dragBands, model.bands]);
  const right = geo.marginX;
  const cursorId = cursor.entity;
  const empty = model.bands.length === 0;
  const onOpen = (id: string): void => {
    focusEntity(id);
  };

  return (
    <div className="column" data-testid="column" data-zoom={pxPerU}>
      <div
        className="column-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={onWheel}
        data-testid="column-scroll"
      >
        <div className="column-head" style={{ width: geo.width }}>
          <div className="column-head-corner" style={{ width: RULER_W + LABEL_W }}>
            <LanesMenu world={world} model={model} />
          </div>
          {model.lanes.map((l, i) => (
            <div
              key={l}
              className="column-lane-head"
              style={{ width: geo.laneW }}
              data-lane={l}
              data-cursor={cursor.lane === i ? '' : undefined}
            >
              {model.laneLabels[l]}
            </div>
          ))}
        </div>
        <div
          className="column-content"
          ref={contentRef}
          style={{ height: geo.frame.height, width: geo.width }}
        >
          <svg
            className="column-svg"
            width={geo.width}
            height={geo.frame.height}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => endDrag(true)}
            onPointerCancel={() => endDrag(false)}
            onPointerLeave={() => setTip(null)}
            data-testid="column-svg"
          >
            <Defs />
            <RowsLayer rows={visibleRows} x={RULER_W} width={right - RULER_W} />
            <Grid
              rows={geo.rows}
              laneX={geo.laneX}
              laneW={geo.laneW}
              right={right}
              edges={edges}
              frame={geo.frame}
              dragging={edgeDrag?.key ?? null}
            />
            <Ruler frame={geo.frame} />
            <BandLabels rows={visibleRows} />
            {!rects.inbox && <CursorMark rect={rects.cell} />}
            {visibleCells.map((c) => (
              <Cell key={c.key} cell={c} cursorId={c.row === cursor.row ? cursorId : null} />
            ))}
            {draw && (
              <DrawPreview
                frame={geo.frame}
                from={draw.from}
                to={draw.to}
                x={RULER_W}
                width={right - RULER_W}
              />
            )}
          </svg>
          <Margin notes={notes} model={model} geo={geo} measure={measureNote} onOpen={onOpen} />
        </div>
      </div>
      {showInbox && (
        <Inbox
          geo={geo}
          model={model}
          cursor={cursor}
          cursorRect={rects.inbox ? rects.cell : null}
          onPick={moveCursor}
        />
      )}
      {empty && (
        <div className="column-empty t-2">
          No bands yet. <Kbd>n</Kbd> to add one.
        </div>
      )}
      {tip && (
        <div className="ui-tooltip column-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          {tipText(world, tip.id)}
        </div>
      )}
    </div>
  );
}

/** The Inbox: entities with no place, pinned under the Column, aligned to the lanes. */
function Inbox({
  geo,
  model,
  cursor,
  cursorRect: rect,
  onPick,
}: {
  geo: Geometry;
  model: ColumnModel;
  cursor: Cursor;
  cursorRect: Rect | null;
  onPick: (c: Cursor) => void;
}): ReactNode {
  const height = geo.inbox?.height ?? 32;
  const count =
    model.index.unplacedBands.length +
    model.lanes.reduce(
      (n, l) => n + (model.index.cells.get(cellKey(INBOX_ROW, l))?.length ?? 0),
      0,
    );
  const cells = [...(geo.inbox?.cells.values() ?? [])];
  return (
    <div className="column-inbox" data-testid="column-inbox" style={{ height: height + 1 }}>
      <svg
        width={geo.width}
        height={height}
        onPointerDown={(e) => {
          const chip = (e.target as Element).closest('[data-id]');
          const r = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - r.left;
          const lane =
            x < RULER_W + LABEL_W
              ? -1
              : Math.min(model.lanes.length - 1, Math.floor((x - RULER_W - LABEL_W) / geo.laneW));
          onPick({ row: INBOX_ROW, lane, entity: chip?.getAttribute('data-id') ?? null });
        }}
      >
        <text x={8} y={18} className="column-inbox-label">
          Inbox
        </text>
        <text x={8} y={32} className="column-band-span">
          {count}
        </text>
        {geo.laneX.map((x) => (
          <line key={x} x1={x + 0.5} y1={0} x2={x + 0.5} y2={height} className="column-lane-line" />
        ))}
        {rect && <CursorMark rect={{ ...rect, h: height }} />}
        {geo.inbox?.bands && (
          <Cell cell={geo.inbox.bands} cursorId={cursor.row === INBOX_ROW ? cursor.entity : null} />
        )}
        {cells.map((c) => (
          <Cell key={c.key} cell={c} cursorId={cursor.row === INBOX_ROW ? cursor.entity : null} />
        ))}
      </svg>
    </div>
  );
}

export default defineView({
  id: 'column',
  label: 'Column',
  key: '1',
  order: 1,
  icon: IconColumn,
  component: ColumnView,
});
