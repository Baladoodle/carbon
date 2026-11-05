import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { BatchResult, ImageEstimate, ImageResult } from '@core/images/gateway';
import {
  DEFAULT_SIZE,
  type ImageModel,
  type ImageQuality,
  type ImageSize,
} from '@core/images/model';
import { flash, useUi } from '../state/ui';
import { currentWorld, useWorld } from '../state/world';
import { Button, Dialog, Field, Kbd, Select, Textarea, Tooltip, cx } from '../ui';
import { estimateText, images, imageStatusStore, newRequestId, useImageStatus } from './client';
import { modelOptions, qualityOptions, SIZE_LABEL, sizesFor } from './Confirm';
import { selected, type ImageKind } from './model';
import { closeImageOverlay, imageUi, OVERLAY, setPending, useImageUi } from './store';
import { Shimmer, Thumb } from './Thumb';

interface Row {
  entityId: string;
  name: string;
  prompt: string;
  /** It already has one of this kind (skipped unless replace). */
  has: boolean;
  /** Why it can't run at all (its prompt failed, it's gone). */
  failed?: string;
}

type Phase = 'planning' | 'ready' | 'running' | 'done';

/**
 * The batch dialog (docs/IMAGES.md §6): every prompt, each editable; the
 * model and quality; the call count and the estimated total; skip-existing
 * or replace. Nothing runs until you confirm. Then: progress, cancel, and a
 * result per item.
 */
export function ImageBatch(): ReactNode {
  const open = useImageUi((s) => s.batch);
  const overlay = useUi((s) => s.overlay);
  if (!open || overlay !== OVERLAY.batch) return null;
  return <BatchBody key={`${open.kind}:${open.entities.join(',')}`} {...open} />;
}

