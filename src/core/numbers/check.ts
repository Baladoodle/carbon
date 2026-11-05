import type { EntityKind } from '../model/kinds';
import type { WorldSchema } from '../model/schema';
import { defsOf, walk, type Def, type Expr, type ExprOf, type Program } from './ast';
import { buildGraph } from './graph';
import { BUILTINS, isBuiltin, RESERVED } from './builtins';
import { KEYWORDS } from './lexer';
import { COLLECTIONS, kindsWithProp, propsOf, type Prop } from './props';
import { closest, diag, type Diagnostic, type Span } from './span';
import {
  ANNOTATIONS,
  annotationType,
  BOOL,
  formatScheme,
  listOf,
  NUMBER,
  STRING,
  Unifier,
  type Scheme,
  type Type,
} from './types';

/**
 * Name resolution and the static type check, in one pass over the
 * definitions. A definition is checked when it's first needed (so callees are
 * typed before callers) and the references it resolves are its exact
 * dependencies. Reaching a definition that is still being checked is a cycle;
 * graph.ts reports it with the whole loop.
 *
 * Inside `where` and the per-element argument of an aggregate, a bare name
 * that is a property of the element (`subkind`, `band`) means that property;
 * `.name` and `it.name` say so explicitly. A property that hides a parameter
 * or definition of the same name gets a warning.
 */
export type Resolution =
  | { to: 'param'; name: string }
  | { to: 'binding'; name: string }
  | { to: 'element'; depth: number }
  | { to: 'prop'; name: string; depth: number }
  | { to: 'def'; name: string }
  | { to: 'var'; name: string }
  | { to: 'collection'; kind: EntityKind | null };

export type Variables = Record<string, number | string | boolean>;

export interface CheckEnv {
  schema: WorldSchema;
  variables: Variables;
}

/** What one definition references (static, after resolution). */
export interface DefUses {
  defs: Set<string>;
  variables: Set<string>;
  /** Entity property names it reads (`defense`, `band`). */
  props: Set<string>;
  /** Collections it queries (`item`, or `*` for `entities`). */
  kinds: Set<EntityKind | '*'>;
}

export interface CheckedDef {
  def: Def;
  name: string;
  scheme: Scheme;
  uses: DefUses;
  /** Where each dependency is referenced (first reference), for cycle errors. */
  refSpans: Map<string, Span>;
  /** Whether the check found an error inside this definition. */
  hasError: boolean;
}

interface Scope {
  params?: Map<string, Type>;
  bindings?: Map<string, Type>;
  /** The element type of a `where` or aggregate. */
  element?: Type;
  parent?: Scope;
}

const emptyUses = (): DefUses => ({
  defs: new Set(),
  variables: new Set(),
  props: new Set(),
  kinds: new Set(),
});

export const varType = (v: number | string | boolean): Type =>
  typeof v === 'number' ? NUMBER : typeof v === 'string' ? STRING : BOOL;

/** An identifier a definition may use as its name, or why not. */
export function nameProblem(name: string, env: CheckEnv): { message: string; hint: string } | null {
  if (KEYWORDS.has(name)) return { message: `"${name}" is a keyword`, hint: 'Choose another name' };
  if (RESERVED.has(name))
    return {
      message: `"${name}" is the current element inside where`,
      hint: 'Choose another name',
    };
  if (isBuiltin(name))
    return { message: `${name} is a built-in function`, hint: 'Choose another name' };
  if (Object.prototype.hasOwnProperty.call(COLLECTIONS, name))
    return { message: `${name} is the list of all ${name}`, hint: 'Choose another name' };
  if (Object.prototype.hasOwnProperty.call(env.variables, name))
    return {
      message: `${name} is also a variable`,
      hint: `Rename it, or remove the variable ${name}`,
    };
  return null;
}

