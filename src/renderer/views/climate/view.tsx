import {
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cmd } from '@core/commands/registry';
import { ClimateSchema } from '@core/model/fields';
import { uniqueId } from '@core/model/ids';
import type { EntityState } from '@core/model/kinds';
import { schemaOf, type World } from '@core/model/world';
import { entitiesInBiome, knownBands, resolvePlacement } from '@core/placement';
import { useActions } from '../../actions';
import { flash, focusEntity, startSpreadAt, useUi } from '../../state/ui';
import { currentWorld, dispatch, useWorld } from '../../state/world';
import { Kbd, StateGlyph, Tabs, Tooltip, cx } from '../../ui';
import { IconClimate } from '../../ui/icons';
import { defineView } from '../define';
import {
  climateOf,
  emptyRegions,
  HANDLES,
  moveRect,
  newRegion,
  overlaps,
  rectOf,
  resizeRect,
  sameRect,
  type Handle,
  type Rect,
} from './geometry';
import './climate.css';

const NUDGE = 0.05;
const BAND_KEY = 'carbon.climate.band';

interface Region {
  id: string;
  name: string;
  state: EntityState;
  rect: Rect;
  ai: boolean;
  signature: { kind: string; names: string[] }[];
}

interface Drag {
  id: string;
  handle: Handle | 'move';
  startX: number;
  startY: number;
  start: Rect;
  rect: Rect;
}

/** The bands, ordered top (sky) to bottom (depths), as on the Column; unknown-edge bands last. */
function bandsOf(w: World): { id: string; name: string }[] {
  const known = knownBands(w)
    .reverse()
    .map((b) => ({ id: b.id, name: b.name }));
  const rest = Object.values(w.entities)
    .filter((e) => e.kind === 'band' && !known.some((k) => k.id === e.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ id: e.id, name: e.name }));
  return [...known, ...rest];
}

const SIGNATURE_KINDS = ['material', 'creature', 'structure'] as const;

function regionsOf(
  w: World,
  band: string,
): { placed: Region[]; loose: { id: string; name: string }[] } {
  const all = resolvePlacement(w);
  const plural = schemaOf(w).kinds;
  const placed: Region[] = [];
  const loose: { id: string; name: string }[] = [];
  for (const e of Object.values(w.entities)) {
    if (e.kind !== 'biome' || !all[e.id]?.bands.includes(band)) continue;
    const c = ClimateSchema.safeParse(e.fields.climate);
    if (!c.success) {
      loose.push({ id: e.id, name: e.name });
      continue;
    }
    const inside = entitiesInBiome(w, e.id)
      .map((id) => w.entities[id])
      .filter((x) => x !== undefined && x.state !== 'graveyard');
    placed.push({
      id: e.id,
      name: e.name,
      state: e.state,
      rect: rectOf(c.data),
      ai: e.ai_fields.includes('climate'),
      signature: SIGNATURE_KINDS.map((k) => ({
        kind: plural[k].plural.toLowerCase(),
        names: inside.filter((x) => x?.kind === k).map((x) => x?.name ?? ''),
      })).filter((s) => s.names.length > 0),
    });
  }
  placed.sort((a, b) => a.rect.y0 - b.rect.y0 || a.rect.x0 - b.rect.x0 || a.id.localeCompare(b.id));
  loose.sort((a, b) => a.name.localeCompare(b.name));
  return { placed, loose };
}

const pct = (v: number): string => `${(v * 100).toFixed(3)}%`;
const boxStyle = (r: Rect): React.CSSProperties => ({
  left: pct(r.x0),
  width: pct(r.x1 - r.x0),
  bottom: pct(r.y0),
  height: pct(r.y1 - r.y0),
});