function BatchBody({ entities, kind }: { entities: string[]; kind: ImageKind }): ReactNode {
  const status = useImageStatus();
  const names = useWorld((w) => entities.map((id) => w.entities[id]?.name ?? id));
  const [phase, setPhase] = useState<Phase>('planning');
  const [rows, setRows] = useState<Row[]>([]);
  const [replace, setReplace] = useState(false);
  const [opts, setOpts] = useState(() => {
    const s = imageStatusStore.get();
    return { model: s.model, quality: s.quality, size: DEFAULT_SIZE[kind] };
  });
  const [estimate, setEstimate] = useState<ImageEstimate | null>(null);
  const [results, setResults] = useState<Record<string, ImageResult>>({});
  const [progress, setProgress] = useState<{ done: number; total: number; cost: number }>({
    done: 0,
    total: 0,
    cost: 0,
  });
  const batchId = useRef(newRequestId('batch'));
  const phaseRef = useRef<Phase>('planning');
  phaseRef.current = phase;

  // Claude writes every prompt first (no OpenAI call). Entities that already
  // have one get a prompt too, so ticking "replace" needs no second pass.
  useEffect(() => {
    const requestId = newRequestId('plan');
    let live = true;
    void images
      .batchPlan({ kind, entityIds: entities, replace: true, requestId, ...opts })
      .then((plan) => {
        if (!live) return;
        const w = currentWorld();
        setRows(
          plan.items.map((it) => ({
            entityId: it.entityId,
            name: it.name,
            prompt: it.prompt ?? '',
            has: !!w && !!selected(w, it.entityId, kind),
            ...(it.skip && it.skip !== 'has_image'
              ? { failed: it.error?.message ?? it.skip.replace('_', ' ') }
              : {}),
          })),
        );
        setPhase('ready');
      })
      .catch((e: unknown) => {
        if (!live) return;
        flash(e instanceof Error ? e.message : String(e), 'error');
        setPhase('ready');
      });
    return () => {
      live = false;
      if (phaseRef.current === 'planning') void images.cancel(requestId);
    };
    // The plan is written once; model and quality don't change the prompts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, entities]);

  const runnable = useMemo(
    () => rows.filter((r) => !r.failed && (replace || !r.has) && r.prompt.trim() !== ''),
    [rows, replace],
  );
  const calls = runnable.length;
  useEffect(() => {
    let live = true;
    void images
      .estimate({ kind, ...opts, calls })
      .then((e) => live && setEstimate(e))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [kind, opts, calls]);

  const close = (): void => {
    if (phaseRef.current === 'running') void images.cancel(batchId.current);
    imageUi.set((s) => ({ ...s, batch: null }));
    closeImageOverlay('batch');
  };
  const over = !!estimate && estimate.totalUsd > estimate.remainingUsd;
  const canRun =
    phase === 'ready' && calls > 0 && status.enabled && !status.paused && !over;

  const run = async (): Promise<void> => {
    if (!canRun) return;
    setPhase('running');
    setProgress({ done: 0, total: calls, cost: 0 });
    for (const r of runnable) setPending(r.entityId, kind, true);
    let out: BatchResult | null = null;
    try {
      out = await images.batchRun(
        {
          batchId: batchId.current,
          kind,
          items: runnable.map((r) => ({ entityId: r.entityId, prompt: r.prompt.trim() })),
          ...opts,
        },
        (p) => {
          setProgress({ done: p.done, total: p.total, cost: p.costUsd });
          const item = p.item;
          if (item) {
            setPending(item.entityId, kind, false);
            setResults((rs) => ({ ...rs, [item.entityId]: item.result }));
          }
        },
      );
    } catch (e) {
      flash(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      for (const r of runnable) setPending(r.entityId, kind, false);
    }
    if (out) {
      const final = out;
      setResults(Object.fromEntries(final.items.map((i) => [i.entityId, i.result])));
      setProgress((p) => ({
        ...p,
        done: final.items.filter((i) => i.result.ok).length,
        cost: final.costUsd,
      }));
    }
    setPhase('done');
  };

  const made = Object.values(results).filter((r) => r.ok).length;
  const failed = Object.values(results).filter((r) => !r.ok && r.error.code !== 'cancelled').length;
  const title = `Generate ${kind === 'icon' ? 'icons' : 'concepts'} (${entities.length})`;
  const plural = kind === 'icon' ? 'icons' : 'concepts';

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && close()}
      title={title}
      showTitle
      className="img-batch"
      footer={
        phase === 'running' ? (
          <Button
            variant="secondary"
            onClick={() => void images.cancel(batchId.current)}
            data-testid="image-batch-cancel"
          >
            Cancel the rest
          </Button>
        ) : phase === 'done' ? (
          <Button variant="primary" onClick={close} data-testid="image-batch-close">
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Cancel <Kbd>esc</Kbd>
            </Button>
            <Button
              variant="primary"
              disabled={!canRun}
              onClick={() => void run()}
              data-testid="image-batch-run"
            >
              Generate {calls} <Kbd>ctrl+enter</Kbd>
            </Button>
          </>
        )
      }
    >
      <div
        className="img-confirm-body"
        data-testid="image-batch"
        data-phase={phase}
        data-kind={kind}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            void run();
          }
        }}
      >
        <div className="img-batch-list" data-testid="image-batch-list">
          {phase === 'planning'
            ? names?.map((n, i) => (
                <div key={entities[i]} className="img-batch-row" data-testid="image-batch-row">
                  <span />
                  <span className="img-batch-name">{n}</span>
                  <Shimmer style={{ height: 34 }} />
                  <span />
                </div>
              ))
            : rows.map((r) => {
                const skip = r.failed ?? (!replace && r.has ? 'has one' : null);
                const res = results[r.entityId];
                return (
                  <div
                    key={r.entityId}
                    className="img-batch-row"
                    data-testid="image-batch-row"
                    data-entity={r.entityId}
                    data-skip={skip ? '' : undefined}
                    data-result={res ? (res.ok ? 'ok' : res.error.code) : undefined}
                  >
                    <ResultMark res={res} running={phase === 'running' && !skip && !res} />
                    <span className="img-batch-name">{r.name}</span>
                    {skip ? (
                      <span className="img-batch-skip t-3">{skip}</span>
                    ) : (
                      <Textarea
                        aria-label={`Prompt for ${r.name}`}
                        value={r.prompt}
                        readOnly={phase !== 'ready'}
                        onChange={(e) => {
                          const v = e.target.value;
                          setRows((rs) =>
                            rs.map((x) => (x.entityId === r.entityId ? { ...x, prompt: v } : x)),
                          );
                        }}
                        data-testid="image-batch-prompt"
                      />
                    )}
                    <span className="img-batch-result">
                      {res?.ok ? (
                        <Thumb meta={res.image} size={kind === 'icon' ? 32 : 56} />
                      ) : res && res.error.code !== 'cancelled' ? (
                        <Tooltip content={res.error.message}>
                          <span className="t-danger t-meta" tabIndex={0}>
                            {res.error.unknownOutcome ? 'unknown' : 'failed'}
                          </span>
                        </Tooltip>
                      ) : null}
                    </span>
                  </div>
                );
              })}
        </div>

        {phase === 'running' || phase === 'done' ? (
          <div className="img-batch-bar" data-testid="image-batch-progress">
            <div className="img-progress">
              <span
                style={{
                  width: `${progress.total ? (100 * progress.done) / progress.total : 0}%`,
                }}
              />
            </div>
            <span className="num t-2">
              {phase === 'done'
                ? `${made} of ${calls} ${plural}${failed ? `, ${failed} failed` : ''}`
                : `${progress.done} / ${progress.total}`}
            </span>
            <span className="num t-ai">{estimateText(progress.cost)}</span>
          </div>
        ) : (
          <div className={cx('img-options', kind === 'concept' && 'img-options-5')}>
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
            {kind === 'concept' && (
              <Field label="Size">
                <Select
                  value={opts.size}
                  onValueChange={(v) => setOpts((o) => ({ ...o, size: v as ImageSize }))}
                  options={sizesFor(kind).map((s) => ({ value: s, label: SIZE_LABEL[s] }))}
                  aria-label="Size"
                />
              </Field>
            )}
            <Field label="Existing">
              <Select
                value={replace ? 'replace' : 'skip'}
                onValueChange={(v) => setReplace(v === 'replace')}
                options={[
                  { value: 'skip', label: 'Skip' },
                  { value: 'replace', label: 'Replace' },
                ]}
                aria-label="Existing"
              />
            </Field>
            <div className="img-cost">
              <span className="img-cost-total" data-testid="image-batch-estimate">
                {estimate ? estimateText(estimate.totalUsd) : '…'}
              </span>
              <span
                className={cx('img-cost-left num', over ? 't-danger' : 't-3')}
                data-testid="image-batch-calls"
              >
                {calls} {calls === 1 ? 'call' : 'calls'}
              </span>
            </div>
          </div>
        )}
        {(status.paused || over) && phase === 'ready' && (
          <div className="img-error t-warn" data-testid="image-batch-blocked">
            {status.paused
              ? `Images paused: ${status.reason ?? 'budget reached'}`
              : 'Over the session budget'}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function ResultMark({ res, running }: { res: ImageResult | undefined; running: boolean }): ReactNode {
  return (
    <span
      className={cx(
        'img-batch-state',
        running && 'img-batch-state-running',
        res?.ok && 'img-batch-state-ok',
        res && !res.ok && res.error.code !== 'cancelled' && 'img-batch-state-failed',
      )}
      aria-hidden="true"
    />
  );
}
