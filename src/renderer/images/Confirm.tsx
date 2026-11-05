import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ImageEstimate } from '@core/images/gateway';
import {
  DEFAULT_SIZE,
  IMAGE_MODELS,
  IMAGE_QUALITIES,
  IMAGE_SIZES,
  type ImageModel,
  type ImageQuality,
  type ImageSize,
} from '@core/images/model';
import { flash, useUi } from '../state/ui';
import { useWorld } from '../state/world';
import { Button, Dialog, Field, Kbd, Select, Textarea, cx } from '../ui';
import { estimateText, images, imageStatusStore, newRequestId, useImageStatus } from './client';
import type { ImageKind } from './model';
import { closeImageOverlay, imageUi, OVERLAY, setPending, useImageUi } from './store';
import { Shimmer } from './Thumb';

export const SIZE_LABEL: Record<ImageSize, string> = {
  '1536x1024': '1536 × 1024',
  '1024x1024': '1024 × 1024',
  '1024x1536': '1024 × 1536',
};
const MODEL_LABEL: Record<ImageModel, string> = {
  'gpt-image-2.6-flare': 'Images 2.6 flare',
  'gpt-image-2.6-sunburst': 'Images 2.6 sunburst',
};
export const modelOptions = IMAGE_MODELS.map((m) => ({ value: m, label: MODEL_LABEL[m] }));
export const qualityOptions = IMAGE_QUALITIES.map((q) => ({ value: q, label: q }));
/** Icons are generated square and filtered to 16×16; concepts can be any of the sizes. */
export const sizesFor = (kind: ImageKind): ImageSize[] =>
  kind === 'icon' ? ['1024x1024'] : [...IMAGE_SIZES];

/** The model and quality a new call starts with: the settings' (low, flare by default). */
function defaults(): { model: ImageModel; quality: ImageQuality } {
  const s = imageStatusStore.get();
  return { model: s.model, quality: s.quality };
}

/**
 * Runs a confirmed call: the image lands in place (a shimmer meanwhile), and
 * a failure says what happened, including when a call may have been charged.
 */
export async function runConfirmed(p: {
  entity: string;
  kind: ImageKind;
  prompt: string;
  model: ImageModel;
  quality: ImageQuality;
  size: ImageSize;
}): Promise<void> {
  setPending(p.entity, p.kind, true);
  try {
    const r = await images.generate({
      requestId: newRequestId(),
      entityId: p.entity,
      kind: p.kind,
      prompt: p.prompt,
      model: p.model,
      quality: p.quality,
      size: p.size,
    });
    if (!r.ok)
      flash(
        r.error.unknownOutcome
          ? `${r.error.message}. It may have been charged; not retried.`
          : r.error.message,
        'error',
      );
  } finally {
    setPending(p.entity, p.kind, false);
  }
}

/**
 * The confirm step every paid call goes through (docs/IMAGES.md §6): the
 * prompt Claude wrote (editable, or write your own), the model, quality and
 * size, the estimated cost. Nothing is sent before `enter`; `esc` cancels.
 */
export function ImageConfirm(): ReactNode {
  const open = useImageUi((s) => s.confirm);
  const overlay = useUi((s) => s.overlay);
  if (!open || overlay !== OVERLAY.confirm) return null;
  return <ConfirmBody key={`${open.entity}:${open.kind}`} entity={open.entity} kind={open.kind} />;
}