export class Checker {
  readonly u = new Unifier();
  readonly diagnostics: Diagnostic[] = [];
  readonly resolutions = new WeakMap<Expr, Resolution>();
  /** Definitions by name; the first of duplicates wins. */
  readonly defs = new Map<string, Def>();
  readonly checked = new Map<string, CheckedDef>();
  /** Dependency edges found while checking (including ones into a cycle). */
  readonly edges = new Map<string, Set<string>>();
  private readonly inProgress = new Set<string>();
  private current: {
    name: string;
    uses: DefUses;
    refSpans: Map<string, Span>;
    errors: number;
  } | null = null;

  constructor(readonly env: CheckEnv) {}

  private report(
    code: string,
    message: string,
    at: Span,
    hint?: string,
    severity: 'error' | 'warning' = 'error',
  ): void {
    this.diagnostics.push(
      diag('check', code, message, at, { hint, severity, def: this.current?.name }),
    );
    if (severity === 'error' && this.current) this.current.errors++;
  }

  /** Registers definitions (reporting duplicates and bad names) and checks them all. */
  checkProgram(program: Program): void {
    for (const d of defsOf(program)) {
      const bad = nameProblem(d.name, this.env);
      if (bad) {
        this.diagnostics.push(
          diag('check', 'name.reserved', bad.message, d.nameSpan, { hint: bad.hint, def: d.name }),
        );
        continue;
      }
      const first = this.defs.get(d.name);
      if (first) {
        this.diagnostics.push(
          diag('check', 'name.duplicate', `${d.name} is defined twice`, d.nameSpan, {
            hint: 'Rename one of them, or remove one',
            def: d.name,
          }),
        );
        continue;
      }
      this.defs.set(d.name, d);
    }
    for (const name of this.checkOrder()) this.ensure(name);
  }

  /**
   * The order to check definitions in: what each one mentions first. Checking
   * is recursive (a reference checks its target), so without this a long
   * chain written callers-first would recurse once per link and overflow the
   * stack. The edges are syntactic (any name or callee that is a definition),
   * so they over-approximate the real ones; that only changes the order.
   */
  private checkOrder(): string[] {
    const names = [...this.defs.keys()];
    const edges = new Map<string, Set<string>>();
    for (const [name, def] of this.defs) {
      const out = new Set<string>();
      walk(def.body, (e) => {
        const n = e.type === 'name' ? e.name : e.type === 'call' ? e.callee : undefined;
        if (n !== undefined && n !== name && this.defs.has(n)) out.add(n);
      });
      edges.set(name, out);
    }
    return buildGraph(names, edges, () => undefined).order;
  }

  /** Checks a definition if it hasn't been yet; returns its scheme (or a placeholder in a cycle). */
  private ensure(name: string): Scheme | null {
    const done = this.checked.get(name);
    if (done) return done.scheme;
    if (this.inProgress.has(name)) return null;
    const def = this.defs.get(name);
    if (!def) return null;
    this.inProgress.add(name);
    const saved = this.current;
    const cur = { name, uses: emptyUses(), refSpans: new Map<string, Span>(), errors: 0 };
    this.current = cur;
    let scheme: Scheme;
    if (def.type === 'const') {
      const t = this.expr(def.body, {});
      scheme = this.u.generalize(null, t);
    } else {
      const params = new Map<string, Type>();
      const types: Type[] = [];
      for (const p of def.params) {
        let t: Type = this.u.fresh();
        if (p.annotation) {
          const a = annotationType(p.annotation.name, this.u);
          if (a) t = a;
          else {
            const near = closest(p.annotation.name, ANNOTATIONS);
            this.report(
              'type.annotation',
              `"${p.annotation.name}" is not a type`,
              p.annotation.span,
              near ? `Did you mean ${near}?` : `Types are ${ANNOTATIONS.join(', ')}`,
            );
          }
        }
        if (params.has(p.name))
          this.report(
            'name.param_duplicate',
            `${p.name} is a parameter twice`,
            p.span,
            'Rename one of them',
          );
        else if (RESERVED.has(p.name))
          this.report(
            'name.reserved',
            `"${p.name}" is the current element inside where`,
            p.span,
            'Choose another name',
          );
        params.set(p.name, t);
        types.push(t);
      }
      const r = this.expr(def.body, { params });
      scheme = this.u.generalize(types, r);
    }
    this.current = saved;
    this.inProgress.delete(name);
    this.checked.set(name, {
      def,
      name,
      scheme,
      uses: cur.uses,
      refSpans: cur.refSpans,
      hasError: cur.errors > 0,
    });
    return scheme;
  }

