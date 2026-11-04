import { memo, type ReactNode } from 'react';
import { StateGlyph } from '../../ui';
import { depthTint } from '../../ui/tokens';
import type { Edge } from './edges';
import { edgeKey } from './edges';
import { CHIP_H, pxOfY, type Frame, type Glyph, type Rect } from './layout';
import { LABEL_W, RULER_W, type CellBox, type RowBox } from './model';
import { formatY, fromU, ticks } from './scale';

/** SVG layers of the Column. Everything is in content pixels. */

/** A representative height for a band's depth tint (endless bands lean further out). */
const mid = (top: number, bottom: number): number => {
  if (Number.isFinite(top) && Number.isFinite(bottom)) return (top + bottom) / 2;
  if (Number.isFinite(top)) return Math.min(top, 0) * 4 - 1024; // endless depths
  if (Number.isFinite(bottom)) return Math.max(bottom, 0) * 4 + 1024; // endless sky
  return 0;
};

export function Defs(): ReactNode {
  return (
    <defs>
      <pattern
        id="column-hatch"
        width="8"
        height="8"
        patternUnits="userSpaceOnUse"
        patternTransform="rotate(-45)"
      >
        <line x1="0" y1="0" x2="0" y2="8" className="column-hatch-line" />
      </pattern>
      <linearGradient id="column-fade-up" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="white" stopOpacity="0" />
        <stop offset="1" stopColor="white" stopOpacity="1" />
      </linearGradient>
      <linearGradient id="column-fade-down" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="white" stopOpacity="1" />
        <stop offset="1" stopColor="white" stopOpacity="0" />
      </linearGradient>
    </defs>
  );
}

/** Band backgrounds with the depth tint; unwritten heights hatched, fading at the endless ends. */
export const RowsLayer = memo(function RowsLayer({
  rows,
  x,
  width,
}: {
  rows: RowBox[];
  x: number;
  width: number;
}): ReactNode {
  return (
    <g className="column-rows">
      {rows.map((r) => {
        const h = Math.max(0, r.bottom - r.top);
        if (r.row.kind === 'band') {
          const band = r.row.band;
          return (
            <rect
              key={r.row.key}
              x={x}
              y={r.top}
              width={width}
              height={h}
              fill={depthTint(mid(band.top, band.bottom))}
              data-row={r.row.key}
            />
          );
        }
        const endless = r.row.top === Infinity ? 'up' : r.row.bottom === -Infinity ? 'down' : null;
        return (
          <g key={r.row.key} data-row={r.row.key} className="column-gap">
            {endless ? (
              <>
                <mask id={`column-mask-${r.row.key.replace(':', '-')}`}>
                  <rect
                    x={x}
                    y={r.top}
                    width={width}
                    height={h}
                    fill={`url(#column-fade-${endless})`}
                  />
                </mask>
                <rect
                  x={x}
                  y={r.top}
                  width={width}
                  height={h}
                  fill="url(#column-hatch)"
                  mask={`url(#column-mask-${r.row.key.replace(':', '-')})`}
                />
              </>
            ) : (
              <rect x={x} y={r.top} width={width} height={h} fill="url(#column-hatch)" />
            )}
          </g>
        );
      })}
    </g>
  );
});

/** The ruler: ticks on the symmetric log scale, labels at decades, an accent tick at Y 0. */
export const Ruler = memo(function Ruler({ frame }: { frame: Frame }): ReactNode {
  const ts = ticks(frame.uLo, frame.uHi, frame.pxPerU);
  const right = RULER_W - 1;
  const zero = pxOfY(frame, 0);
  return (
    <g className="column-ruler" data-testid="column-ruler">
      <line x1={right} y1={0} x2={right} y2={frame.height} className="column-ruler-line" />
      {ts.map((t) => {
        const y = Math.round(pxOfY(frame, t.y)) + 0.5;
        return (
          <g key={t.y}>
            <line
              x1={right - (t.major ? 7 : 3)}
              y1={y}
              x2={right}
              y2={y}
              className={t.major ? 'column-tick-major' : 'column-tick'}
            />
            {t.label && (
              <text x={right - 10} y={y + 3.5} className="column-tick-label" textAnchor="end">
                {t.label}
              </text>
            )}
          </g>
        );
      })}
      <line
        x1={right - 11}
        y1={Math.round(zero) + 0.5}
        x2={right + 1}
        y2={Math.round(zero) + 0.5}
        className="column-zero"
        data-testid="column-zero"
      />
    </g>
  );
});

