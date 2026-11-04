import type { Entity } from '../model/entity';
import { heightValue, type Height } from '../model/fields';
import { ENTITY_KINDS, type EntityKind } from '../model/kinds';
import type { WorldSchema } from '../model/schema';
import { getEntity, type World } from '../model/world';
import type { Expr, ExprOf } from './ast';
import type { Checker, Resolution } from './check';
import type { Placed } from './placement';
import { propsOf, type Prop } from './props';
import { diag, type Diagnostic, type Span } from './span';
import {
  entityRef,
  isEntity,
  isList,
  listValue,
  valueEquals,
  type EntityRef,
  type Value,
} from './values';

/**
 * The evaluator: a tree walk over checked ASTs. No `eval`, no `Function`, no
 * clock and no randomness, so the same world always gives the same values.
 * Every node costs a step and a definition stops at the step limit, so a huge
 * query can't hang the app. Errors are values of the definition, with a span.
 *
 * Collections (`items`, `bands`, …) leave out graveyard entities and are in id
 * order. Each evaluation records what it read (variables, definitions,
 * entities, collections, placements); the engine uses that to re-evaluate only
 * what a change touches.
 */
export const DEFAULT_STEP_LIMIT = 200_000;

export type DefResult = { ok: true; value: Value } | { ok: false; error: Diagnostic };

export interface EvalWorld {
  world: World;
  schema: WorldSchema;
  placement: Map<string, Placed>;
}

export class EvalFail extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

interface Frame {
  params?: Map<string, Value>;
  bindings?: Map<string, Value>;
  element?: Value;
  parent?: Frame;
}

/** Read tokens: `var:k`, `def:f`, `entity:id`, `kind:item`, `placement:id`. */
export type ReadSet = Set<string>;

export class Evaluator {
  steps = 0;
  readonly reads: ReadSet = new Set();

  constructor(
    private readonly w: EvalWorld,
    private readonly checker: Checker,
    private readonly values: (name: string) => DefResult | undefined,
    private readonly defName: string | undefined,
    private readonly stepLimit = DEFAULT_STEP_LIMIT,
  ) {}

  private fail(code: string, message: string, at: Span, hint?: string): never {
    throw new EvalFail(diag('eval', code, message, at, { hint, def: this.defName }));
  }

  private num(v: number, at: Span, what: string, hint?: string): number {
    if (Number.isNaN(v)) this.fail('eval.nan', `${what} is not a number`, at, hint);
    return v;
  }

  private entity(id: string, at: Span): Entity {
    this.reads.add(`entity:${id}`);
    const e = getEntity(this.w.world, id);
    if (!e) this.fail('eval.missing_entity', `There is no entity "${id}"`, at);
    return e;
  }

  private nameOf(id: string): string {
    return getEntity(this.w.world, id)?.name ?? id;
  }

  /** Reads property `name` of an entity value. */
  prop(v: Value, name: string, at: Span): Value {
    if (!isEntity(v)) this.fail('eval.no_props', `This value has no ${name}`, at);
    if (v.id === null)
      this.fail(
        'eval.none',
        `There is no entity here to read ${name} from`,
        at,
        'Filter first, like  where band != none',
      );
    const e = this.entity(v.id, at);
    const p = propsOf(this.w.schema, e.kind).props.get(name);
    if (!p)
      this.fail(
        'eval.no_prop',
        `${e.name} (${e.kind}) has no ${name}`,
        at,
        `Filter by kind first, like  where kind == "item"`,
      );
    return this.read(e, p, at);
  }

