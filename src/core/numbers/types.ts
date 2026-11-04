import { ENTITY_KINDS, type EntityKind } from '../model/kinds';

/**
 * Static types: number, bool, string, entity (of a kind, when known) and
 * list. Parameters are inferred by unification (and may be annotated), so
 * `taken(raw, def) = raw * k / (k + def)` types as `(number, number) → number`
 * without saying so.
 */
export type KindTerm = { k: 'kind'; kind: EntityKind } | { k: 'kvar'; id: number } | { k: 'any' };

export type Type =
  | { t: 'number' }
  | { t: 'bool' }
  | { t: 'string' }
  | { t: 'entity'; kind: KindTerm }
  | { t: 'list'; of: Type }
  | { t: 'var'; id: number };

export const NUMBER: Type = { t: 'number' };
export const BOOL: Type = { t: 'bool' };
export const STRING: Type = { t: 'string' };
export const entityOf = (kind: EntityKind | null): Type => ({
  t: 'entity',
  kind: kind ? { k: 'kind', kind } : { k: 'any' },
});
export const listOf = (of: Type): Type => ({ t: 'list', of });

/** A generalised type: the variables listed are instantiated fresh at each use. */
export interface Scheme {
  vars: number[];
  kvars: number[];
  params: Type[] | null;
  result: Type;
}

export class Unifier {
  private next = 1;
  private readonly tsub = new Map<number, Type>();
  private readonly ksub = new Map<number, KindTerm>();

  fresh(): Type {
    return { t: 'var', id: this.next++ };
  }
  freshKind(): KindTerm {
    return { k: 'kvar', id: this.next++ };
  }

  kind(k: KindTerm): KindTerm {
    let cur = k;
    while (cur.k === 'kvar') {
      const s = this.ksub.get(cur.id);
      if (!s) return cur;
      cur = s;
    }
    return cur;
  }

  /** Follows variable bindings at the top level only. */
  shallow(t: Type): Type {
    let cur = t;
    while (cur.t === 'var') {
      const s = this.tsub.get(cur.id);
      if (!s) return cur;
      cur = s;
    }
    return cur;
  }

  /** Fully applies the substitution. */
  resolve(t: Type): Type {
    const s = this.shallow(t);
    if (s.t === 'list') return { t: 'list', of: this.resolve(s.of) };
    if (s.t === 'entity') return { t: 'entity', kind: this.kind(s.kind) };
    return s;
  }

  private occurs(id: number, t: Type): boolean {
    const s = this.shallow(t);
    if (s.t === 'var') return s.id === id;
    if (s.t === 'list') return this.occurs(id, s.of);
    return false;
  }

  /** Makes `a` and `b` equal, or returns why they can't be. */
  unify(a: Type, b: Type): string | null {
    const x = this.shallow(a);
    const y = this.shallow(b);
    if (x.t === 'var' && y.t === 'var' && x.id === y.id) return null;
    if (x.t === 'var') {
      if (this.occurs(x.id, y)) return `${this.format(x)} can't contain itself`;
      this.tsub.set(x.id, y);
      return null;
    }
    if (y.t === 'var') return this.unify(y, x);
    if (x.t === 'list' && y.t === 'list') {
      const r = this.unify(x.of, y.of);
      return r === null ? null : `expected ${this.format(y)}, found ${this.format(x)}`;
    }
    if (x.t === 'entity' && y.t === 'entity') return this.unifyKind(x.kind, y.kind);
    if (x.t === y.t) return null;
    return `expected ${this.format(y)}, found ${this.format(x)}`;
  }

  unifyKind(a: KindTerm, b: KindTerm): string | null {
    const x = this.kind(a);
    const y = this.kind(b);
    if (x.k === 'any' || y.k === 'any') return null;
    if (x.k === 'kvar') {
      if (!(y.k === 'kvar' && y.id === x.id)) this.ksub.set(x.id, y);
      return null;
    }
    if (y.k === 'kvar') {
      this.ksub.set(y.id, x);
      return null;
    }
    return x.kind === y.kind ? null : `expected a ${y.kind}, found a ${x.kind}`;
  }

  /** Free variables of a type (after substitution). */
  free(t: Type, vars: Set<number>, kvars: Set<number>): void {
    const s = this.shallow(t);
    if (s.t === 'var') vars.add(s.id);
    else if (s.t === 'list') this.free(s.of, vars, kvars);
    else if (s.t === 'entity') {
      const k = this.kind(s.kind);
      if (k.k === 'kvar') kvars.add(k.id);
    }
  }

  generalize(params: Type[] | null, result: Type): Scheme {
    const vars = new Set<number>();
    const kvars = new Set<number>();
    for (const p of params ?? []) this.free(p, vars, kvars);
    this.free(result, vars, kvars);
    return {
      vars: [...vars],
      kvars: [...kvars],
      params: params ? params.map((p) => this.resolve(p)) : null,
      result: this.resolve(result),
    };
  }

  instantiate(s: Scheme): { params: Type[] | null; result: Type } {
    if (s.vars.length === 0 && s.kvars.length === 0) return { params: s.params, result: s.result };
    const tm = new Map(s.vars.map((v) => [v, this.fresh()]));
    const km = new Map(s.kvars.map((v) => [v, this.freshKind()]));
    const sub = (t: Type): Type => {
      const r = this.resolve(t);
      if (r.t === 'var') return tm.get(r.id) ?? r;
      if (r.t === 'list') return { t: 'list', of: sub(r.of) };
      if (r.t === 'entity' && r.kind.k === 'kvar') return { t: 'entity', kind: km.get(r.kind.id) ?? r.kind };
      return r;
    };
    return { params: s.params ? s.params.map(sub) : null, result: sub(s.result) };
  }

  format(t: Type): string {
    return formatType(this.resolve(t));
  }
}

/** A readable type: `number`, `list of item`, `entity`, `any`. */
export function formatType(t: Type, names: Map<number, string> = new Map()): string {
  switch (t.t) {
    case 'number':
    case 'bool':
    case 'string':
      return t.t;
    case 'entity':
      return t.kind.k === 'kind' ? t.kind.kind : 'entity';
    case 'list':
      return `list of ${formatType(t.of, names)}`;
    case 'var': {
      let n = names.get(t.id);
      if (!n) {
        n = names.size === 0 ? 'any' : `any${names.size + 1}`;
        names.set(t.id, n);
      }
      return n;
    }
  }
}

export function formatScheme(s: Scheme): string {
  const names = new Map<number, string>();
  if (!s.params) return formatType(s.result, names);
  return `(${s.params.map((p) => formatType(p, names)).join(', ')}) → ${formatType(s.result, names)}`;
}

/** Parameter annotations: `number`, `bool`, `string`, `list`, `entity` or a kind. */
export function annotationType(name: string, u: Unifier): Type | null {
  switch (name) {
    case 'number':
      return NUMBER;
    case 'bool':
      return BOOL;
    case 'string':
      return STRING;
    case 'list':
      return listOf(u.fresh());
    case 'entity':
      return { t: 'entity', kind: u.freshKind() };
    default:
      return (ENTITY_KINDS as readonly string[]).includes(name) ? entityOf(name as EntityKind) : null;
  }
}

export const ANNOTATIONS = ['number', 'bool', 'string', 'list', 'entity', ...ENTITY_KINDS];
