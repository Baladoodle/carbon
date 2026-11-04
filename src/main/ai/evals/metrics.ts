import type { AiError, Usage } from '@core/ai/gateway';
import type { Moment } from '@core/ai/moments';
import { duplicatesName, normName } from '@core/prompts/schema';
import { getEntity, type World } from '@core/model/world';
import type { EvalCase } from './cases';

/**
 * The prompt-eval metrics (docs/SYSTEM.md §8), computed from each case's RAW
 * model output (before the gateway drops anything) plus the gateway's outcome.
 * Pure functions; `metrics.test.ts` checks them on hand-made outcomes.
 */

export interface CaseRun {
  case: EvalCase;
  /** The gateway's outcome. */
  ok: boolean;
  error?: AiError;
  /** The model's JSON as sent, or undefined if it wasn't valid JSON / no call was made. */
  raw?: unknown;
  usage: Usage;
  costUsd: number;
  latencyMs: number;
  dropped: number;
  stopReason?: string;
}

export interface Metric {
  id: string;
  label: string;
  value: number | null;
  /** Human-readable target, e.g. "= 100%". */
  target: string;
  pass: boolean | null;
  detail?: string;
}

export const THRESHOLDS = {
  schemaValidity: 1,
  referencesResolve: 1,
  noDuplicateNames: 0.95,
  critiqueRecall: 0.9,
  critiquePrecision: 0.8,
  /** Mean pairwise Jaccard overlap of candidate name words. */
  spreadNameOverlap: 0.15,
  /** Mean pairwise Jaccard overlap of candidate identity words (verbs and content). */
  spreadIdentityOverlap: 0.3,
  requestLimit: 100_000,
} as const;

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const rec = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** Every entity id the raw output refers to, with whether it exists. */
export function references(
  world: World,
  moment: Moment,
  raw: unknown,
): { id: string; ok: boolean }[] {
  const out: string[] = [];
  const r = rec(raw);
  if (moment === 'critique')
    for (const n of arr(r.notes))
      out.push(...arr(rec(n).entities).filter((x): x is string => typeof x === 'string'));
  if (moment === 'spread')
    for (const c of arr(r.candidates)) {
      for (const rel of arr(rec(c).relations))
        if (typeof rec(rel).target === 'string') out.push(rec(rel).target as string);
      if (typeof rec(c).about === 'string') out.push(rec(c).about as string);
    }
  return out.map((id) => ({ id, ok: !!getEntity(world, id) }));
}

/** Names the raw output proposes for NEW things (suggested names, spread candidates). */
export function proposedNames(moment: Moment, field: string | undefined, raw: unknown): string[] {
  const r = rec(raw);
  if (moment === 'spread')
    return arr(r.candidates)
      .filter((c) => rec(c).kind !== null && rec(c).about == null)
      .map((c) => rec(c).name)
      .filter((n): n is string => typeof n === 'string');
  if (field !== 'name') return [];
  if (moment === 'suggest_one')
    return [rec(rec(r.suggestion)).value].filter((n): n is string => typeof n === 'string');
  if (moment === 'suggest_three')
    return arr(r.suggestions)
      .map((s) => rec(s).value)
      .filter((n): n is string => typeof n === 'string');
  return [];
}

const STOP = new Set([
  'a',
  'an',
  'the',
  'of',
  'and',
  'or',
  'to',
  'in',
  'on',
  'it',
  'its',
  'is',
  'that',
  'you',
  'your',
  'with',
  'for',
  'as',
  'at',
  'by',
  'from',
  'but',
  'into',
  'when',
  'than',
  'this',
  'what',
]);
const words = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 1 && !STOP.has(w)),
  );
const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
};

/** Mean pairwise Jaccard overlap of a list of texts' content words. */
export function meanOverlap(texts: readonly string[]): number {
  const sets = texts.map(words);
  let sum = 0;
  let n = 0;
  sets.forEach((a, i) =>
    sets.slice(i + 1).forEach((b) => {
      sum += jaccard(a, b);
      n++;
    }),
  );
  return n === 0 ? 0 : sum / n;
}

const metric = (
  id: string,
  label: string,
  value: number | null,
  target: string,
  pass: (v: number) => boolean,
  detail?: string,
): Metric => ({
  id,
  label,
  value,
  target,
  pass: value === null ? null : pass(value),
  ...(detail ? { detail } : {}),
});