  private read(e: Entity, p: Prop, at: Span): Value {
    const s = p.source;
    switch (s.from) {
      case 'common':
        if (s.key === 'tags') return listValue([...e.tags]);
        return e[s.key];
      case 'placement': {
        this.reads.add(`placement:${e.id}`);
        const placed = this.w.placement.get(e.id);
        if (s.key === 'band') return entityRef(placed?.band ?? null);
        if (placed?.tier === null || placed?.tier === undefined)
          this.fail(
            'eval.unplaced',
            `${e.name} has no place yet, so no tier`,
            at,
            'Leave out unplaced entities, like  where band != none and tier > 0',
          );
        return placed.tier;
      }
      case 'field': {
        const raw = e.fields[s.key];
        const t = s.def.type;
        if (raw === undefined || raw === null) {
          if (t === 'text' || t === 'longtext' || t === 'enum') return '';
          if (t === 'boolean') return false;
          if (t === 'list') return listValue([]);
          if (t === 'ref') return entityRef(null);
          this.fail(
            'eval.empty_field',
            `${e.name} has no ${s.def.label.toLowerCase()} yet`,
            at,
            `Fill in ${s.key} on the Bench`,
          );
        }
        switch (t) {
          case 'text':
          case 'longtext':
          case 'enum':
            return typeof raw === 'string' ? raw : JSON.stringify(raw);
          case 'number':
            return typeof raw === 'number'
              ? raw
              : this.fail('eval.field_type', `${e.name}'s ${s.key} is not a number`, at);
          case 'height':
            return heightValue(raw as Height);
          case 'boolean':
            return raw === true;
          case 'list':
            return listValue(Array.isArray(raw) ? raw.map(String) : []);
          case 'ref':
            return entityRef(typeof raw === 'string' && getEntity(this.w.world, raw) ? raw : null);
          case 'range': {
            const r = raw as { min?: unknown; max?: unknown };
            const v = s.part === 'max' ? r.max : r.min;
            return typeof v === 'number'
              ? v
              : this.fail('eval.field_type', `${e.name}'s ${s.key} has no ${s.part ?? 'min'}`, at);
          }
          default:
            return this.fail('eval.field_type', `${s.key} has no value form`, at);
        }
      }
      case 'attribute': {
        const def = s.def;
        if (def.when)
          for (const [field, want] of Object.entries(def.when)) {
            const have = e.fields[field];
            if (have !== want)
              this.fail(
                'eval.attribute_when',
                `${def.key} doesn't apply to ${e.name}: its ${field} is ${typeof have === 'string' && have ? have : 'empty'}, not ${want}`,
                at,
                `Filter first, like  where ${field} == "${want}"`,
              );
          }
        const v = Object.prototype.hasOwnProperty.call(e.attributes, def.key)
          ? e.attributes[def.key]
          : def.default;
        if (v === undefined)
          this.fail(
            'eval.attribute_unset',
            `${e.name} has no ${def.key}`,
            at,
            `Set ${def.key} on ${e.name}, or give ${e.kind}.${def.key} a default`,
          );
        return v;
      }
    }
  }

  private collection(kind: EntityKind | null): Value {
    const kinds = kind ? [kind] : ENTITY_KINDS;
    for (const k of kinds) this.reads.add(`kind:${k}`);
    const ids = Object.values(this.w.world.entities)
      .filter((e) => (kind === null || e.kind === kind) && e.state !== 'graveyard')
      .map((e) => e.id)
      .sort();
    return listValue(ids.map((id) => entityRef(id)));
  }

  private resolution(e: Expr): Resolution {
    const r = this.checker.resolutions.get(e);
    if (!r) this.fail('eval.internal', 'This was not checked', e.span);
    return r;
  }

  private def(name: string, at: Span): Value {
    this.reads.add(`def:${name}`);
    const r = this.values(name);
    if (!r) this.fail('eval.dependency', `${name} has no value`, at);
    if (!r.ok)
      this.fail(
        'eval.dependency',
        `${name} has an error: ${r.error.message}`,
        at,
        'Fix that first',
      );
    return r.value;
  }

  private list(v: Value, at: Span, what: string): Value[] {
    if (!isList(v)) this.fail('eval.type', `${what} is not a list`, at);
    return v.items;
  }

  private number(v: Value, at: Span, what: string): number {
    if (typeof v !== 'number') this.fail('eval.type', `${what} is not a number`, at);
    return v;
  }

