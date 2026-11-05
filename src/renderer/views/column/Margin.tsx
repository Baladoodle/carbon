import { memo, useMemo, type ReactNode } from 'react';
import type { Note } from '@core/model/notes';
import { dismissNote } from '../../state/notes';
import { IconButton, IconClose } from '../../ui';
import { pxOfY, stackMargin, type Measure } from '@core/column/layout';
import { MARGIN_W, type ColumnModel, type Geometry } from '@core/column/model';

const NOTE_LINE = 17;
const NOTE_PAD = 10;
const TEXT_W = MARGIN_W - 16 - 2 * 8 - 20;

function estimateHeight(text: string, measure: Measure): number {
  const lines = Math.max(1, Math.ceil(measure(text) / TEXT_W));
  return lines * NOTE_LINE + NOTE_PAD;
}

/** Every note's place in the margin: stacked top to bottom without overlap. */
function layoutMargin(
  notes: Note[],
  model: ColumnModel,
  geo: Geometry,
  measure: Measure,
): { n: Note; top: number; height: number }[] {
  const rowTop = new Map(geo.rows.map((r) => [r.row.key, r.top]));
  const want = (note: Note): number | null => {
    if (note.y !== undefined) return pxOfY(geo.frame, note.y) - 10;
    for (const id of note.entities) {
      const g = geo.glyphsOf.get(id)?.[0];
      if (g) return g.y;
      const band = model.placements.get(id)?.places[0]?.band;
      const top = rowTop.get(band ?? id);
      if (top !== undefined) return Number.isFinite(top) ? top + 6 : null;
    }
    return null;
  };
  const placed = notes
    .map((n) => ({ n, want: want(n), height: estimateHeight(n.text, measure) }))
    .filter((x): x is { n: Note; want: number; height: number } => x.want !== null);
  // Most edits move no note (a rename, a state change): reuse the stack, skipping its sort.
  const same =
    last !== null &&
    last.placed.length === placed.length &&
    placed.every((x, i) => {
      const y = last?.placed[i];
      return !!y && y.n === x.n && y.want === x.want && y.height === x.height;
    });
  const tops =
    same && last
      ? last.tops
      : stackMargin(placed.map((x) => ({ id: x.n.id, want: x.want, height: x.height })));
  last = { placed, tops };
  return placed.map((x, i) => ({ n: x.n, top: tops[i] ?? x.want, height: x.height }));
}

/** The last stack laid out (one Column is mounted at a time). */
let last: { placed: { n: Note; want: number; height: number }[]; tops: number[] } | null = null;

/**
 * Notes (mechanical checks and AI critique) in the right margin, at the height
 * they're about, stacked so they never overlap. Clicking one puts its first
 * entity on the Bench. The stack is laid out once per change; only the notes
 * in the visible `range` (content px) are rendered, so a world with thousands
 * of notes still pans smoothly.
 */
export const Margin = memo(function Margin({
  notes,
  model,
  geo,
  measure,
  range,
  onOpen,
}: {
  notes: Note[];
  model: ColumnModel;
  geo: Geometry;
  measure: Measure;
  range: readonly [number, number];
  onOpen: (id: string) => void;
}): ReactNode {
  const laid = useMemo(
    () => layoutMargin(notes, model, geo, measure),
    [notes, model, geo, measure],
  );
  const shown = laid.filter((x) => x.top + x.height >= range[0] && x.top <= range[1]);
  return (
    <div className="column-margin" style={{ left: geo.marginX }} data-testid="column-margin">
      {shown.map(({ n, top }) => (
        <div
          key={n.id}
          className="column-note"
          data-source={n.source}
          data-severity={n.severity}
          data-note={n.id}
          style={{ top }}
        >
          <button
            type="button"
            className="column-note-text"
            onClick={() => n.entities[0] && onOpen(n.entities[0])}
          >
            {n.text}
          </button>
          <IconButton
            size="sm"
            label="Dismiss"
            icon={<IconClose />}
            className="column-note-dismiss"
            onClick={() => dismissNote(n.id)}
          />
        </div>
      ))}
    </div>
  );
});
