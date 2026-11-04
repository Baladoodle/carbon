import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { formatNumber, intentAt, niceTicks, roundNice, type CurveSample } from '@core/numbers';
import type { EntityState } from '@core/model/kinds';
import { focusEntity } from '../../state/ui';

/**
 * A curve as an instrument (VISUAL.md §6.5): the formula as a 1.5px line, the
 * intent as a dashed line through 6px square control points you drag (or
 * nudge with ↑/↓, shift for more), and entities as dots coloured by state,
 * each with a tooltip of its value.
 */
const H = 200;
const M = { top: 12, right: 16, bottom: 24, left: 48 };

export interface CurvePlotProps {
  sample: CurveSample;
  states: Record<string, EntityState>;
  /** Called with all intent points (numeric x) when a drag or nudge ends. */
  onIntent?: (points: { x: number; y: number }[]) => void;
  label: string;
}

function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setW(el.clientWidth || 600);
    const ro = new ResizeObserver(() => setW(el.clientWidth || 600));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function yDomain(sample: CurveSample, intent: { y: number }[]): [number, number] {
  const ys = [
    ...sample.line.map((p) => p.y).filter((y): y is number => y !== null),
    ...sample.dots.map((d) => d.y),
    ...intent.map((p) => p.y),
  ].filter(Number.isFinite);
  if (ys.length === 0) return [0, 1];
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.5 : 1;
    lo -= pad;
    hi += pad;
  }
  const pad = (hi - lo) * 0.08;
  return [lo - pad, hi + pad];
}