  private bool(v: Value, at: Span, what: string): boolean {
    if (typeof v !== 'boolean') this.fail('eval.type', `${what} is not true or false`, at);
    return v;
  }

  /** Evaluates `fn` once per element of `items`, with the element as `it`. */
  private each<T>(
    items: Value[],
    fn: Expr | undefined,
    frame: Frame,
    map: (v: Value, at: Span) => T,
    fallback: (v: Value) => T,
  ): T[] {
    if (!fn) return items.map(fallback);
    return items.map((el) => map(this.evaluate(fn, { element: el, parent: frame }), fn.span));
  }

  private builtin(e: ExprOf<'call'>, frame: Frame): Value {
    const n = e.callee;
    const a = e.args;
    const arg = (i: number): Expr => a[i] as Expr;
    const numArg = (i: number): number =>
      this.number(this.evaluate(arg(i), frame), arg(i).span, `${n}'s argument`);
    const out = (v: number, hint?: string): number => this.num(v, e.span, `${n}(…)`, hint);
    const perElementNumbers = (): number[] => {
      const items = this.list(this.evaluate(arg(0), frame), arg(0).span, `${n}'s first argument`);
      return this.each(
        items,
        a[1],
        frame,
        (v, at) => this.number(v, at, 'Each value'),
        (v) => this.number(v, arg(0).span, 'Each element'),
      );
    };
    switch (n) {
      case 'sum':
        return out(perElementNumbers().reduce((s, x) => s + x, 0));
      case 'avg': {
        const xs = perElementNumbers();
        if (xs.length === 0)
          this.fail(
            'eval.empty',
            'avg of an empty list',
            e.span,
            'Guard it, like  if(count(list) == 0, 0, avg(list, .value))',
          );
        return out(xs.reduce((s, x) => s + x, 0) / xs.length);
      }
      case 'count': {
        const items = this.list(this.evaluate(arg(0), frame), arg(0).span, "count's first argument");
        if (!a[1]) return items.length;
        return this.each(
          items,
          a[1],
          frame,
          (v, at) => this.bool(v, at, 'The condition'),
          () => true,
        ).filter(Boolean).length;
      }
      case 'min':
      case 'max': {
        const first = this.evaluate(arg(0), frame);
        let xs: number[];
        if (isList(first)) {
          xs = this.each(
            first.items,
            a[1],
            frame,
            (v, at) => this.number(v, at, 'Each value'),
            (v) => this.number(v, arg(0).span, 'Each element'),
          );
          if (xs.length === 0)
            this.fail(
              'eval.empty',
              `${n} of an empty list`,
              e.span,
              `Guard it, like  if(count(list) == 0, 0, ${n}(list, .value))`,
            );
        } else
          xs = [
            this.number(first, arg(0).span, `${n}'s argument`),
            ...a.slice(1).map((_, i) => numArg(i + 1)),
          ];
        return n === 'min' ? Math.min(...xs) : Math.max(...xs);
      }
      case 'if': {
        const c = this.bool(this.evaluate(arg(0), frame), arg(0).span, 'The condition');
        return this.evaluate(c ? arg(1) : arg(2), frame);
      }
      case 'contains': {
        const items = this.list(this.evaluate(arg(0), frame), arg(0).span, "contains's first argument");
        const x = this.evaluate(arg(1), frame);
        return items.some((v) => valueEquals(v, x));
      }
      case 'clamp': {
        const [x, lo, hi] = [numArg(0), numArg(1), numArg(2)];
        if (lo > hi)
          this.fail(
            'eval.clamp',
            `clamp's low (${lo}) is above its high (${hi})`,
            e.span,
            'Swap them',
          );
        return Math.min(hi, Math.max(lo, x));
      }
      case 'log': {
        const x = numArg(0);
        if (x <= 0) this.fail('eval.log', `log of ${x}`, e.span, 'log needs a number above 0');
        if (a.length === 1) return out(Math.log(x));
        const base = numArg(1);
        if (base <= 0 || base === 1)
          this.fail(
            'eval.log',
            `log base ${base}`,
            arg(1).span,
            'Use a base above 0 other than 1, like 10',
          );
        return out(Math.log(x) / Math.log(base));
      }
      case 'exp':
        return out(Math.exp(numArg(0)));
      case 'pow':
        return out(Math.pow(numArg(0), numArg(1)), 'A negative base needs a whole exponent');
      case 'sqrt': {
        const x = numArg(0);
        if (x < 0)
          this.fail(
            'eval.sqrt',
            `sqrt of ${x}`,
            e.span,
            'sqrt needs a number of 0 or more; use abs() first',
          );
        return Math.sqrt(x);
      }
      case 'abs':
        return Math.abs(numArg(0));
      case 'floor':
        return Math.floor(numArg(0));
      case 'ceil':
        return Math.ceil(numArg(0));
      case 'round': {
        const x = numArg(0);
        if (a.length === 1) return Math.round(x);
        const d = numArg(1);
        if (!Number.isInteger(d) || d < 0 || d > 15)
          this.fail(
            'eval.round',
            `round to ${d} digits`,
            arg(1).span,
            'Use a whole number from 0 to 15',
          );
        const f = Math.pow(10, d);
        return Math.round(x * f) / f;
      }
      case 'lerp': {
        const [x, y, t] = [numArg(0), numArg(1), numArg(2)];
        return out(x + (y - x) * t);
      }
      default:
        return this.fail('eval.internal', `Unknown function ${n}`, e.calleeSpan);
    }
  }

