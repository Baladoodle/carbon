/**
 * Source spans and diagnostics for the expression language. A span is a pair
 * of UTF-16 offsets into the whole `formulas.carbon` source (or into a
 * standalone expression, e.g. a curve's), `start` inclusive and `end`
 * exclusive. Every diagnostic carries one, so the editor can underline it.
 */
export interface Span {
  start: number;
  end: number;
}

export const span = (start: number, end: number): Span => ({ start, end });

/** The smallest span covering both. */
export const cover = (a: Span, b: Span): Span => ({
  start: Math.min(a.start, b.start),
  end: Math.max(a.end, b.end),
});

export type Severity = 'error' | 'warning';

/** Where a diagnostic was found. */
export type Stage = 'parse' | 'check' | 'eval';

export interface Diagnostic {
  severity: Severity;
  stage: Stage;
  /** Stable, e.g. `name.unknown`, `type.mismatch`, `cycle`, `eval.div_zero`. */
  code: string;
  message: string;
  span: Span;
  /** A concrete way to fix it, when there is one. */
  hint?: string;
  /** The definition it belongs to, if any. */
  def?: string;
}

export function diag(
  stage: Stage,
  code: string,
  message: string,
  at: Span,
  extra: { hint?: string | undefined; severity?: Severity; def?: string | undefined } = {},
): Diagnostic {
  const d: Diagnostic = {
    severity: extra.severity ?? 'error',
    stage,
    code,
    message,
    span: { start: at.start, end: at.end },
  };
  if (extra.hint !== undefined) d.hint = extra.hint;
  if (extra.def !== undefined) d.def = extra.def;
  return d;
}

export interface LineCol {
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 units. */
  col: number;
}

/** Line and column of an offset (1-based). */
export function lineCol(source: string, offset: number): LineCol {
  let line = 1;
  let last = -1;
  const end = Math.min(Math.max(0, offset), source.length);
  for (let i = 0; i < end; i++)
    if (source.charCodeAt(i) === 10) {
      line++;
      last = i;
    }
  return { line, col: end - last };
}

/** Offsets where each line starts. */
export function lineStarts(source: string): number[] {
  const out = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

/** Damerau-free Levenshtein distance (for "did you mean"). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diagonal + cost);
      diagonal = up;
    }
  }
  return prev[b.length] ?? 0;
}

/** The closest candidate within a small distance, for a "did you mean" hint. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  const limit = Math.max(1, Math.floor(name.length / 3));
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestD || (d === bestD && best !== undefined && c < best)) {
      best = c;
      bestD = d;
    }
  }
  return bestD <= limit ? best : undefined;
}
