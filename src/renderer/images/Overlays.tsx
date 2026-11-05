import { useEffect, useState, type ReactNode } from 'react';
import type { SheetOutcome, SheetReview } from '@core/images/gateway';
import { SheetReviews } from './SheetReview';
import { flash, useUi } from '../state/ui';
import { useWorld } from '../state/world';
import { Button, Dialog } from '../ui';
import { useImageActions } from './actions';
import { ImageBatch } from './Batch';
import { images, useImageSrc } from './client';
import { ImageConfirm } from './Confirm';
import { imagesOf } from './model';
import { closeImageOverlay, imageUi, OVERLAY, useImageUi } from './store';
import { describe } from './Thumb';

/** Every image overlay and the image keys. Mounted once, by the shell. */
export function ImageOverlays(): ReactNode {
  useImageActions();
  return (
    <>
      <ImageConfirm />
      <ImageBatch />
      <Lightbox />
      <Purge />
      <SheetAgain />
    </>
  );
}

/** One image, large (a click on the Bench's concept). `esc` closes it. */
function Lightbox(): ReactNode {
  const open = useImageUi((s) => s.lightbox);
  const overlay = useUi((s) => s.overlay);
  const meta = useWorld((w) =>
    open ? imagesOf(w, open.entity)?.all.find((m) => m.id === open.image) : undefined,
  );
  const show = overlay === OVERLAY.lightbox ? meta : undefined;
  // The image itself (an icon's source would be the provider's picture, not the icon).
  const src = useImageSrc(show, 'png');
  if (!show) return null;
  const close = (): void => {
    imageUi.set((s) => ({ ...s, lightbox: null }));
    closeImageOverlay('lightbox');
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={describe(show)}
      className="img-lightbox"
    >
      {src ? (
        <img
          src={src}
          alt=""
          title={describe(show)}
          className={show.kind === 'icon' ? 'img-icon' : undefined}
          data-testid="image-lightbox"
          data-image={show.id}
          onClick={close}
        />
      ) : (
        <span className="img-shimmer" style={{ width: 640, height: 427 }} />
      )}
    </Dialog>
  );
}

/** "Delete image files": purges the files of images no longer in the world, after a confirm. */
function Purge(): ReactNode {
  const open = useImageUi((s) => s.purge);
  const overlay = useUi((s) => s.overlay);
  const [busy, setBusy] = useState(false);
  if (!open || overlay !== OVERLAY.purge) return null;
  const close = (): void => {
    imageUi.set((s) => ({ ...s, purge: null }));
    closeImageOverlay('purge');
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title="Delete image files"
      showTitle
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            data-testid="image-purge-run"
            onClick={() => {
              setBusy(true);
              void images
                .deleteFiles()
                .then((r) =>
                  flash(
                    r.removed === 0
                      ? 'No files to delete'
                      : `Deleted ${r.removed} files (${Math.ceil(r.bytes / 1024)} KB)`,
                  ),
                )
                .finally(close);
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      Files of removed images are deleted for good. Undo can no longer bring those images back.
    </Dialog>
  );
}

/**
 * A kept icon sheet, reviewed again (docs/IMAGES.md §2a): re-cropped from its
 * file, free. Cells that are already their entity's icon from this sheet start
 * accepted; accepting makes icons of the newly accepted cells only.
 */
function SheetAgain(): ReactNode {
  const open = useImageUi((s) => s.review);
  const overlay = useUi((s) => s.overlay);
  if (!open || overlay !== OVERLAY.review) return null;
  return <SheetAgainBody key={open.image} entity={open.entity} image={open.image} />;
}

function SheetAgainBody({ entity, image }: { entity: string; image: string }): ReactNode {
  const [review, setReview] = useState<SheetReview | null | undefined>(undefined);
  const [accepted, setAccepted] = useState<Record<string, number[]>>({});
  const [cursor, setCursor] = useState(0);
  const [busy, setBusy] = useState(false);
  const names = useWorld((w) =>
    Object.fromEntries(Object.values(w.entities).map((e) => [e.id, e.name])),
  );
  // The cells that are already icons: their entity's chosen icon came from this cell.
  const done = useWorld((w) => {
    const out: number[] = [];
    for (const im of Object.values(w.images ?? {})) {
      const icon = im.all.find((m) => m.id === im.icon);
      if (icon?.origin.by === 'sheet' && icon.origin.sheet === image) out.push(icon.origin.cell);
    }
    return out.sort((a, b) => a - b);
  });
  useEffect(() => {
    let live = true;
    void images
      .sheetCrop({ entityId: entity, imageId: image })
      .then((r) => {
        if (!live) return;
        setReview(r);
        setAccepted({ [image]: [...(done ?? [])] });
      })
      .catch(() => live && setReview(null));
    return () => {
      live = false;
    };
    // Cropped once per sheet; `done` is the starting state only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entity, image]);
  const close = (): void => {
    imageUi.set((s) => ({ ...s, review: null }));
    closeImageOverlay('review');
  };
  const fresh = (accepted[image] ?? []).filter((c) => !(done ?? []).includes(c));
  const accept = async (): Promise<void> => {
    if (fresh.length === 0) return close();
    setBusy(true);
    const r = await images.sheetAccept({ entityId: entity, imageId: image, cells: fresh });
    setBusy(false);
    if (!r.ok) return flash(r.error.message, 'error');
    flash(
      r.images.length === 1 ? '1 icon from the sheet' : `${r.images.length} icons from the sheet`,
    );
    close();
  };
  const outcomes: SheetOutcome[] = review
    ? [
        {
          ok: true,
          review,
          receipt: { entity, kind: 'icon', prompt: '', attempts: [], costUsd: 0 },
        },
      ]
    : [];
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title="Review sheet"
      showTitle
      className="img-batch"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || !review}
            onClick={() => void accept()}
            data-testid="image-review-accept"
          >
            {fresh.length > 0 ? `Accept ${fresh.length}` : 'Done'}
          </Button>
        </>
      }
    >
      <div className="img-confirm-body" data-testid="image-sheet-again">
        {review === undefined ? (
          <span className="img-shimmer" style={{ height: 220 }} />
        ) : review === null ? (
          <span className="t-danger">The sheet's file is gone.</span>
        ) : (
          <SheetReviews
            outcomes={outcomes}
            accepted={accepted}
            names={names ?? {}}
            cursor={cursor}
            onCursor={setCursor}
            onSet={(refs, on) =>
              setAccepted((acc) => {
                const cur = new Set(acc[image] ?? []);
                for (const r of refs)
                  if (on) cur.add(r.cell);
                  else if (!(done ?? []).includes(r.cell)) cur.delete(r.cell);
                return { ...acc, [image]: [...cur].sort((x, y) => x - y) };
              })
            }
          />
        )}
      </div>
    </Dialog>
  );
}