  private call(e: ExprOf<'call'>, frame: Frame): Value {
    const r = this.checker.resolutions.get(e);
    if (!r) return this.builtin(e, frame);
    if (r.to !== 'def') this.fail('eval.internal', 'Not a function', e.calleeSpan);
    const def = this.checker.defs.get(r.name);
    if (def?.type !== 'func')
      this.fail('eval.internal', `${r.name} is not a function`, e.calleeSpan);
    this.reads.add(`def:${r.name}`);
    const params = new Map<string, Value>();
    def.params.forEach((p, i) => params.set(p.name, this.evaluate(e.args[i] as Expr, frame)));
    return this.evaluate(def.body, { params });
  }

  evaluate(e: Expr, frame: Frame): Value {
    if (++this.steps > this.stepLimit)
      this.fail(
        'eval.steps',
        `Stopped after ${this.stepLimit.toLocaleString('en-US')} steps`,
        e.span,
        'Narrow the query, or split the formula',
      );
    switch (e.type) {
      case 'num':
      case 'str':
      case 'bool':
        return e.value;
      case 'none':
        return entityRef(null);
      case 'error':
        return this.fail('eval.syntax', 'This has a syntax error', e.span);
      case 'list':
        return listValue(e.items.map((x) => this.evaluate(x, frame)));
      case 'name': {
        const r = this.resolution(e);
        switch (r.to) {
          case 'param':
          case 'binding':
            for (let f: Frame | undefined = frame; f; f = f.parent) {
              const v = r.to === 'param' ? f.params?.get(r.name) : f.bindings?.get(r.name);
              if (v !== undefined) return v;
            }
            return this.fail('eval.internal', `${r.name} is unbound`, e.span);
          case 'element':
          case 'prop': {
            let f: Frame | undefined = frame;
            for (let i = 0; i < r.depth && f; i++) f = f.parent;
            const el = f?.element;
            if (el === undefined) return this.fail('eval.internal', 'No element here', e.span);
            return r.to === 'element' ? el : this.prop(el, r.name, e.span);
          }
          case 'def':
            return this.def(r.name, e.span);
          case 'var': {
            this.reads.add(`var:${r.name}`);
            const v = this.w.world.numbers.variables[r.name];
            if (v === undefined)
              return this.fail('eval.internal', `${r.name} is not a variable`, e.span);
            return v;
          }
          case 'collection':
            return this.collection(r.kind);
        }
        break;
      }
      case 'accessor': {
        const r = this.resolution(e);
        if (r.to !== 'prop') return this.fail('eval.internal', 'Not a property', e.span);
        let f: Frame | undefined = frame;
        for (let i = 0; i < r.depth && f; i++) f = f.parent;
        if (f?.element === undefined) return this.fail('eval.internal', 'No element here', e.span);
        return this.prop(f.element, e.name, e.nameSpan);
      }
      case 'member':
        return this.prop(this.evaluate(e.object, frame), e.name, e.nameSpan);
      case 'call':
        return this.call(e, frame);
      case 'unary': {
        const v = this.evaluate(e.operand, frame);
        return e.op === '-'
          ? -this.number(v, e.operand.span, 'What - negates')
          : !this.bool(v, e.operand.span, 'What not negates');
      }
      case 'where': {
        const items = this.list(this.evaluate(e.source, frame), e.source.span, 'What where filters');
        return listValue(
          items.filter((el) =>
            this.bool(
              this.evaluate(e.cond, { element: el, parent: frame }),
              e.cond.span,
              'The condition',
            ),
          ),
        );
      }
      case 'binary': {
        if (e.op === 'and' || e.op === 'or') {
          const l = this.bool(this.evaluate(e.left, frame), e.left.span, `The left side of ${e.op}`);
          if (e.op === 'and' ? !l : l) return l;
          return this.bool(this.evaluate(e.right, frame), e.right.span, `The right side of ${e.op}`);
        }
        const l = this.evaluate(e.left, frame);
        const r = this.evaluate(e.right, frame);
        if (e.op === '==') return valueEquals(l, r);
        if (e.op === '!=') return !valueEquals(l, r);
        const x = this.number(l, e.left.span, `The left side of ${e.op}`);
        const y = this.number(r, e.right.span, `The right side of ${e.op}`);
        switch (e.op) {
          case '<':
            return x < y;
          case '<=':
            return x <= y;
          case '>':
            return x > y;
          case '>=':
            return x >= y;
          case '+':
            return this.num(x + y, e.span, 'The sum');
          case '-':
            return this.num(x - y, e.span, 'The difference');
          case '*':
            return this.num(x * y, e.span, 'The product');
          case '/':
            if (y === 0)
              this.fail(
                'eval.div_zero',
                'Division by zero',
                e.span,
                'Guard it, like  if(d == 0, 0, n / d)',
              );
            return this.num(x / y, e.span, 'The quotient');
          case '%':
            if (y === 0) this.fail('eval.div_zero', 'Remainder of division by zero', e.span);
            return this.num(x % y, e.span, 'The remainder');
          case '^':
            return this.num(
              Math.pow(x, y),
              e.span,
              'The power',
              'A negative base needs a whole exponent',
            );
        }
      }
    }
    return this.fail('eval.internal', 'Unknown expression', e.span);
  }

  /** Evaluates and catches: a value, or the error with its span. */
  run(e: Expr, frame: Frame = {}): DefResult {
    try {
      return { ok: true, value: this.evaluate(e, frame) };
    } catch (x) {
      if (x instanceof EvalFail) return { ok: false, error: x.diagnostic };
      throw x;
    }
  }

  /** Evaluates with bindings (a curve's `x`) and an optional element (a dot's `it`). */
  runWith(e: Expr, bindings: Map<string, Value>, element?: Value): DefResult {
    return this.run(e, element === undefined ? { bindings } : { bindings, element });
  }

  /** `it.name` for a dot: reads a property directly. */
  propOf(ref: EntityRef, name: string, at: Span): DefResult {
    try {
      return { ok: true, value: this.prop(ref, name, at) };
    } catch (x) {
      if (x instanceof EvalFail) return { ok: false, error: x.diagnostic };
      throw x;
    }
  }

  get name(): (id: string) => string {
    return (id) => this.nameOf(id);
  }
}