function ClimateView(): ReactNode {
  const world = useWorld((w) => w, Object.is);
  const focus = useUi((s) => s.focus);
  const bands = useMemo(() => (world ? bandsOf(world) : []), [world]);
  const [pickedBand, setBand] = useState<string | null>(() => {
    try {
      return localStorage.getItem(BAND_KEY);
    } catch {
      return null;
    }
  });
  const band = bands.find((b) => b.id === pickedBand)?.id ?? bands[0]?.id ?? null;
  const [selectedRaw, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const planeRef = useRef<HTMLDivElement>(null);

  const { placed, loose } = useMemo(
    () => (world && band ? regionsOf(world, band) : { placed: [], loose: [] }),
    [world, band],
  );
  // Live rectangles: the one being dragged shows its draft.
  const live = useMemo(
    () => placed.map((r) => (drag?.id === r.id ? { ...r, rect: drag.rect } : r)),
    [placed, drag],
  );
  const shared = useMemo(() => overlaps(live.map((r) => ({ id: r.id, rect: r.rect }))), [live]);
  const empty = useMemo(() => emptyRegions(live.map((r) => r.rect)), [live]);
  const overlapping = new Set(shared.flatMap((o) => [o.a, o.b]));
  // The selection follows the Bench when it shows a biome in this band.
  const selected =
    selectedRaw && placed.some((r) => r.id === selectedRaw)
      ? selectedRaw
      : focus && placed.some((r) => r.id === focus)
        ? focus
        : null;
  const sel = live.find((r) => r.id === selected);

  const chooseBand = (id: string): void => {
    setBand(id);
    setSelected(null);
    try {
      localStorage.setItem(BAND_KEY, id);
    } catch {
      // storage unavailable
    }
  };
  const stepBand = (d: 1 | -1): void => {
    if (!band || bands.length === 0) return;
    const i = bands.findIndex((b) => b.id === band);
    const next = bands[(i + d + bands.length) % bands.length];
    if (next) chooseBand(next.id);
  };
  const select = (id: string | null): void => {
    setSelected(id);
    if (id) focusEntity(id);
  };

  const save = async (id: string, rect: Rect): Promise<void> => {
    const r = await dispatch(
      cmd('entity.setField', { id, field: 'climate', value: climateOf(rect) }),
    );
    if (!r.ok) flash(r.error.message, 'error');
  };

  const nudge = (dx: number, dy: number, resize: boolean): void => {
    if (!sel) return;
    const next = resize ? resizeRect(sel.rect, 'ne', dx, dy) : moveRect(sel.rect, dx, dy);
    if (!sameRect(next, sel.rect)) void save(sel.id, next);
  };

  const create = async (): Promise<void> => {
    const w = currentWorld();
    if (!w || !band) return;
    const name = 'New biome';
    const id = uniqueId(name, (c) => c in w.entities);
    const rect = newRegion(live.map((r) => r.rect));
    const r = await dispatch(
      cmd('entity.create', { kind: 'biome', name, id, fields: { band, climate: climateOf(rect) } }),
    );
    if (!r.ok) return flash(r.error.message, 'error');
    select(id);
  };

  const place = async (id: string): Promise<void> => {
    await save(id, newRegion(live.map((r) => r.rect)));
    select(id);
  };

  const cycle = (d: 1 | -1): void => {
    if (live.length === 0) return;
    const i = sel ? live.findIndex((r) => r.id === sel.id) : d === 1 ? -1 : live.length;
    const next = live[(i + d + live.length) % live.length];
    if (next) select(next.id);
  };

  const idle = (): boolean => drag === null;
  useActions([
    {
      id: 'climate.prev-band',
      label: 'Previous band',
      group: 'Climate',
      keys: ['['],
      enabled: () => idle() && bands.length > 1,
      run: () => stepBand(-1),
    },
    {
      id: 'climate.next-band',
      label: 'Next band',
      group: 'Climate',
      keys: [']'],
      enabled: () => idle() && bands.length > 1,
      run: () => stepBand(1),
    },
    {
      id: 'climate.next',
      label: 'Next biome',
      keys: ['j'],
      hidden: true,
      enabled: () => idle() && live.length > 0,
      run: () => cycle(1),
    },
    {
      id: 'climate.prev',
      label: 'Previous biome',
      keys: ['k'],
      hidden: true,
      enabled: () => idle() && live.length > 0,
      run: () => cycle(-1),
    },
    {
      id: 'climate.warmer',
      label: 'Warmer',
      keys: ['arrowright'],
      hidden: true,
      enabled: () => idle() && !!sel,
      run: () => nudge(NUDGE, 0, false),
    },
    {
      id: 'climate.colder',
      label: 'Colder',
      keys: ['arrowleft'],
      hidden: true,
      enabled: () => idle() && !!sel,
      run: () => nudge(-NUDGE, 0, false),
    },
    {
      id: 'climate.wetter',
      label: 'Wetter',
      keys: ['arrowup'],
      hidden: true,
      enabled: () => idle() && !!sel,
      run: () => nudge(0, NUDGE, false),
    },
    {
      id: 'climate.drier',
      label: 'Drier',
      keys: ['arrowdown'],
      hidden: true,
      enabled: () => idle() && !!sel,
      run: () => nudge(0, -NUDGE, false),
    },
    {
      id: 'climate.widen',
      label: 'Widen',
      keys: ['shift+arrowright'],
      hidden: true,
      enabled: () => idle() && !!sel,
      run: () => nudge(NUDGE, 0, true),
    },
    {
      id: 'climate.narrow',
      label: 'Narrow',
      keys: ['shift+arrowleft'],
      hidden: true,
      enabled: () => idle() && !!sel,
      run: () => nudge(-NUDGE, 0, true),
    },
    {
      id: 'climate.taller',
      label: 'Taller',
      keys: ['shift+arrowup'],
      hidden: true,
      enabled: () => idle() && !!sel,
      run: () => nudge(0, NUDGE, true),
    },
    {
      id: 'climate.shorter',
      label: 'Shorter',
      keys: ['shift+arrowdown'],
      hidden: true,
      enabled: () => idle() && !!sel,
      run: () => nudge(0, -NUDGE, true),
    },
    {
      id: 'climate.new',
      label: 'New biome in the emptiest climate',
      group: 'Climate',
      keys: ['n'],
      enabled: () => idle() && !!band,
      run: () => void create(),
    },
    {
      id: 'climate.bench',
      label: 'Open on the Bench',
      keys: ['enter'],
      hidden: true,
      enabled: () => idle() && !!sel,
      run: () => sel && focusEntity(sel.id),
    },
    {
      id: 'climate.deselect',
      label: 'Deselect',
      keys: ['escape'],
      hidden: true,
      enabled: () => !!sel || drag !== null,
      run: () => (drag ? setDrag(null) : setSelected(null)),
    },
    {
      id: 'climate.spread',
      label: 'Spread in this climate',
      group: 'Climate',
      keys: ['space'],
      enabled: () => idle() && !!band,
      run: () => {
        if (!band) return;
        // The selected biome's climate, else the largest empty climate (a gap to fill).
        const r =
          sel?.rect ??
          [...empty].sort(
            (a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0),
          )[0];
        if (!r) return flash('No empty climate in this band', 'error');
        startSpreadAt({ type: 'region', band, climate: climateOf(r) });
      },
    },
  ]);

  const beginDrag = (e: ReactPointerEvent, id: string, handle: Handle | 'move'): void => {
    if (e.button !== 0) return;
    const r = live.find((x) => x.id === id);
    if (!r) return;
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    select(id);
    setDrag({ id, handle, startX: e.clientX, startY: e.clientY, start: r.rect, rect: r.rect });
  };
  const onMove = (e: ReactPointerEvent): void => {
    const plane = planeRef.current;
    if (!drag || !plane) return;
    const box = plane.getBoundingClientRect();
    const dx = (e.clientX - drag.startX) / box.width;
    const dy = -(e.clientY - drag.startY) / box.height;
    const rect =
      drag.handle === 'move'
        ? moveRect(drag.start, dx, dy)
        : resizeRect(drag.start, drag.handle, dx, dy);
    if (!sameRect(rect, drag.rect)) setDrag({ ...drag, rect });
  };
  const endDrag = (): void => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (!sameRect(d.rect, d.start)) void save(d.id, d.rect);
  };

  if (!world) return <div className="view-empty" />;
  if (bands.length === 0 || !band)
    return (
      <div className="climate-none ui-empty" data-testid="climate-empty">
        No bands yet. <Kbd>1</Kbd> to draw one on the Column.
      </div>
    );

  return (
    <div className="climate" data-testid="climate">
      <Tabs
        className="climate-bands"
        value={band}
        onValueChange={(id) => {
          chooseBand(id);
          // Hand the keys back to the plane (the tab strip would keep the arrows).
          requestAnimationFrame(() => planeRef.current?.focus());
        }}
        aria-label="Band"
        tabs={bands.map((b) => ({ value: b.id, label: b.name }))}
      />
      <div className="climate-stage">
        <div className="climate-frame">
          <span className="climate-axis climate-axis-y t-3">wet</span>
          <span className="climate-axis climate-axis-y climate-axis-low t-3">dry</span>
          <div
            className="climate-plane"
            ref={planeRef}
            tabIndex={-1}
            data-testid="climate-plane"
            onPointerMove={onMove}
            onPointerUp={endDrag}
            onPointerCancel={() => setDrag(null)}
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) setSelected(null);
            }}
          >
            {empty.map((r, i) => (
              <div
                key={`e${i}`}
                className="climate-empty"
                style={boxStyle(r)}
                data-testid="climate-empty-area"
              />
            ))}
            {live.map((r) => (
              <div
                key={r.id}
                className={cx(
                  'climate-region',
                  r.id === selected && 'climate-region-selected',
                  overlapping.has(r.id) && 'climate-region-overlap',
                  drag?.id === r.id && 'climate-region-dragging',
                )}
                style={boxStyle(r.rect)}
                data-entity={r.id}
                data-testid="climate-region"
                onPointerDown={(e) => beginDrag(e, r.id, 'move')}
                onDoubleClick={() => focusEntity(r.id)}
              >
                <div className="climate-region-head">
                  <StateGlyph state={r.state} />
                  <span className={cx('climate-region-name', r.ai && 't-ai')}>{r.name}</span>
                </div>
                {r.signature.map((s) => (
                  <div key={s.kind} className="climate-sig t-meta">
                    <span className="t-3">{s.kind}</span>{' '}
                    <span className="t-2">{s.names.join(', ')}</span>
                  </div>
                ))}
                {HANDLES.map((h) => (
                  <span
                    key={h}
                    className={`climate-handle climate-handle-${h}`}
                    data-handle={h}
                    onPointerDown={(e) => beginDrag(e, r.id, h)}
                  />
                ))}
              </div>
            ))}
            {shared.map((o) => (
              <div
                key={`${o.a}|${o.b}`}
                className="climate-overlap"
                style={boxStyle(o.rect)}
                data-testid="climate-overlap"
                data-pair={`${o.a}|${o.b}`}
              />
            ))}
            {live.length === 0 && (
              <div className="climate-hint t-2">
                No biomes yet. <kbd className="ui-kbd">n</kbd> to add one.
              </div>
            )}
          </div>
          <span className="climate-axis climate-axis-x t-3">cold</span>
          <span className="climate-axis climate-axis-x climate-axis-high t-3">warm</span>
        </div>
        {loose.length > 0 && (
          <ul className="climate-loose" data-testid="climate-loose">
            {loose.map((b) => (
              <li key={b.id}>
                <Tooltip content="Place on the plane">
                  <button
                    type="button"
                    className="climate-loose-item"
                    onClick={() => void place(b.id)}
                  >
                    {b.name}
                  </button>
                </Tooltip>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default defineView({
  id: 'climate',
  label: 'Climate',
  key: '2',
  order: 2,
  icon: IconClimate,
  component: ClimateView,
});