export function CurvePlot({ sample, states, onIntent, label }: CurvePlotProps): ReactNode {
  const [box, width] = useWidth();
  const [drag, setDrag] = useState<{
    index: number;
    points: { x: number; y: number }[];
    domain: [number, number];
  } | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; text: string; sub?: string } | null>(
    null,
  );
  const [focused, setFocused] = useState<number | null>(null);

  const intent = drag?.points ?? sample.intent;
  const [y0, y1] = drag?.domain ?? yDomain(sample, intent);
  const [x0raw, x1raw] = sample.domain;
  const categorical = sample.axis !== 'attribute';
  const xPad = categorical ? 0.5 : 0;
  const x0 = x0raw - xPad;
  const x1 = x1raw + xPad;
  const iw = Math.max(10, width - M.left - M.right);
  const ih = H - M.top - M.bottom;
  const sx = (x: number): number => M.left + ((x - x0) / (x1 - x0 || 1)) * iw;
  const sy = (y: number): number => M.top + (1 - (y - y0) / (y1 - y0 || 1)) * ih;
  const fromPy = (py: number): number => y0 + (1 - (py - M.top) / ih) * (y1 - y0);

  // The formula: separate segments where it has no value.
  const segments: string[] = [];
  let cur: string[] = [];
  for (const p of sample.line) {
    if (p.y === null) {
      if (cur.length > 1) segments.push(cur.join(' '));
      cur = [];
      continue;
    }
    cur.push(`${cur.length === 0 ? 'M' : 'L'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`);
  }
  if (cur.length > 1) segments.push(cur.join(' '));
  const single =
    sample.line.filter((p) => p.y !== null).length === 1
      ? sample.line.find((p) => p.y !== null)
      : undefined;

  const intentPath =
    intent.length > 0
      ? [x0raw, ...intent.map((p) => p.x), x1raw]
          .filter((x, i, a) => i === 0 || x > (a[i - 1] ?? -Infinity))
          .map(
            (x, i) =>
              `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(1)},${sy(intentAt(intent, x) ?? 0).toFixed(1)}`,
          )
          .join(' ')
      : '';

  const yTicks = niceTicks(y0, y1, 4).filter((t) => t >= y0 && t <= y1);
  const xTicks = sample.ticks;
  const step = yTicks.length > 1 ? (yTicks[1] as number) - (yTicks[0] as number) : (y1 - y0) / 4;

  const commit = (points: { x: number; y: number }[]): void =>
    onIntent?.(points.map((p) => ({ x: p.x, y: roundNice(p.y) })));

  const down =
    (i: number) =>
    (e: PointerEvent<SVGRectElement>): void => {
      if (!onIntent) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDrag({ index: i, points: sample.intent.map((p) => ({ ...p })), domain: [y0, y1] });
    };
  const move = (e: PointerEvent<SVGSVGElement>): void => {
    if (!drag) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const y = fromPy(e.clientY - rect.top);
    setDrag({ ...drag, points: drag.points.map((p, i) => (i === drag.index ? { ...p, y } : p)) });
  };
  const up = (): void => {
    if (!drag) return;
    commit(drag.points);
    setDrag(null);
  };
  const nudge =
    (i: number) =>
    (e: KeyboardEvent<SVGRectElement>): void => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      e.stopPropagation();
      const d = (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? step : step / 10);
      commit(sample.intent.map((p, k) => (k === i ? { ...p, y: p.y + d } : p)));
    };

  const tickLabel = (x: number): string => xTicks.find((t) => t.x === x)?.label ?? formatNumber(x);

  return (
    <div className="numbers-plot" ref={box}>
      <svg
        width={width}
        height={H}
        role="img"
        aria-label={label}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        data-testid="curve-plot"
      >
        <g className="plot-grid">
          {yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={M.left} x2={M.left + iw} y1={sy(t)} y2={sy(t)} />
              <text x={M.left - 8} y={sy(t)} dy="0.32em" textAnchor="end">
                {formatNumber(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text
              key={`x${t.x}`}
              x={sx(t.x)}
              y={H - 6}
              textAnchor="middle"
              className={categorical ? 'plot-band' : undefined}
            >
              {categorical ? t.label : formatNumber(t.x)}
            </text>
          ))}
        </g>
        {segments.map((d, i) => (
          <path key={i} d={d} className="plot-line" />
        ))}
        {single && single.y !== null && (
          <circle cx={sx(single.x)} cy={sy(single.y)} r={2} className="plot-line-point" />
        )}
        {intentPath && <path d={intentPath} className="plot-intent" data-testid="intent-line" />}
        {sample.dots.map((d) => (
          <g key={d.entity}>
            {d.off && <circle cx={sx(d.x)} cy={sy(d.y)} r={6.5} className="plot-off" />}
            <circle
              cx={sx(d.x)}
              cy={sy(d.y)}
              r={3.5}
              className="plot-dot"
              data-state={states[d.entity] ?? 'idea'}
              data-entity={d.entity}
              data-off={d.off ? '' : undefined}
              onPointerEnter={() =>
                setHover({
                  x: sx(d.x),
                  y: sy(d.y),
                  text: `${d.name}  ${formatNumber(d.y)}`,
                  ...(d.intent !== undefined && d.deviation !== undefined
                    ? {
                        sub: `intent ${formatNumber(d.intent)} · ${d.deviation > 0 ? '+' : ''}${formatNumber(Math.round(d.deviation * 100))}%`,
                      }
                    : {}),
                })
              }
              onPointerLeave={() => setHover(null)}
              onClick={() => focusEntity(d.entity)}
            />
          </g>
        ))}
        {intent.map((p, i) => {
          const active = drag?.index === i || focused === i;
          return (
            <rect
              key={i}
              x={sx(p.x) - 3}
              y={sy(p.y) - 3}
              width={6}
              height={6}
              className="plot-handle"
              data-active={active ? '' : undefined}
              data-testid="intent-handle"
              tabIndex={onIntent ? 0 : -1}
              role="slider"
              aria-label={`Intent at ${tickLabel(p.x)}`}
              aria-valuenow={roundNice(p.y)}
              aria-valuemin={roundNice(y0)}
              aria-valuemax={roundNice(y1)}
              onPointerDown={down(i)}
              onKeyDown={nudge(i)}
              onFocus={() => setFocused(i)}
              onBlur={() => setFocused(null)}
            />
          );
        })}
      </svg>
      {hover && (
        <div
          className="ui-tooltip numbers-plot-tip"
          style={{ left: hover.x, top: hover.y }}
          role="tooltip"
        >
          <span className="mono">{hover.text}</span>
          {hover.sub && <span className="mono t-2">{hover.sub}</span>}
        </div>
      )}
    </div>
  );
}