export function computeMetrics(world: World, runs: readonly CaseRun[]): Metric[] {
  const called = runs.filter(
    (r) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite > 0 || r.raw !== undefined,
  );
  // 1. Schema validity: the output parsed and validated (not invalid JSON, truncated or a refusal).
  const invalid = called.filter(
    (r) => !r.ok && r.error && ['invalid_output', 'truncated', 'refused'].includes(r.error.code),
  );
  const validity = called.length === 0 ? null : 1 - invalid.length / called.length;
  // 2. References resolve.
  const refs = runs.flatMap((r) => references(world, r.case.moment, r.raw));
  const resolving = refs.length === 0 ? null : refs.filter((x) => x.ok).length / refs.length;
  // 3. No duplicates of existing names (and none within one answer).
  const names = runs.flatMap((r) => {
    const field =
      'field' in r.case.request ? (r.case.request as { field: string }).field : undefined;
    const except = 'entityId' in r.case.request ? r.case.request.entityId : undefined;
    const ns = proposedNames(r.case.moment, field, r.raw);
    const seen = new Set<string>();
    return ns.map((n) => {
      const dup = duplicatesName(world, n, except) || seen.has(normName(n));
      seen.add(normName(n));
      return !dup;
    });
  });
  const unique = names.length === 0 ? null : names.filter(Boolean).length / names.length;
  // 4/5. Critique recall on seeded flaws, precision on clean entities.
  const kindsOf = (r: CaseRun): string[] => arr(rec(r.raw).notes).map((n) => String(rec(n).kind));
  const flawed = runs.filter(
    (r) => r.case.expect && 'catches' in r.case.expect && r.raw !== undefined,
  );
  const caught = flawed.filter((r) =>
    kindsOf(r).some((k) => (r.case.expect as { catches: string[] }).catches.includes(k)),
  );
  const recall = flawed.length === 0 ? null : caught.length / flawed.length;
  const clean = runs.filter(
    (r) => r.case.expect && 'clean' in r.case.expect && r.raw !== undefined,
  );
  const quiet = clean.filter((r) => kindsOf(r).length === 0);
  const precision = clean.length === 0 ? null : quiet.length / clean.length;
  // 6. Spread diversity.
  const spreads = runs.filter((r) => r.case.moment === 'spread' && r.raw !== undefined);
  const cands = (r: CaseRun) => arr(rec(r.raw).candidates).map(rec);
  const nameOverlap =
    spreads.length === 0
      ? null
      : Math.max(
          ...spreads.map((r) =>
            meanOverlap(cands(r).map((c) => (typeof c.name === 'string' ? c.name : ''))),
          ),
        );
  const idOverlap =
    spreads.length === 0
      ? null
      : Math.max(
          ...spreads.map((r) =>
            meanOverlap(cands(r).map((c) => (typeof c.identity === 'string' ? c.identity : ''))),
          ),
        );
  // 7. Every request under 100k tokens, and the cache read rate.
  const sizes = called.map((r) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite);
  const largest = sizes.length === 0 ? null : Math.max(...sizes);
  const totalIn = sizes.reduce((a, b) => a + b, 0);
  const read = called.reduce((a, r) => a + r.usage.cacheRead, 0);

  return [
    metric(
      'schema',
      'Schema validity',
      validity,
      '= 100%',
      (v) => v >= THRESHOLDS.schemaValidity,
      invalid.map((r) => `${r.case.id}: ${r.error?.code ?? ''}`).join(', '),
    ),
    metric(
      'references',
      'References resolve to existing entities',
      resolving,
      '= 100%',
      (v) => v >= THRESHOLDS.referencesResolve,
      refs
        .filter((x) => !x.ok)
        .map((x) => x.id)
        .join(', '),
    ),
    metric(
      'duplicates',
      'No duplicates of existing names',
      unique,
      '≥ 95%',
      (v) => v >= THRESHOLDS.noDuplicateNames,
      `${names.length} names`,
    ),
    metric(
      'recall',
      'Critique catches seeded flaws (recall)',
      recall,
      '≥ 0.9',
      (v) => v >= THRESHOLDS.critiqueRecall,
      flawed
        .filter((r) => !caught.includes(r))
        .map((r) => `missed ${r.case.id} (${kindsOf(r).join(', ') || 'no notes'})`)
        .join('; '),
    ),
    metric(
      'precision',
      'Critique raises no notes on clean entities',
      precision,
      '≥ 0.8',
      (v) => v >= THRESHOLDS.critiquePrecision,
      clean
        .filter((r) => !quiet.includes(r))
        .map((r) => `${r.case.id}: ${kindsOf(r).join(', ')}`)
        .join('; '),
    ),
    metric(
      'spread-names',
      'Spread diversity: name overlap (worst spread)',
      nameOverlap,
      `< ${THRESHOLDS.spreadNameOverlap}`,
      (v) => v < THRESHOLDS.spreadNameOverlap,
    ),
    metric(
      'spread-identity',
      'Spread diversity: identity/verb overlap (worst spread)',
      idOverlap,
      `< ${THRESHOLDS.spreadIdentityOverlap}`,
      (v) => v < THRESHOLDS.spreadIdentityOverlap,
    ),
    metric(
      'size',
      'Largest request (input tokens)',
      largest,
      `< ${THRESHOLDS.requestLimit.toLocaleString('en')}`,
      (v) => v < THRESHOLDS.requestLimit,
      totalIn > 0 ? `cache read rate ${pct(read / totalIn)}` : undefined,
    ),
  ];
}