/** Band names and spans in the label column. */
export const BandLabels = memo(function BandLabels({ rows }: { rows: RowBox[] }): ReactNode {
  const height = rows.length > 0 ? Math.max(...rows.map((r) => r.bottom)) : 0;
  return (
    <g className="column-labels" clipPath="url(#column-label-clip)">
      <clipPath id="column-label-clip">
        <rect
          x={RULER_W}
          y={Math.min(0, ...rows.map((r) => r.top))}
          width={LABEL_W - 4}
          height={height + 1}
        />
      </clipPath>
      {rows.map((r) => {
        if (r.row.kind !== 'band') return null;
        const h = r.bottom - r.top;
        if (h < 14) return null;
        const band = r.row.band;
        // An endless-sky band reads from its finite (bottom) edge.
        const fromBottom = band.top === Infinity && Number.isFinite(band.bottom);
        const y = fromBottom ? r.bottom - (h >= 34 ? 24 : 6) : r.top + 15;
        return (
          <g key={r.row.key} data-band={band.id}>
            <StateMark x={RULER_W + 8} y={y - 8} state={band.state} />
            <text x={RULER_W + 22} y={y} className="column-band-name">
              {band.name.length > 13 ? `${band.name.slice(0, 12)}…` : band.name}
            </text>
            {h >= 34 && (
              <text x={RULER_W + 22} y={y + 14} className="column-band-span">
                {formatY(band.bottom)} … {formatY(band.top)}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
});

function StateMark({ x, y, state }: { x: number; y: number; state: Glyph['state'] }): ReactNode {
  return (
    <g transform={`translate(${x},${y})`}>
      <StateGlyph state={state} size={10} tooltip={false} />
    </g>
  );
}

/** One chip: the state glyph and the (possibly truncated) name. */
const Chip = memo(function Chip({
  g,
  row,
  cursor,
}: {
  g: Glyph;
  row: string;
  cursor: boolean;
}): ReactNode {
  return (
    <g
      className="column-chip"
      transform={`translate(${g.x},${g.y})`}
      data-id={g.id}
      data-row={row}
      data-state={g.state}
      data-inferred={g.inferred ? '' : undefined}
      data-cursor={cursor ? '' : undefined}
    >
      <rect width={g.w} height={CHIP_H} rx={4} className="column-chip-box" />
      <StateMark x={6} y={5} state={g.state} />
      <text x={19} y={14} className="column-chip-text">
        {g.text}
      </text>
    </g>
  );
});

export const Cell = memo(function Cell({
  cell,
  cursorId,
}: {
  cell: CellBox;
  cursorId: string | null;
}): ReactNode {
  return (
    <g data-cell={cell.key}>
      {cell.glyphs.map((g) => (
        <Chip key={g.id} g={g} row={cell.row} cursor={g.id === cursorId} />
      ))}
      {cell.more && (
        <g
          className="column-more"
          transform={`translate(${cell.more.x},${cell.more.y})`}
          data-more={cell.key}
          data-cursor={cursorId !== null && cell.hidden.includes(cursorId) ? '' : undefined}
        >
          <rect width={cell.more.w} height={CHIP_H} rx={4} className="column-chip-box" />
          <text x={cell.more.w / 2} y={14} textAnchor="middle" className="column-more-text">
            +{cell.more.count}
          </text>
        </g>
      )}
    </g>
  );
});

/** Lane separators and band edges (draggable where finite). */
export function Grid({
  rows,
  laneX,
  laneW,
  right,
  edges,
  frame,
  dragging,
}: {
  rows: RowBox[];
  laneX: number[];
  laneW: number;
  right: number;
  edges: Edge[];
  frame: Frame;
  dragging: string | null;
}): ReactNode {
  const left = RULER_W;
  const height = rows.length > 0 ? Math.max(...rows.map((r) => r.bottom)) : 0;
  return (
    <g className="column-grid">
      {[
        ...laneX,
        laneX.length > 0 ? (laneX[laneX.length - 1] ?? 0) + laneW : RULER_W + LABEL_W,
      ].map((x) => (
        <line key={x} x1={x + 0.5} y1={0} x2={x + 0.5} y2={height} className="column-lane-line" />
      ))}
      {edges.map((e) => {
        const y = Math.round(pxOfY(frame, e.y)) + 0.5;
        const key = edgeKey(e);
        return (
          <g
            key={key}
            className="column-edge"
            data-edge={key}
            data-dragging={dragging === key ? '' : undefined}
          >
            <line x1={left} y1={y} x2={right} y2={y} className="column-edge-line" />
            <rect x={left} y={y - 4} width={right - left} height={8} className="column-edge-hit" />
          </g>
        );
      })}
    </g>
  );
}

/** The cursor: a soft glow on the cell (or band label) it's on. */
export function CursorMark({ rect }: { rect: Rect | null }): ReactNode {
  if (!rect) return null;
  return (
    <rect
      x={rect.x + 1}
      y={rect.y + 1}
      width={Math.max(0, rect.w - 2)}
      height={Math.max(0, rect.h - 2)}
      rx={6}
      className="column-cursor"
      data-testid="column-cursor"
    />
  );
}

/** The band being drawn on the ruler. */
export function DrawPreview({
  frame,
  from,
  to,
  x,
  width,
}: {
  frame: Frame;
  from: number;
  to: number;
  x: number;
  width: number;
}): ReactNode {
  const a = pxOfY(frame, Math.max(from, to));
  const b = pxOfY(frame, Math.min(from, to));
  return (
    <g className="column-draw">
      <rect x={x} y={a} width={width} height={Math.max(1, b - a)} className="column-draw-box" />
      <text x={x + 8} y={a + 14} className="column-band-span">
        {formatY(Math.min(from, to))} … {formatY(Math.max(from, to))}
      </text>
    </g>
  );
}

/** Y at a content px (for pointer interactions). */
export const yAtPx = (frame: Frame, px: number): number =>
  fromU(Math.max(frame.uLo, Math.min(frame.uHi, frame.uHi - px / frame.pxPerU)));