  private edge(target: string, at: Span): void {
    if (!this.current) return;
    this.current.uses.defs.add(target);
    if (!this.current.refSpans.has(target)) this.current.refSpans.set(target, at);
    if (this.current.name === '') return; // a standalone expression is not part of the graph
    let set = this.edges.get(this.current.name);
    if (!set) {
      set = new Set();
      this.edges.set(this.current.name, set);
    }
    set.add(target);
  }

  /** Checks a standalone expression (a curve's) against the checked program. */
  checkStandalone(
    e: Expr,
    bindings: Map<string, Type>,
    element?: Type,
  ): { type: Type; diagnostics: Diagnostic[]; uses: DefUses } {
    const saved = this.current;
    const mark = this.diagnostics.length;
    const cur = { name: '', uses: emptyUses(), refSpans: new Map<string, Span>(), errors: 0 };
    this.current = cur;
    const scope: Scope = element ? { bindings, element } : { bindings };
    const type = this.expr(e, scope);
    this.current = saved;
    const diagnostics = this.diagnostics.splice(mark).map((d) => {
      const { def: _def, ...rest } = d;
      return rest;
    });
    return { type, diagnostics, uses: cur.uses };
  }

  /** Type `actual` must be `expected`; reports at `at` otherwise. */
  private want(actual: Type, expected: Type, at: Span, what: string, hint?: string): void {
    const shown = this.u.format(actual);
    const why = this.u.unify(actual, expected);
    if (why === null) return;
    const exp = this.u.format(expected);
    this.report(
      'type.mismatch',
      `${what} must be ${article(exp)}, not ${article(shown)}`,
      at,
      hint,
    );
  }