function ConfirmBody({ entity, kind }: { entity: string; kind: ImageKind }): ReactNode {
  const name = useWorld((w) => w.entities[entity]?.name ?? entity);
  const status = useImageStatus();
  const [prompt, setPrompt] = useState('');
  // The prompt is Claude's until you type in it.
  const [mine, setMine] = useState(false);
  const [writing, setWriting] = useState(true);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [opts, setOpts] = useState(() => ({ ...defaults(), size: DEFAULT_SIZE[kind] }));
  const [estimate, setEstimate] = useState<ImageEstimate | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  // Claude writes the prompt (the image_prompt moment); cancelling the dialog cancels it.
  useEffect(() => {
    const requestId = newRequestId('prompt');
    let live = true;
    void images.prompt(entity, kind, requestId).then((r) => {
      if (!live) return;
      setWriting(false);
      if (r.ok) setPrompt((p) => (p === '' ? r.prompt : p));
      else setPromptError(r.error.message);
      requestAnimationFrame(() => area.current?.focus());
    });
    return () => {
      live = false;
      void images.cancel(requestId);
    };
  }, [entity, kind]);

  // The estimate follows every choice (and the prompt's length).
  const chars = prompt.length;
  useEffect(() => {
    let live = true;
    void images
      .estimate({ kind, ...opts, calls: 1, promptChars: chars })
      .then((e) => live && setEstimate(e))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [kind, opts, chars]);

  const close = (): void => {
    imageUi.set((s) => ({ ...s, confirm: null }));
    closeImageOverlay('confirm');
  };
  const over = !!estimate && estimate.totalUsd > estimate.remainingUsd;
  const canRun = prompt.trim() !== '' && status.enabled && !status.paused && !over;
  const go = (): void => {
    if (!canRun) return;
    close();
    void runConfirmed({ entity, kind, prompt: prompt.trim(), ...opts });
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.nativeEvent.isComposing) return;
    // A select's own enter opens it.
    if ((e.target as Element).closest('[role="combobox"]')) return;
    e.preventDefault();
    e.stopPropagation();
    go();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={`${kind === 'icon' ? 'Icon' : 'Concept'} for ${name ?? entity}`}
      className="img-confirm"
      footer={
        <>
          <Button variant="ghost" onClick={close} data-testid="image-confirm-cancel">
            Cancel <Kbd>esc</Kbd>
          </Button>
          <Button variant="primary" disabled={!canRun} onClick={go} data-testid="image-confirm-run">
            Generate <Kbd>enter</Kbd>
          </Button>
        </>
      }
    >
      <div
        className="img-confirm-body"
        data-testid="image-confirm"
        data-kind={kind}
        data-entity={entity}
        onKeyDown={onKeyDown}
      >
        <div className="img-confirm-head">
          <span className="img-confirm-name">{name}</span>
          <span className="img-confirm-kind t-3">{kind === 'icon' ? 'icon' : 'concept'}</span>
        </div>
        <Field error={promptError ? `${promptError}. Write the prompt yourself.` : null}>
          <div className={cx('img-prompt', !mine && prompt !== '' && 'img-prompt-ai')}>
            <Textarea
              ref={area}
              aria-label="Prompt"
              value={prompt}
              onChange={(e) => {
                setMine(true);
                setPrompt(e.target.value);
              }}
              data-testid="image-prompt"
              data-writing={writing ? '' : undefined}
              autoFocus
            />
            {writing && prompt === '' && <Shimmer />}
          </div>
        </Field>
        <div className="img-options">
          <Field label="Model">
            <Select
              value={opts.model}
              onValueChange={(v) => setOpts((o) => ({ ...o, model: v as ImageModel }))}
              options={modelOptions}
              aria-label="Model"
            />
          </Field>
          <Field label="Quality">
            <Select
              value={opts.quality}
              onValueChange={(v) => setOpts((o) => ({ ...o, quality: v as ImageQuality }))}
              options={qualityOptions}
              aria-label="Quality"
            />
          </Field>
          <Field label="Size">
            <Select
              value={opts.size}
              onValueChange={(v) => setOpts((o) => ({ ...o, size: v as ImageSize }))}
              options={sizesFor(kind).map((s) => ({ value: s, label: SIZE_LABEL[s] }))}
              aria-label="Size"
              disabled={kind === 'icon'}
            />
          </Field>
          <div className="img-cost">
            <span className="img-cost-total" data-testid="image-estimate">
              {estimate ? estimateText(estimate.totalUsd) : '…'}
            </span>
            {estimate && (
              <span className={cx('img-cost-left num', over ? 't-danger' : 't-3')}>
                {estimateText(Math.max(0, estimate.remainingUsd))} left
              </span>
            )}
          </div>
        </div>
        {(status.paused || !status.enabled) && (
          <div className="img-error t-warn" data-testid="image-confirm-blocked">
            {status.paused
              ? `Images paused: ${status.reason ?? 'budget reached'}`
              : `Images are off${status.reason ? `: ${status.reason}` : ''}`}
          </div>
        )}
        {!status.paused && over && (
          <div className="img-error t-danger" data-testid="image-confirm-blocked">
            Over the session budget
          </div>
        )}
      </div>
    </Dialog>
  );
}
