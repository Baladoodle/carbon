import { memo, type ReactNode } from 'react';
import type { Note } from '@core/model/notes';
import { dismissNote } from '../../state/notes';
import { IconButton, IconClose } from '../../ui';
import { pxOfY, stackMargin, type Measure } from './layout';
import { MARGIN_W, type ColumnModel, type Geometry } from './model';

const NOTE_LINE = 17;
const NOTE_PAD = 10;
const TEXT_W = MARGIN_W - 16 - 2 * 8 - 20;

/** Where a note wants to sit: its own height, else its first entity's glyph, else that entity's band. */
function wantedPx(note: Note, model: ColumnModel, geo: Geometry): number | null {
  if (note.y !== undefined) return pxOfY(geo.frame, note.y) - 10;
  for (const id of note.entities) {
    const g = geo.glyphsOf.get(id)?.[0];
    if (g) return g.y;
    const band = model.placements.get(id)?.places[0]?.band;
    const row = geo.rows.find((r) => r.row.key === (band ?? id));
    if (row) return Number.isFinite(row.top) ? row.top + 6 : null;
  }
  return null;
}

function estimateHeight(text: string, measure: Measure): number {
  const lines = Math.max(1, Math.ceil(measure(text) / TEXT_W));
  return lines * NOTE_LINE + NOTE_PAD;
}

/**
 * Notes (mechanical checks and AI critique) in the right margin, at the height
 * they're about, stacked so they never overlap. Clicking one puts its first
 * entity on the Bench.
 */
export const Margin = memo(function Margin({
  notes,
  model,
  geo,
  measure,
  onOpen,
}: {
  notes: Note[];
  model: ColumnModel;
  geo: Geometry;
  measure: Measure;
  onOpen: (id: string) => void;
}): ReactNode {
  const placed = notes
    .map((n) => ({ n, want: wantedPx(n, model, geo) }))
    .filter((x): x is { n: Note; want: number } => x.want !== null);
  const items = placed.map((x) => ({
    id: x.n.id,
    want: x.want,
    height: estimateHeight(x.n.text, measure),
  }));
  const tops = stackMargin(items);
  return (
    <div className="column-margin" style={{ left: geo.marginX }} data-testid="column-margin">
      {placed.map(({ n }, i) => (
        <div
          key={n.id}
          className="column-note"
          data-source={n.source}
          data-severity={n.severity}
          data-note={n.id}
          style={{ top: tops[i] }}
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