  private elementDepth(scope: Scope): { element: Type; depth: number } | null {
    let depth = 0;
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      if (s.element) return { element: s.element, depth };
      depth++;
    }
    return null;
  }

  /** The type of property `name` on an entity of (possibly unknown) kind, or null if none has it. */
  private propType(obj: Type, name: string, at: Span, objText: string): Type {
    const o = this.u.shallow(obj);
    if (o.t === 'var') this.u.unify(o, { t: 'entity', kind: this.u.freshKind() });
    const r = this.u.shallow(obj);
    if (r.t !== 'entity') {
      const shown = this.u.format(r);
      this.report(
        'type.no_props',
        `${objText} is ${article(shown)}, which has no properties`,
        at,
        r.t === 'list' ? `Use an aggregate, like sum(${objText}, .${name})` : undefined,
      );
      return this.u.fresh();
    }
    this.current?.uses.props.add(name);
    const kind = this.u.kind(r.kind);
    if (kind.k === 'kind') {
      const kp = propsOf(this.env.schema, kind.kind);
      const p = kp.props.get(name);
      if (p) return p.type;
      const bad = kp.unusable.get(name);
      if (bad) {
        this.report('prop.unusable', bad.why, at, bad.hint);
        return this.u.fresh();
      }
      const near = closest(name, kp.props.keys());
      this.report(
        'prop.unknown',
        `${article(kind.kind, true)} has no ${name}`,
        at,
        near ? `Did you mean ${near}?` : `Define ${name} as an attribute of ${kind.kind}`,
      );
      return this.u.fresh();
    }
    const kinds = kindsWithProp(this.env.schema, name);
    if (kinds.length === 0) {
      const all = new Set<string>();
      for (const k of Object.values(COLLECTIONS))
        if (k) for (const n of propsOf(this.env.schema, k).props.keys()) all.add(n);
      const near = closest(name, all);
      this.report(
        'prop.unknown',
        `No kind has a property ${name}`,
        at,
        near ? `Did you mean ${near}?` : `Define ${name} as an attribute of a kind`,
      );
      return this.u.fresh();
    }
    if (kinds.length === 1 && kind.k === 'kvar') {
      const only = kinds[0] as EntityKind;
      this.u.unifyKind(kind, { k: 'kind', kind: only });
      return (propsOf(this.env.schema, only).props.get(name) as Prop).type;
    }
    const types = kinds.map((k) => (propsOf(this.env.schema, k).props.get(name) as Prop).type);
    const first = types[0] as Type;
    const shown = this.u.format(first);
    if (types.every((t) => this.u.format(t) === shown)) return first;
    this.report(
      'prop.ambiguous',
      `${name} means different things for ${kinds.join(', ')}`,
      at,
      'Annotate the parameter with its kind, like  e: item',
    );
    return this.u.fresh();
  }

  private name(e: ExprOf<'name'>, scope: Scope): Type {
    const n = e.name;
    // Element properties first (innermost element scope).
    if (n === 'it') {
      const el = this.elementDepth(scope);
      if (el) {
        this.resolutions.set(e, { to: 'element', depth: el.depth });
        return el.element;
      }
      this.report(
        'name.it',
        '"it" only means something inside where or an aggregate',
        e.span,
        'Like  items where it.tier > 0',
      );
      return this.u.fresh();
    }
    let depth = 0;
    let elementKind: EntityKind | null = null;
    for (let s: Scope | undefined = scope; s; s = s.parent, depth++) {
      if (s.element) {
        const el = this.u.shallow(s.element);
        const maybeEntity = el.t === 'entity' || el.t === 'var';
        if (el.t === 'entity') {
          const k = this.u.kind(el.kind);
          if (k.k === 'kind') {
            elementKind ??= k.kind;
            // A field with no value form (a range, a climate) is still the
            // element's: say so instead of looking further out.
            const bad = propsOf(this.env.schema, k.kind).unusable.get(n);
            if (bad && !propsOf(this.env.schema, k.kind).props.has(n)) {
              this.report('prop.unusable', bad.why, e.span, bad.hint);
              return this.u.fresh();
            }
          }
        }
        if (maybeEntity && kindsWithProp(this.env.schema, n).length > 0) {
          const elKind = el.t === 'entity' ? this.u.kind(el.kind) : null;
          const hasIt =
            elKind?.k === 'kind' ? propsOf(this.env.schema, elKind.kind).props.has(n) : true;
          if (hasIt) {
            const shadowed = this.lookupOuter(n, s.parent ?? {});
            if (shadowed)
              this.report(
                'name.shadowed',
                `${n} here is the element's ${n}, not the ${shadowed} ${n}`,
                e.span,
                `Rename the ${shadowed}, or write it.${n} to make it explicit`,
                'warning',
              );
            this.resolutions.set(e, { to: 'prop', name: n, depth });
            return this.propType(s.element, n, e.span, 'it');
          }
        }
      }
      if (s.params?.has(n)) {
        this.resolutions.set(e, { to: 'param', name: n });
        return s.params.get(n) as Type;
      }
      if (s.bindings?.has(n)) {
        this.resolutions.set(e, { to: 'binding', name: n });
        return s.bindings.get(n) as Type;
      }
    }
    return this.global(e, n, elementKind);
  }

  private lookupOuter(n: string, scope: Scope): string | null {
    for (let s: Scope | undefined = scope; s; s = s.parent) {
      if (s.params?.has(n)) return 'parameter';
      if (s.bindings?.has(n)) return 'binding';
    }
    if (this.defs.has(n)) return 'definition';
    if (Object.prototype.hasOwnProperty.call(this.env.variables, n)) return 'variable';
    return null;
  }

  private global(e: ExprOf<'name'>, n: string, elementKind: EntityKind | null = null): Type {
    if (Object.prototype.hasOwnProperty.call(this.env.variables, n)) {
      this.resolutions.set(e, { to: 'var', name: n });
      this.current?.uses.variables.add(n);
      return varType(this.env.variables[n] as number | string | boolean);
    }
    if (this.defs.has(n)) {
      const def = this.defs.get(n) as Def;
      this.resolutions.set(e, { to: 'def', name: n });
      this.edge(n, e.span);
      if (def.type === 'func') {
        this.report(
          'name.func_value',
          `${n} is a function`,
          e.span,
          `Call it: ${n}(${def.params.map((p) => p.name).join(', ')})`,
        );
        this.ensure(n);
        return this.u.fresh();
      }
      const s = this.ensure(n);
      return s ? this.u.instantiate(s).result : this.u.fresh();
    }
    if (Object.prototype.hasOwnProperty.call(COLLECTIONS, n)) {
      const kind = COLLECTIONS[n] ?? null;
      this.resolutions.set(e, { to: 'collection', kind });
      this.current?.uses.kinds.add(kind ?? '*');
      return listOf(
        kind ? { t: 'entity', kind: { k: 'kind', kind } } : { t: 'entity', kind: { k: 'any' } },
      );
    }
    if (isBuiltin(n)) {
      this.report(
        'name.builtin_value',
        `${n} is a function`,
        e.span,
        `Call it: ${BUILTINS[n]?.usage ?? n}`,
      );
      return this.u.fresh();
    }
    const candidates = [
      ...this.defs.keys(),
      ...Object.keys(this.env.variables),
      ...Object.keys(COLLECTIONS),
    ];
    if (elementKind) {
      const props = [...propsOf(this.env.schema, elementKind).props.keys()];
      const near = closest(n, [...props, ...candidates]);
      this.report(
        'name.unknown',
        `${article(elementKind, true)} has no ${n}, and nothing else is called ${n}`,
        e.span,
        near ? `Did you mean ${near}?` : `Define ${n} as an attribute of ${elementKind}`,
      );
      return this.u.fresh();
    }
    const near = closest(n, candidates);
    this.report(
      'name.unknown',
      `Unknown name ${n}`,
      e.span,
      near
        ? `Did you mean ${near}?`
        : `Define it on its own line, like  ${n} = 1, or add a variable ${n}`,
    );
    return this.u.fresh();
  }

  private call(e: ExprOf<'call'>, scope: Scope): Type {
    const n = e.callee;
    const def = this.defs.get(n);
    if (def) {
      this.resolutions.set(e, { to: 'def', name: n });
      this.edge(n, e.calleeSpan);
      if (def.type === 'const') {
        this.report(
          'call.not_function',
          `${n} is a value, not a function`,
          e.calleeSpan,
          `Use it without parentheses: ${n}`,
        );
        for (const a of e.args) this.expr(a, scope);
        return this.u.fresh();
      }
      const argTypes = e.args.map((a) => this.expr(a, scope));
      if (e.args.length !== def.params.length) {
        this.report(
          'call.arity',
          `${n} takes ${plural(def.params.length, 'argument')}, not ${e.args.length}`,
          e.span,
          `Call it as ${n}(${def.params.map((p) => p.name).join(', ')})`,
        );
        this.ensure(n);
        return this.u.fresh();
      }
      const s = this.ensure(n);
      if (!s?.params) return this.u.fresh();
      const inst = this.u.instantiate(s);
      e.args.forEach((a, i) => {
        const pt = inst.params?.[i];
        const at = argTypes[i];
        if (pt && at) this.want(at, pt, a.span, `Argument ${def.params[i]?.name ?? i + 1} of ${n}`);
      });
      return inst.result;
    }
    const info = BUILTINS[n];
    if (!info && Object.prototype.hasOwnProperty.call(this.env.variables, n)) {
      for (const a of e.args) this.expr(a, scope);
      this.report(
        'call.not_function',
        `${n} is a variable, not a function`,
        e.calleeSpan,
        `Use it without parentheses: ${n}`,
      );
      return this.u.fresh();
    }
    if (!info) {
      for (const a of e.args) this.expr(a, scope);
      const near = closest(n, [
        ...[...this.defs.values()].filter((d) => d.type === 'func').map((d) => d.name),
        ...Object.keys(BUILTINS),
      ]);
      this.report(
        'call.unknown',
        `Unknown function ${n}`,
        e.calleeSpan,
        near ? `Did you mean ${near}?` : `Define it, like  ${n}(x) = x * 2`,
      );
      return this.u.fresh();
    }
    if (e.args.length < info.min || e.args.length > info.max) {
      for (const a of e.args) this.expr(a, scope);
      this.report(
        'call.arity',
        `${n} needs ${info.min === info.max ? info.min : `${info.min} or more`}${info.max !== info.min && info.max !== Infinity ? ` to ${info.max}` : ''} arguments, not ${e.args.length}`,
        e.span,
        `Use ${info.usage}`,
      );
      return this.u.fresh();
    }
    return this.builtin(e, scope);
  }

  private aggregate(
    e: ExprOf<'call'>,
    scope: Scope,
    perElementType: Type,
    fallbackElement: Type | null,
  ): Type {
    const [listArg, fn] = e.args as [Expr, Expr | undefined];
    const lt = this.expr(listArg, scope);
    const el = this.u.fresh();
    this.want(lt, listOf(el), listArg.span, `The first argument of ${e.callee}`);
    if (fn) {
      const t = this.expr(fn, { element: el, parent: scope });
      this.want(
        t,
        perElementType,
        fn.span,
        `The second argument of ${e.callee}`,
        perElementType.t === 'bool'
          ? 'Give a condition, like  .tier > 0'
          : 'Give a number per element, like  .defense',
      );
    } else if (fallbackElement) {
      const r = this.u.shallow(el);
      this.want(
        el,
        fallbackElement,
        listArg.span,
        `Each element of ${e.callee}'s list`,
        r.t === 'entity' ? `Say what to ${e.callee}: ${e.callee}(…, .value)` : undefined,
      );
    }
    return NUMBER;
  }

  private builtin(e: ExprOf<'call'>, scope: Scope): Type {
    const n = e.callee;
    const args = e.args;
    const nums = (): Type => {
      for (const a of args) this.want(this.expr(a, scope), NUMBER, a.span, `${n}'s argument`);
      return NUMBER;
    };
    switch (n) {
      case 'sum':
      case 'avg':
        return this.aggregate(e, scope, NUMBER, NUMBER);
      case 'count':
        return this.aggregate(e, scope, BOOL, null);
      case 'min':
      case 'max': {
        if (args.length <= 2) {
          const first = args[0] as Expr;
          // Type the first argument once to choose the form; the memo keeps
          // it from being checked (and reported) twice.
          const t = this.u.shallow(this.typeOfQuiet(first, scope));
          if (t.t === 'list') return this.aggregate(e, scope, NUMBER, NUMBER);
        }
        return nums();
      }
      case 'if': {
        const [c, a, b] = args as [Expr, Expr, Expr];
        this.want(this.expr(c, scope), BOOL, c.span, 'The condition of if');
        const ta = this.expr(a, scope);
        const tb = this.expr(b, scope);
        const shownA = this.u.format(ta);
        const shownB = this.u.format(tb);
        if (this.u.unify(tb, ta) !== null)
          this.report(
            'type.branches',
            `The two branches of if must have the same type, not ${shownA} and ${shownB}`,
            b.span,
          );
        return ta;
      }
      case 'contains': {
        const [l, x] = args as [Expr, Expr];
        const el = this.u.fresh();
        this.want(this.expr(l, scope), listOf(el), l.span, 'The first argument of contains');
        this.want(this.expr(x, scope), el, x.span, 'The value to look for');
        return BOOL;
      }
      default:
        return nums();
    }
  }

  /** The type of an expression, checked once and memoised (min/max need it before choosing a form). */
  private readonly quiet = new WeakMap<Expr, Type>();
  private typeOfQuiet(e: Expr, scope: Scope): Type {
    const t = this.expr(e, scope);
    this.quiet.set(e, t);
    return t;
  }

  expr(e: Expr, scope: Scope): Type {
    const memo = this.quiet.get(e);
    if (memo) {
      this.quiet.delete(e);
      return memo;
    }
    switch (e.type) {
      case 'num':
        return NUMBER;
      case 'str':
        return STRING;
      case 'bool':
        return BOOL;
      case 'error':
        return this.u.fresh();
      case 'none':
        return { t: 'entity', kind: { k: 'any' } };
      case 'name':
        return this.name(e, scope);
      case 'accessor': {
        const el = this.elementDepth(scope);
        if (!el) {
          this.report(
            'name.accessor',
            `.${e.name} only works inside where or an aggregate`,
            e.span,
            `Like  sum(items, .${e.name})`,
          );
          return this.u.fresh();
        }
        this.resolutions.set(e, { to: 'prop', name: e.name, depth: el.depth });
        return this.propType(el.element, e.name, e.nameSpan, 'it');
      }
      case 'member': {
        const ot = this.expr(e.object, scope);
        return this.propType(ot, e.name, e.nameSpan, describeExpr(e.object));
      }
      case 'call':
        return this.call(e, scope);
      case 'list': {
        const el = this.u.fresh();
        for (const item of e.items)
          this.want(
            this.expr(item, scope),
            el,
            item.span,
            'Every element of a list',
            'A list holds one type',
          );
        return listOf(el);
      }
      case 'unary': {
        const t = this.expr(e.operand, scope);
        if (e.op === '-') {
          this.want(t, NUMBER, e.operand.span, 'What - negates');
          return NUMBER;
        }
        this.want(t, BOOL, e.operand.span, 'What not negates');
        return BOOL;
      }
      case 'where': {
        const st = this.expr(e.source, scope);
        const el = this.u.fresh();
        this.want(
          st,
          listOf(el),
          e.source.span,
          'What where filters',
          'Filter a list, like  items where …',
        );
        const ct = this.expr(e.cond, { element: el, parent: scope });
        this.want(
          ct,
          BOOL,
          e.cond.span,
          'The condition after where',
          'Compare something, like  tier > 0',
        );
        return listOf(el);
      }
      case 'binary': {
        const lt = this.expr(e.left, scope);
        const rt = this.expr(e.right, scope);
        switch (e.op) {
          case 'and':
          case 'or':
            this.want(lt, BOOL, e.left.span, `Each side of ${e.op}`);
            this.want(rt, BOOL, e.right.span, `Each side of ${e.op}`);
            return BOOL;
          case '==':
          case '!=': {
            const ls = this.u.format(lt);
            const rs = this.u.format(rt);
            if (this.u.unify(rt, lt) !== null) {
              const entityVsString =
                (this.u.shallow(lt).t === 'entity' && this.u.shallow(rt).t === 'string') ||
                (this.u.shallow(lt).t === 'string' && this.u.shallow(rt).t === 'entity');
              this.report(
                'type.compare',
                `Can't compare ${article(ls)} with ${article(rs)}`,
                e.opSpan,
                entityVsString
                  ? `Compare names or ids, like  band.name == "Low Sky"  or  band.id == "low-sky"`
                  : undefined,
              );
            }
            return BOOL;
          }
          case '<':
          case '<=':
          case '>':
          case '>=':
            this.want(lt, NUMBER, e.left.span, `Each side of ${e.op}`);
            this.want(rt, NUMBER, e.right.span, `Each side of ${e.op}`);
            return BOOL;
          default:
            this.want(lt, NUMBER, e.left.span, `Each side of ${e.op}`);
            this.want(rt, NUMBER, e.right.span, `Each side of ${e.op}`);
            return NUMBER;
        }
      }
    }
  }

  /** A readable signature for a checked definition. */
  signature(name: string): string | undefined {
    const c = this.checked.get(name);
    return c ? formatScheme(c.scheme) : undefined;
  }
}

const VOWEL = /^[aeiou]/;
function article(type: string, capital = false): string {
  if (type.startsWith('list') || type === 'any' || type.startsWith('any'))
    return capital ? cap(type) : type;
  const a = VOWEL.test(type) ? 'an' : 'a';
  return `${capital ? cap(a) : a} ${type}`;
}
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeExpr(e: Expr): string {
  switch (e.type) {
    case 'name':
      return e.name;
    case 'member':
      return `${describeExpr(e.object)}.${e.name}`;
    case 'call':
      return `${e.callee}(…)`;
    default:
      return 'this';
  }
}
