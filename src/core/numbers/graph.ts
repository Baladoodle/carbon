import { diag, type Diagnostic, type Span } from './span';

/**
 * The dependency graph between definitions: an edge `a → b` means a's body
 * references b. Cycles are found with Tarjan's algorithm (strongly connected
 * components); the order puts every definition after what it depends on, with
 * ties broken by source order so it is deterministic.
 */
export interface Graph {
  /** Definitions in an order where dependencies come first. */
  order: string[];
  /** Definitions on a cycle (including one that references itself). */
  cyclic: Set<string>;
  /** One error per definition on a cycle, at the reference that closes it. */
  diagnostics: Diagnostic[];
  /** Reverse edges: who depends on each definition. */
  dependents: Map<string, Set<string>>;
}

export function buildGraph(
  names: string[],
  edges: Map<string, Set<string>>,
  refSpan: (from: string, to: string) => Span | undefined,
): Graph {
  const known = new Set(names);
  const pos = new Map(names.map((n, i) => [n, i]));
  const succ = (n: string): string[] =>
    [...(edges.get(n) ?? [])]
      .filter((m) => known.has(m))
      .sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0));

  // Tarjan, iteratively (no recursion limit on long chains).
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  for (const root of names) {
    if (idx.has(root)) continue;
    const work: { n: string; it: string[]; i: number }[] = [];
    const open = (n: string): void => {
      idx.set(n, index);
      low.set(n, index);
      index++;
      stack.push(n);
      onStack.add(n);
      work.push({ n, it: succ(n), i: 0 });
    };
    open(root);
    while (work.length > 0) {
      const top = work[work.length - 1] as { n: string; it: string[]; i: number };
      if (top.i < top.it.length) {
        const m = top.it[top.i++] as string;
        if (!idx.has(m)) open(m);
        else if (onStack.has(m)) low.set(top.n, Math.min(low.get(top.n) ?? 0, idx.get(m) ?? 0));
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.n, Math.min(low.get(parent.n) ?? 0, low.get(top.n) ?? 0));
      if (low.get(top.n) === idx.get(top.n)) {
        const scc: string[] = [];
        for (;;) {
          const m = stack.pop() as string;
          onStack.delete(m);
          scc.push(m);
          if (m === top.n) break;
        }
        sccs.push(scc);
      }
    }
  }

  // Tarjan emits components in reverse topological order: dependencies first.
  const order: string[] = [];
  const cyclic = new Set<string>();
  const diagnostics: Diagnostic[] = [];
  for (const scc of sccs) {
    scc.sort((a, b) => (pos.get(a) ?? 0) - (pos.get(b) ?? 0));
    const self = scc.length === 1 && (edges.get(scc[0] as string)?.has(scc[0] as string) ?? false);
    if (scc.length > 1 || self) {
      const members = new Set(scc);
      for (const n of scc) {
        cyclic.add(n);
        const loop = cyclePath(n, members, succ);
        const next = loop[1] ?? n;
        const at = refSpan(n, next);
        if (at)
          diagnostics.push(
            diag(
              'check',
              'cycle',
              loop.length <= 2
                ? `${n} depends on itself`
                : `${n} depends on itself: ${loop.join(' → ')}`,
              at,
              {
                hint: 'A formula cannot use its own result; break the loop with a variable',
                def: n,
              },
            ),
          );
      }
    }
    order.push(...scc);
  }
  const dependents = new Map<string, Set<string>>();
  for (const n of names)
    for (const m of succ(n)) {
      let s = dependents.get(m);
      if (!s) {
        s = new Set();
        dependents.set(m, s);
      }
      s.add(n);
    }
  return { order, cyclic, diagnostics, dependents };
}

/** The shortest loop from `start` back to itself within a component (BFS), e.g. [a, b, a]. */
function cyclePath(start: string, members: Set<string>, succ: (n: string) => string[]): string[] {
  const prev = new Map<string, string>();
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const n = queue.shift() as string;
    for (const m of succ(n)) {
      if (!members.has(m)) continue;
      if (m === start) {
        const path = [start];
        for (let c: string | undefined = n; c !== undefined && c !== start; c = prev.get(c))
          path.splice(1, 0, c);
        path.push(start);
        return path;
      }
      if (seen.has(m)) continue;
      seen.add(m);
      prev.set(m, n);
      queue.push(m);
    }
  }
  return [start, start];
}

/** Everything that transitively depends on any of `names` (including them). */
export function downstream(
  names: Iterable<string>,
  dependents: Map<string, Set<string>>,
): Set<string> {
  const out = new Set<string>();
  const queue = [...names];
  while (queue.length > 0) {
    const n = queue.pop() as string;
    if (out.has(n)) continue;
    out.add(n);
    for (const m of dependents.get(n) ?? []) queue.push(m);
  }
  return out;
}
