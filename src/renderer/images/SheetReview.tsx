import type { ReactNode } from 'react';
import type { SheetOutcome } from '@core/images/gateway';
import { Tooltip, cx } from '../ui';

const FLAG_TEXT: Record<string, string> = {
  empty: 'empty cell',
  background_only: 'only background',
  touches_edge: 'touches the cell edge',
  fragmented: 'in several pieces',
};

/**
 * The review of generated icon sheets (docs/IMAGES.md §2a): the sheet with
 * its grid, and each cell's 16×16 result. A click accepts or rejects a cell;
 * unflagged cells start accepted, flagged ones (a hairline in --warn) wait
 * for you. Names, flags and the crop are in the tooltips.
 */
export function SheetReviews({
  outcomes,
  accepted,
  names,
  onToggle,
}: {
  outcomes: SheetOutcome[];
  accepted: Record<string, number[]>;
  names: Record<string, string>;
  onToggle: (sheet: string, cell: number) => void;
}): ReactNode {
  return (
    <div className="img-sheets" data-testid="image-sheets">
      {outcomes.map((sh, i) =>
        sh.ok ? (
          <div
            key={sh.review.sheet.id}
            className="img-sheet"
            data-testid="image-sheet"
            data-image={sh.review.sheet.id}
          >
            <img
              src={sh.review.preview.dataUrl}
              alt=""
              className="img-thumb img-ai img-sheet-preview"
              title={`${sh.review.cells.length} cells`}
            />
            <div className="img-sheet-cells">
              {sh.review.cells.map((c) => {
                const on = (accepted[sh.review.sheet.id] ?? []).includes(c.index);
                const tip = [
                  names[c.entityId] ?? c.entityId,
                  ...c.flags.map((f) => FLAG_TEXT[f] ?? f),
                ].join(' · ');
                return (
                  <Tooltip key={c.index} content={tip}>
                    <button
                      type="button"
                      className={cx(
                        'img-cell',
                        on && 'img-cell-on',
                        c.flags.length > 0 && 'img-cell-flagged',
                      )}
                      aria-pressed={on}
                      aria-label={tip}
                      disabled={!c.icon}
                      onClick={() => onToggle(sh.review.sheet.id, c.index)}
                      data-testid="image-cell"
                      data-entity={c.entityId}
                      data-flagged={c.flags.length > 0 ? '' : undefined}
                    >
                      {c.icon ? (
                        <img src={c.icon.dataUrl} alt="" className="img-icon" />
                      ) : (
                        <span className="img-cell-empty" />
                      )}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          </div>
        ) : (
          <div
            key={`failed-${i}`}
            className="img-sheet img-sheet-failed"
            data-testid="image-sheet-failed"
          >
            <span className="t-danger">
              {sh.error.unknownOutcome
                ? `${sh.error.message}. It may have been charged; not retried.`
                : sh.error.message}
            </span>
            <span className="t-3 t-meta">{sh.entityIds.map((e) => names[e] ?? e).join(', ')}</span>
          </div>
        ),
      )}
    </div>
  );
}
