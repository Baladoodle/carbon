import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { cmd } from '@core/commands/registry';
import { ClimateSchema } from '@core/model/fields';
import { uniqueId } from '@core/model/ids';
import type { EntityState } from '@core/model/kinds';
import { schemaOf, type World } from '@core/model/world';
import { entitiesInBiome } from '@core/placement';
import { useActions } from '../../actions';
import { flash, focusEntity, startSpreadAt, useUi } from '../../state/ui';
import { currentWorld, dispatch, useWorld, whenRev } from '../../state/world';
import { Kbd, StateGlyph, Tabs, Tooltip, cx } from '../../ui';
import { IconClimate } from '../../ui/icons';
import { defineView } from '../define';
import { Burst } from '../column/burst';
import { bandsOf, biomesInBand } from './bands';
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

const SIGNATURE_KINDS = ['material', 'creature', 'structure'] as const;

function regionsOf(
  w: World,
  band: string,
): { placed: Region[]; loose: { id: string; name: string }[] } {
  const plural = schemaOf(w).kinds;
  const placed: Region[] = [];
  const loose: { id: string; name: string }[] = [];
  for (const id of biomesInBand(w, band)) {
    const e = w.entities[id];
    if (!e) continue;
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
  // The Bench focus a deselect turned away from: the selection stops following it.
  const [unfollowed, setUnfollowed] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const planeRef = useRef<HTMLDivElement>(null);

  // Arrow-key nudges: a live draft per burst, committed as one undo step once the keys rest.
  const [burst] = useState(
    () =>
      new Burst<Rect>(async (id, rect) => {
        const r = await dispatch(
          cmd('entity.setField', { id, field: 'climate', value: climateOf(rect) }),
        );
        if (!r.ok) return flash(r.error.message, 'error');
        await whenRev(r.rev);
      }),
  );
  const nudging = useSyncExternalStore(
    (fn) => burst.subscribe(fn),
    () => burst.current,
  );
  // Leaving the view sends a waiting burst rather than dropping it.
  useEffect(() => () => burst.flush(), [burst]);

  const { placed, loose } = useMemo(
    () => (world && band ? regionsOf(world, band) : { placed: [], loose: [] }),
    [world, band],
  );
  // Live rectangles: the one being dragged or nudged shows its draft.
  const live = useMemo(
    () =>
      placed.map((r) =>
        drag?.id === r.id
          ? { ...r, rect: drag.rect }
          : nudging?.key === r.id
            ? { ...r, rect: nudging.value }
            : r,
      ),
    [placed, drag, nudging],
  );
  const shared = useMemo(() => overlaps(live.map((r) => ({ id: r.id, rect: r.rect }))), [live]);
  const empty = useMemo(() => emptyRegions(live.map((r) => r.rect)), [live]);
  const overlapping = new Set(shared.flatMap((o) => [o.a, o.b]));
  // The selection follows the Bench when it shows a biome in this band.
  const selected =
    selectedRaw && placed.some((r) => r.id === selectedRaw)
      ? selectedRaw
      : focus && focus !== unfollowed && placed.some((r) => r.id === focus)
        ? focus
        : null;
  const sel = live.find((r) => r.id === selected);

  const chooseBand = (id: string): void => {
    burst.flush();
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
    if (id !== nudging?.key) burst.flush();
    setSelected(id);
    setUnfollowed(null);
    if (id) focusEntity(id);
  };
  const deselect = (): void => {
    burst.flush();
    setSelected(null);
    setUnfollowed(focus);
  };

  const save = async (id: string, rect: Rect): Promise<void> => {
    const r = await dispatch(
      cmd('entity.setField', { id, field: 'climate', value: climateOf(rect) }),
    );
    if (!r.ok) flash(r.error.message, 'error');
  };

  const nudge = (dx: number, dy: number, resize: boolean): void => {
    if (!sel) return;
    // Build on the burst's draft, not on the world: a press can come before the last one lands.
    const from = burst.get(sel.id) ?? sel.rect;
    const next = resize ? resizeRect(from, 'ne', dx, dy) : moveRect(from, dx, dy);
    if (!sameRect(next, from)) burst.push(sel.id, next);
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
      label: 'Move the biome warmer',
      group: 'Climate',
      keys: ['arrowright'],
      enabled: () => idle() && !!sel,
      run: () => nudge(NUDGE, 0, false),
    },
    {
      id: 'climate.colder',
      label: 'Move the biome colder',
      group: 'Climate',
      keys: ['arrowleft'],
      enabled: () => idle() && !!sel,
      run: () => nudge(-NUDGE, 0, false),
    },
    {
      id: 'climate.wetter',
      label: 'Move the biome wetter',
      group: 'Climate',
      keys: ['arrowup'],
      enabled: () => idle() && !!sel,
      run: () => nudge(0, NUDGE, false),
    },
    {
      id: 'climate.drier',
      label: 'Move the biome drier',
      group: 'Climate',
      keys: ['arrowdown'],
      enabled: () => idle() && !!sel,
      run: () => nudge(0, -NUDGE, false),
    },
    {
      id: 'climate.widen',
      label: 'Widen the biome (warmer edge)',
      group: 'Climate',
      keys: ['shift+arrowright'],
      enabled: () => idle() && !!sel,
      run: () => nudge(NUDGE, 0, true),
    },
    {
      id: 'climate.narrow',
      label: 'Narrow the biome (warmer edge)',
      group: 'Climate',
      keys: ['shift+arrowleft'],
      enabled: () => idle() && !!sel,
      run: () => nudge(-NUDGE, 0, true),
    },
    {
      id: 'climate.taller',
      label: 'Raise the biome’s wet edge',
      group: 'Climate',
      keys: ['shift+arrowup'],
      enabled: () => idle() && !!sel,
      run: () => nudge(0, NUDGE, true),
    },
    {
      id: 'climate.shorter',
      label: 'Lower the biome’s wet edge',
      group: 'Climate',
      keys: ['shift+arrowdown'],
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
      label: 'Open the biome on the Bench',
      group: 'Climate',
      keys: ['enter'],
      enabled: () => idle() && !!sel,
      run: () => sel && focusEntity(sel.id),
    },
    {
      id: 'climate.deselect',
      label: 'Deselect',
      keys: ['escape'],
      hidden: true,
      enabled: () => !!sel || drag !== null,
      run: () => (drag ? setDrag(null) : deselect()),
    },
    {
      id: 'climate.undo-nudge',
      label: 'Undo',
      keys: ['ctrl+z'],
      hidden: true,
      // Undo before a burst was sent drops the burst (it was never a step of its own).
      enabled: () => burst.waiting,
      run: () => void burst.cancel(),
    },
    // Biomes in the band with no climate yet: placing one is a click under the plane, or this.
    ...loose.map((b) => ({
      id: `climate.place.${b.id}`,
      label: `Place ${b.name} on the plane`,
      group: 'Climate',
      enabled: idle,
      run: () => void place(b.id),
    })),
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
    burst.flush();
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
      {/* A click on a tab, even the current one, hands the keys back to the plane
          (the tab strip would keep the arrows and switch bands with them). */}
      <div
        style={{ display: 'contents' }}
        onPointerUp={() => requestAnimationFrame(() => planeRef.current?.focus())}
      >
        <Tabs
          className="climate-bands"
          value={band}
          onValueChange={chooseBand}
          aria-label="Band"
          tabs={bands.map((b) => ({ value: b.id, label: b.name }))}
        />
      </div>
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
              // The plane or its empty climate (anything but a biome) deselects.
              if (!(e.target as Element).closest('[data-testid="climate-region"]')) deselect();
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
