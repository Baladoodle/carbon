import { useEffect, useRef, type ReactNode } from 'react';
import type { SheetCellReview, SheetOutcome } from '@core/images/gateway';
import { useActions } from '../actions';
import { Button, Tooltip, cx } from '../ui';

const FLAG_TEXT: Record<string, string> = {
  empty: 'empty',
  background_only: 'background only',
  touches_edge: 'touches edge',
  fragmented: 'fragmented',
};

export interface CellRef {
  sheet: string;
  cell: number;
}

/** Every reviewable cell, in order: sheet by sheet, reading order. */
export function cellsOf(
  outcomes: SheetOutcome[],
): (CellRef & { c: SheetCellReview; cols: number })[] {
  return outcomes.flatMap((sh) =>
    sh.ok
      ? sh.review.cells.map((c) => ({
          sheet: sh.review.sheet.id,
          cell: c.index,
          c,
          cols:
            sh.review.sheet.sheet?.cols ?? Math.max(1, ...sh.review.cells.map((x) => x.col + 1)),
        }))
      : [],
  );
}

/**
 * The review of generated icon sheets (docs/IMAGES.md §2a): each sheet with
 * its grid drawn over it, and each cell's crop, its 16×16 result (pixelated)
 * and its flags. Unflagged cells start accepted; flagged ones (a --warn
 * hairline) wait for you. Keyboard-driven like spread triage: arrows move,
 * `k` accepts, `x` rejects, `a` accepts every unflagged cell.
 */
