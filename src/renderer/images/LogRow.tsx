import type { ReactNode } from 'react';
import type { ImageLogEntry } from '@core/images/gateway';
import { useWorld } from '../state/world';
import { TD, TR } from '../ui';
import { Thumb } from './Thumb';

const usd = (n: number): string => (n === 0 ? '$0' : n < 0.0001 ? '<$0.0001' : `$${n.toFixed(4)}`);
const tokens = (n: number | undefined): string =>
  n === undefined || n === 0 ? '' : n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/**
 * An image call in the AI log, in the log's own columns: what it made (its
 * thumbnail), the provider, model, size and quality (in the tooltip), usage,
 * cost and latency.
 */
export function ImageLogRow({
  e,
  current,
  onPick,
}: {
  e: ImageLogEntry;
  current: boolean;
  onPick: () => void;
}): ReactNode {
  const meta = useWorld((w) =>
    e.image ? w.images?.[e.entity]?.all.find((m) => m.id === e.image) : undefined,
  );
  const detail = `${e.provider} · ${e.model} · ${e.size} · ${e.quality}${e.batchId ? ' · batch' : ''}`;
  const outcome =
    e.outcome === 'ok'
      ? null
      : e.outcome === 'cancelled'
        ? { text: 'cancelled', tone: 't-3' }
        : { text: e.error?.code ?? e.outcome, tone: 't-danger' };
  return (
    <TR
      current={current}
      data-testid="ai-log-row"
      data-kind="image"
      data-outcome={e.outcome}
      onClick={onPick}
      title={detail}
    >
      <TD mono className="t-3">
        {e.at.slice(11, 19)}
      </TD>
      <TD className="t-ai">
        {e.kind}
        <span className="t-3">{` · ${e.quality}`}</span>
        {e.via === 'agent' && <span className="t-agent">{' · agent'}</span>}
      </TD>
      <TD mono className="ai-log-entity">
        {e.entity}
      </TD>
      <TD className={outcome?.tone} title={e.error?.message}>
        {meta ? (
          <Thumb meta={meta} size={20} testId="ai-log-thumb" />
        ) : (
          (outcome?.text ?? (e.outcome === 'ok' ? 'removed' : ''))
        )}
      </TD>
      <TD numeric>{tokens(e.usage?.inputTokens)}</TD>
      <TD numeric />
      <TD numeric>{tokens(e.usage?.outputTokens)}</TD>
      <TD numeric>{usd(e.costUsd)}</TD>
      <TD numeric className="t-3">
        {Math.round(e.latencyMs)}
      </TD>
    </TR>
  );
}
