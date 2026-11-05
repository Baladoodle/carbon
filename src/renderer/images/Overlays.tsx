import { useState, type ReactNode } from 'react';
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
  const show = !!open && overlay === OVERLAY.lightbox && !!meta;
  // The full image for a concept (the source for an icon would be the provider's, not the icon).
  const src = useImageSrc(show ? meta : null, 'png');
  if (!show || !meta) return null;
  const close = (): void => {
    imageUi.set((s) => ({ ...s, lightbox: null }));
    closeImageOverlay('lightbox');
  };
  return (
    <Dialog open onOpenChange={(o) => !o && close()} title={describe(meta)} className="img-lightbox">
      {src ? (
        <img
          src={src}
          alt=""
          title={describe(meta)}
          className={meta.kind === 'icon' ? 'img-icon' : undefined}
          data-testid="image-lightbox"
          data-image={meta.id}
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