export function SheetReviews({
  outcomes,
  accepted,
  names,
  cursor,
  onCursor,
  onSet,
}: {
  outcomes: SheetOutcome[];
  accepted: Record<string, number[]>;
  names: Record<string, string>;
  cursor: number;
  onCursor: (i: number) => void;
  onSet: (cells: CellRef[], on: boolean) => void;
}): ReactNode {
  const all = cellsOf(outcomes);
  const at = Math.min(cursor, Math.max(0, all.length - 1));
  const cur = all[at];
  const isOn = (r: CellRef): boolean => (accepted[r.sheet] ?? []).includes(r.cell);
  const move = (d: number) => (): void => onCursor(Math.max(0, Math.min(all.length - 1, at + d)));
  const unflagged = all.filter((x) => x.c.flags.length === 0 && x.c.icon);
  useActions([
    {
      id: 'sheet.left',
      label: 'Previous cell',
      keys: ['arrowleft', 'h'],
      hidden: true,
      run: move(-1),
    },
    {
      id: 'sheet.right',
      label: 'Next cell',
      keys: ['arrowright', 'l'],
      hidden: true,
      run: move(1),
    },
    {
      id: 'sheet.up',
      label: 'Cell above',
      keys: ['arrowup'],
      hidden: true,
      run: move(-(cur?.cols ?? 1)),
    },
    {
      id: 'sheet.down',
      label: 'Cell below',
      keys: ['arrowdown'],
      hidden: true,
      run: move(cur?.cols ?? 1),
    },
    {
      id: 'sheet.accept',
      label: 'Accept the cell',
      keys: ['k'],
      hidden: true,
      enabled: () => !!cur?.c.icon,
      run: () => {
        if (!cur) return;
        onSet([cur], true);
        move(1)();
      },
    },
    {
      id: 'sheet.reject',
      label: 'Reject the cell',
      keys: ['x'],
      hidden: true,
      enabled: () => !!cur,
      run: () => {
        if (!cur) return;
        onSet([cur], false);
        move(1)();
      },
    },
    {
      id: 'sheet.accept-unflagged',
      label: 'Accept every unflagged cell',
      keys: ['a'],
      hidden: true,
      run: () => onSet(unflagged, true),
    },
  ]);
  const curEl = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    curEl.current?.scrollIntoView({ block: 'nearest' });
  }, [at]);

  return (
    <div className="img-sheets" data-testid="image-sheets">
      <div className="img-sheet-bar">
        <span className="num t-2" data-testid="image-sheet-count">
          {all.filter(isOn).length} of {all.length} accepted
        </span>
        <span className="bench-head-spacer" />
        <Tooltip content="Accept every unflagged cell" keys="a">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onSet(unflagged, true)}
            data-testid="image-accept-unflagged"
          >
            Accept unflagged
          </Button>
        </Tooltip>
      </div>
      {outcomes.map((sh, i) =>
        sh.ok ? (
          <div
            key={sh.review.sheet.id}
            className="img-sheet"
            data-testid="image-sheet"
            data-image={sh.review.sheet.id}
          >
            <SheetPreview
              outcome={sh}
              cursor={cur?.sheet === sh.review.sheet.id ? cur.cell : null}
            />
            <div className="img-sheet-cells">
              {sh.review.cells.map((c) => {
                const ref = { sheet: sh.review.sheet.id, cell: c.index };
                const on = isOn(ref);
                const here = cur?.sheet === ref.sheet && cur.cell === ref.cell;
                const name = names[c.entityId] ?? c.entityId;
                return (
                  <button
                    key={c.index}
                    ref={here ? curEl : undefined}
                    type="button"
                    className={cx(
                      'img-cell',
                      on && 'img-cell-on',
                      here && 'img-cell-cursor',
                      c.flags.length > 0 && 'img-cell-flagged',
                    )}
                    aria-pressed={on}
                    aria-label={name}
                    disabled={!c.icon}
                    onClick={() => {
                      onCursor(all.findIndex((x) => x.sheet === ref.sheet && x.cell === ref.cell));
                      onSet([ref], !on);
                    }}
                    data-testid="image-cell"
                    data-entity={c.entityId}
                    data-flagged={c.flags.length > 0 ? '' : undefined}
                    data-cursor={here ? '' : undefined}
                  >
                    <span className="img-cell-pics">
                      {c.crop ? (
                        <img src={c.crop.dataUrl} alt="" className="img-cell-crop" />
                      ) : (
                        <span className="img-cell-empty" />
                      )}
                      {c.icon && (
                        <img src={c.icon.dataUrl} alt="" className="img-icon img-cell-icon" />
                      )}
                    </span>
                    <span className="img-cell-name">{name}</span>
                    {c.flags.length > 0 && (
                      <span className="img-cell-flags t-warn">
                        {c.flags.map((f) => FLAG_TEXT[f] ?? f).join(', ')}
                      </span>
                    )}
                  </button>
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

/** The sheet with its grid drawn over it (cells as the layout placed them). */
function SheetPreview({
  outcome,
  cursor,
}: {
  outcome: Extract<SheetOutcome, { ok: true }>;
  cursor: number | null;
}): ReactNode {
  const { review } = outcome;
  const g = review.sheet.sheet;
  const boxes: { index: number; l: number; t: number; w: number; h: number }[] = [];
  if (g) {
    const cw = (g.canvas.w - g.gutter * (g.cols + 1)) / g.cols;
    const ch = (g.canvas.h - g.gutter * (g.rows + 1)) / g.rows;
    for (const c of review.cells)
      boxes.push({
        index: c.index,
        l: ((g.gutter + c.col * (cw + g.gutter)) / g.canvas.w) * 100,
        t: ((g.gutter + c.row * (ch + g.gutter)) / g.canvas.h) * 100,
        w: (cw / g.canvas.w) * 100,
        h: (ch / g.canvas.h) * 100,
      });
  }
  return (
    <div className="img-sheet-preview" data-testid="image-sheet-preview">
      <img src={review.preview.dataUrl} alt="" className="img-thumb img-ai" />
      {boxes.map((b) => (
        <span
          key={b.index}
          className={cx('img-sheet-box', b.index === cursor && 'img-sheet-box-cursor')}
          style={{ left: `${b.l}%`, top: `${b.t}%`, width: `${b.w}%`, height: `${b.h}%` }}
          data-testid="image-sheet-box"
        />
      ))}
    </div>
  );
}
