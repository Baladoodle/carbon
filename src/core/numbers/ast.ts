import type { Span } from './span';

/**
 * The AST of carbon's expression language (docs/SYSTEM.md §6). Every node
 * carries the exact span of the source it came from. Parentheses leave no
 * node: `(a + b)` is the Binary node, with the span of the parenthesised text.
 */
export type BinaryOp =
  'or' | 'and' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '+' | '-' | '*' | '/' | '%' | '^';
export type UnaryOp = '-' | 'not';

export type Expr =
  | { type: 'num'; value: number; span: Span }
  | { type: 'str'; value: string; span: Span }
  | { type: 'bool'; value: boolean; span: Span }
  /** No entity: what an unplaced entity's `band` is. */
  | { type: 'none'; span: Span }
  | { type: 'name'; name: string; span: Span }
  /** `.defense`: a property of the current element (`it`), inside `where` or an aggregate. */
  | { type: 'accessor'; name: string; span: Span; nameSpan: Span }
  | { type: 'member'; object: Expr; name: string; span: Span; nameSpan: Span }
  | { type: 'call'; callee: string; calleeSpan: Span; args: Expr[]; span: Span }
  | { type: 'unary'; op: UnaryOp; operand: Expr; span: Span }
  | { type: 'binary'; op: BinaryOp; left: Expr; right: Expr; span: Span; opSpan: Span }
  | { type: 'where'; source: Expr; cond: Expr; span: Span; opSpan: Span }
  | { type: 'list'; items: Expr[]; span: Span }
  /** A syntax error inside an expression; the parser already reported it. */
  | { type: 'error'; span: Span };

export type ExprOf<T extends Expr['type']> = Extract<Expr, { type: T }>;

/** A parameter type annotation: `c: creature`, `raw: number`. */
export interface Param {
  name: string;
  span: Span;
  annotation?: { name: string; span: Span };
}

export interface ConstDef {
  type: 'const';
  name: string;
  nameSpan: Span;
  body: Expr;
  /** The whole definition, from its name to the end of its body. */
  span: Span;
  /** A `# comment` after it on the same line. */
  comment?: string;
}

export interface FuncDef {
  type: 'func';
  name: string;
  nameSpan: Span;
  params: Param[];
  body: Expr;
  span: Span;
  comment?: string;
}

export type Def = ConstDef | FuncDef;

/** A line that is only a comment, kept so the printer can keep it. */
export interface CommentLine {
  type: 'comment';
  text: string;
  span: Span;
}

/** A blank line between definitions (kept, collapsed to one). */
export interface BlankLine {
  type: 'blank';
  span: Span;
}

export type Item = Def | CommentLine | BlankLine;

export interface Program {
  items: Item[];
}

export const defsOf = (p: Program): Def[] =>
  p.items.filter((i): i is Def => i.type === 'const' || i.type === 'func');

/** Calls `fn` on every node of an expression, parents before children. */
export function walk(e: Expr, fn: (e: Expr) => void): void {
  fn(e);
  switch (e.type) {
    case 'member':
      walk(e.object, fn);
      break;
    case 'call':
      for (const a of e.args) walk(a, fn);
      break;
    case 'unary':
      walk(e.operand, fn);
      break;
    case 'binary':
      walk(e.left, fn);
      walk(e.right, fn);
      break;
    case 'where':
      walk(e.source, fn);
      walk(e.cond, fn);
      break;
    case 'list':
      for (const a of e.items) walk(a, fn);
      break;
    default:
      break;
  }
}

/** An expression with all spans removed, for comparing structure (e.g. round-trip tests). */
export function stripSpans(e: Expr): unknown {
  switch (e.type) {
    case 'num':
    case 'str':
    case 'bool':
      return { type: e.type, value: e.value };
    case 'none':
      return { type: 'none' };
    case 'name':
    case 'accessor':
      return { type: e.type, name: e.name };
    case 'member':
      return { type: 'member', object: stripSpans(e.object), name: e.name };
    case 'call':
      return { type: 'call', callee: e.callee, args: e.args.map(stripSpans) };
    case 'unary':
      return { type: 'unary', op: e.op, operand: stripSpans(e.operand) };
    case 'binary':
      return { type: 'binary', op: e.op, left: stripSpans(e.left), right: stripSpans(e.right) };
    case 'where':
      return { type: 'where', source: stripSpans(e.source), cond: stripSpans(e.cond) };
    case 'list':
      return { type: 'list', items: e.items.map(stripSpans) };
    case 'error':
      return { type: 'error' };
  }
}

export function stripDef(d: Def): unknown {
  return d.type === 'const'
    ? { type: 'const', name: d.name, body: stripSpans(d.body) }
    : {
        type: 'func',
        name: d.name,
        params: d.params.map((p) =>
          p.annotation ? { name: p.name, annotation: p.annotation.name } : { name: p.name },
        ),
        body: stripSpans(d.body),
      };
}
