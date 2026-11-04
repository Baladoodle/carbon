import type { Candidate } from '@core/ai/moments';
import type { World } from '@core/model/world';
import { getEntity, schemaOf } from '@core/model/world';
import type { SpreadData } from '@core/spreads/record';
import { candidateRole, targetOf } from '@core/spreads/triage';
import type { ReactNode } from 'react';

const show = (v: unknown): string => {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'object' && x && 'text' in x))
    return (v as { text: string }[]).map((s, i) => `${i + 1}. ${s.text}`).join('  ');
  return JSON.stringify(v);
};

/** The focused candidate in full: what it would become, its fields and relations, and why. */
export function Detail({
  world,
  spread,
  candidate,
}: {
  world: World;
  spread: SpreadData | null;
  candidate: Candidate;
}): ReactNode {
  const name = (id: string): string => getEntity(world, id)?.name ?? id;
  const kind = candidate.kind;
  const role = spread
    ? candidateRole(world, spread, candidate)
    : candidate.kind === null
      ? 'finding'
      : 'new';
  const target = spread ? targetOf(world, spread, candidate) : candidate.about;
  const defs = kind ? schemaOf(world).kinds[kind].fields : [];
  const fields = Object.entries(candidate.fields).filter(([, v]) => v !== null && v !== undefined);
  return (
    <div className="spread-detail" data-testid="spread-detail">
      <div className="spread-detail-head">
        <span className="spread-detail-name">{candidate.name}</span>
        {role === 'about' && target && <span className="t-2">→ {name(target)}</span>}
        {role === 'new' && kind && <span className="t-3">{schemaOf(world).kinds[kind].label}</span>}
      </div>
      <div className="spread-detail-identity">{candidate.identity}</div>
      {candidate.description && (
        <div className="spread-detail-desc t-2">{candidate.description}</div>
      )}
      {(fields.length > 0 ||
        candidate.relations.length > 0 ||
        Object.keys(candidate.attributes).length > 0) && (
        <dl className="spread-detail-grid">
          {fields.map(([k, v]) => (
            <div key={k} className="spread-detail-row">
              <dt className="t-3">{defs.find((d) => d.key === k)?.label ?? k}</dt>
              <dd>{show(v)}</dd>
            </div>
          ))}
          {Object.entries(candidate.attributes).map(([k, v]) => (
            <div key={`a-${k}`} className="spread-detail-row">
              <dt className="t-3">{k}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
          {candidate.relations.map((r, i) => (
            <div key={`r-${i}`} className="spread-detail-row">
              <dt className="t-3">{schemaOf(world).relations[r.type]?.label ?? r.type}</dt>
              <dd>
                {name(r.target)}
                {r.note && <span className="t-3"> — {r.note}</span>}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {candidate.rationale && <div className="spread-detail-why t-ai">{candidate.rationale}</div>}
    </div>
  );
}