export interface Report {
  mode: 'live' | 'record' | 'replay' | 'dry';
  at: string;
  model: string;
  cases: number;
  costUsd: number;
  usage: Usage;
  metrics: Metric[];
  pass: boolean;
  runs: {
    id: string;
    moment: Moment;
    ok: boolean;
    error?: string;
    costUsd: number;
    latencyMs: number;
    dropped: number;
    usage: Usage;
  }[];
}

export function buildReport(
  mode: Report['mode'],
  at: string,
  model: string,
  world: World,
  runs: readonly CaseRun[],
): Report {
  const metrics = computeMetrics(world, runs);
  const usage = runs.reduce<Usage>(
    (a, r) => ({
      input: a.input + r.usage.input,
      output: a.output + r.usage.output,
      cacheRead: a.cacheRead + r.usage.cacheRead,
      cacheWrite: a.cacheWrite + r.usage.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
  return {
    mode,
    at,
    model,
    cases: runs.length,
    costUsd: runs.reduce((a, r) => a + r.costUsd, 0),
    usage,
    metrics,
    pass: metrics.every((m) => m.pass !== false),
    runs: runs.map((r) => ({
      id: r.case.id,
      moment: r.case.moment,
      ok: r.ok,
      ...(r.error ? { error: `${r.error.code}: ${r.error.message}` } : {}),
      costUsd: r.costUsd,
      latencyMs: r.latencyMs,
      dropped: r.dropped,
      usage: r.usage,
    })),
  };
}

const fmt = (m: Metric): string =>
  m.value === null
    ? 'n/a'
    : m.id === 'size'
      ? m.value.toLocaleString('en')
      : m.id.startsWith('spread')
        ? m.value.toFixed(3)
        : pct(m.value);

export function reportMarkdown(r: Report): string {
  const lines = [
    `# Prompt evals: ${r.pass ? 'PASS' : 'FAIL'}`,
    '',
    `${r.at} · ${r.mode} · ${r.model} · ${r.cases} cases · $${r.costUsd.toFixed(4)}`,
    '',
    ...(r.mode === 'dry'
      ? [
          '> Dry run: the answers were generated offline from each request’s schema, not by Claude. The pipeline ran end to end; the quality metrics are not meaningful.',
          '',
        ]
      : []),
    '| Metric | Value | Target | |',
    '|---|---|---|---|',
    ...r.metrics.map(
      (m) =>
        `| ${m.label} | ${fmt(m)} | ${m.target} | ${m.pass === null ? '–' : m.pass ? 'pass' : '**fail**'} |`,
    ),
    '',
  ];
  const notes = r.metrics.filter((m) => m.detail);
  if (notes.length > 0) {
    lines.push('## Details', '');
    for (const m of notes) lines.push(`- **${m.label}:** ${m.detail}`);
    lines.push('');
  }
  lines.push(
    '## Cases',
    '',
    '| Case | Moment | Result | In | Cache read | Out | Cost | ms |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const c of r.runs)
    lines.push(
      `| ${c.id} | ${c.moment} | ${c.ok ? `ok${c.dropped ? ` (${c.dropped} dropped)` : ''}` : (c.error ?? 'error')} | ${c.usage.input + c.usage.cacheWrite} | ${c.usage.cacheRead} | ${c.usage.output} | $${c.costUsd.toFixed(5)} | ${Math.round(c.latencyMs)} |`,
    );
  lines.push(
    '',
    `Usage: ${r.usage.input} input, ${r.usage.cacheWrite} cache write, ${r.usage.cacheRead} cache read, ${r.usage.output} output tokens.`,
    '',
  );
  return lines.join('\n');
}
