import type { BinaryOp, Def, Expr, Item, Param, Program } from './ast';
import { lex, type Token } from './lexer';
import { cover, diag, type Diagnostic, type Span } from './span';

/**
 * A Pratt parser for carbon's expression language.
 *
 * A source is a sequence of lines; each non-blank line defines one name:
 *
 *     k = 100
 *     taken(raw, def) = raw * k / (k + def)
 *     band_defense(b: band) = sum(items where subkind == "armor" and band == b, .defense)
 *
 * Binding powers, loosest first (the printer uses the same table):
 *
 *   where 10 · or 20 · and 30 · not 35 (prefix) · comparisons 40 (don't chain)
 *   + − 50 · * / % 60 · unary − 65 · ^ 70 (right) · call and .member 80
 *
 * Errors never stop the parse: the first syntax error on a line is reported
 * with its span and a hint, and the next line parses on its own.
 */
export const BP = {
  where: 10,
  or: 20,
  and: 30,
  not: 35,
  compare: 40,
  add: 50,
  mul: 60,
  neg: 65,
  pow: 70,
  postfix: 80,
} as const;

const INFIX: Record<string, { bp: number; right?: boolean }> = {
  or: { bp: BP.or },
  and: { bp: BP.and },
  '==': { bp: BP.compare },
  '!=': { bp: BP.compare },
  '<': { bp: BP.compare },
  '<=': { bp: BP.compare },
  '>': { bp: BP.compare },
  '>=': { bp: BP.compare },
  '+': { bp: BP.add },
  '-': { bp: BP.add },
  '*': { bp: BP.mul },
  '/': { bp: BP.mul },
  '%': { bp: BP.mul },
  '^': { bp: BP.pow, right: true },
};

export const COMPARISONS = new Set(['==', '!=', '<', '<=', '>', '>=']);

class Stop extends Error {
  constructor(readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}

class LineParser {
  private i = 0;
  constructor(
    private readonly tokens: Token[],
    private readonly end: Span,
  ) {}

  peek(offset = 0): Token {
    return (
      this.tokens[this.i + offset] ?? {
        type: 'eof',
        text: '',
        span: this.end,
      }
    );
  }
  next(): Token {
    const t = this.peek();
    this.i++;
    return t;
  }
  atEnd(): boolean {
    return this.i >= this.tokens.length;
  }
  isOp(text: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.type === 'op' && t.text === text;
  }
  fail(code: string, message: string, at: Span, hint?: string): never {
    throw new Stop(diag('parse', code, message, at, { hint }));
  }
  expectOp(text: string, what: string, hint?: string): Token {
    const t = this.peek();
    if (t.type === 'op' && t.text === text) return this.next();
    this.fail('parse.expected', `Expected ${what}${describe(t)}`, t.span, hint);
  }

  parseDef(): Def {
    const name = this.next();
    if (name.type !== 'ident') {
      if (name.type === 'keyword')
        this.fail(
          'parse.keyword_name',
          `"${name.text}" is a keyword, not a name`,
          name.span,
          'Choose another name',
        );
      this.fail(
        'parse.def',
        'A line defines a name',
        name.span,
        'Start the line with a name, like  k = 100  or  f(x) = x * 2',
      );
    }
    let params: Param[] | undefined;
    if (this.isOp('(')) {
      this.next();
      params = [];
      if (!this.isOp(')'))
        for (;;) {
          const p = this.next();
          if (p.type !== 'ident')
            this.fail(
              'parse.param',
              `Expected a parameter name${describe(p)}`,
              p.span,
              'Parameters are names, like  f(raw, def)',
            );
          const param: Param = { name: p.text, span: p.span };
          if (this.isOp(':')) {
            this.next();
            const a = this.next();
            if (a.type !== 'ident')
              this.fail(
                'parse.annotation',
                `Expected a type after ":"${describe(a)}`,
                a.span,
                'Types are number, bool, string, list, entity or a kind such as band',
              );
            param.annotation = { name: a.text, span: a.span };
          }
          params.push(param);
          if (this.isOp(',')) {
            this.next();
            continue;
          }
          break;
        }
      this.expectOp(')', '")" after the parameters');
    }
    const eq = this.peek();
    if (!(eq.type === 'op' && eq.text === '=')) {
      if (eq.type === 'op' && eq.text === '==')
        this.fail('parse.def_eq', 'Use = to define a name', eq.span, `Write  ${name.text} = …`);
      this.fail(
        'parse.expected',
        `Expected "=" after ${name.text}${describe(eq)}`,
        eq.type === 'eof' ? name.span : eq.span,
        `Give it a value:  ${name.text} = …`,
      );
    }
    this.next();
    if (this.atEnd())
      this.fail(
        'parse.empty',
        `${name.text} has no value`,
        eq.span,
        `Write its value after "=", like  ${name.text} = 1`,
      );
    const body = this.expr(0);
    if (!this.atEnd()) {
      const t = this.peek();
      if (t.type === 'op' && t.text === '=')
        this.fail('parse.assign', 'Use == to compare', t.span, 'One line defines one name');
      if (t.type === 'op' && (t.text === ')' || t.text === ']'))
        this.fail(
          'parse.unbalanced',
          `Unmatched "${t.text}"`,
          t.span,
          'Remove it, or open it earlier',
        );
      this.fail(
        'parse.trailing',
        `Unexpected ${describeToken(t)}`,
        t.span,
        'Join it with an operator, like + or and',
      );
    }
    const span = cover(name.span, body.span);
    return params
      ? { type: 'func', name: name.text, nameSpan: name.span, params, body, span }
      : { type: 'const', name: name.text, nameSpan: name.span, body, span };
  }

  expr(minBp: number): Expr {
    let left = this.nud();
    let chained = false;
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && t.text === '(' && BP.postfix > minBp) {
        if (left.type !== 'name')
          this.fail(
            'parse.call',
            'Only a name can be called',
            t.span,
            'Join it with an operator, like *',
          );
        this.next();
        const args: Expr[] = [];
        if (!this.isOp(')'))
          for (;;) {
            args.push(this.expr(0));
            if (this.isOp(',')) {
              this.next();
              continue;
            }
            break;
          }
        const close = this.expectOp(')', `"," or ")" in the call to ${left.name}`);
        left = {
          type: 'call',
          callee: left.name,
          calleeSpan: left.span,
          args,
          span: cover(left.span, close.span),
        };
        continue;
      }
      if (t.type === 'op' && t.text === '.' && BP.postfix > minBp) {
        this.next();
        const n = this.next();
        if (n.type !== 'ident' && n.type !== 'keyword')
          this.fail(
            'parse.member',
            `Expected a property name after "."${describe(n)}`,
            n.span,
            'Like  c.health',
          );
        left = {
          type: 'member',
          object: left,
          name: n.text,
          span: cover(left.span, n.span),
          nameSpan: n.span,
        };
        continue;
      }
      if (t.type === 'keyword' && t.text === 'where' && BP.where > minBp) {
        this.next();
        if (this.atEnd())
          this.fail(
            'parse.where',
            '"where" needs a condition',
            t.span,
            'Like  items where subkind == "armor"',
          );
        const cond = this.expr(BP.where);
        left = {
          type: 'where',
          source: left,
          cond,
          span: cover(left.span, cond.span),
          opSpan: t.span,
        };
        continue;
      }
      const isInfix =
        (t.type === 'op' || t.type === 'keyword') &&
        Object.prototype.hasOwnProperty.call(INFIX, t.text);
      if (!isInfix) {
        if (t.type === 'op' && t.text === '=' && minBp < BP.compare)
          this.fail('parse.assign', 'Use == to compare', t.span, 'One line defines one name');
        break;
      }
      const info = INFIX[t.text];
      if (!info || info.bp <= minBp) break;
      const isCompare = COMPARISONS.has(t.text);
      if (isCompare && chained)
        this.fail('parse.chain', "Comparisons don't chain", t.span, 'Write  a < b and b < c');
      this.next();
      if (this.atEnd()) this.fail('parse.operand', `"${t.text}" needs a value after it`, t.span);
      const right = this.expr(info.right ? info.bp - 1 : info.bp);
      left = {
        type: 'binary',
        op: t.text as BinaryOp,
        left,
        right,
        span: cover(left.span, right.span),
        opSpan: t.span,
      };
      chained = isCompare;
    }
    return left;
  }

  nud(): Expr {
    const t = this.next();
    switch (t.type) {
      case 'number':
        return { type: 'num', value: t.num ?? 0, span: t.span };
      case 'string':
        return { type: 'str', value: t.value ?? '', span: t.span };
      case 'ident':
        return { type: 'name', name: t.text, span: t.span };
      case 'keyword':
        if (t.text === 'true' || t.text === 'false')
          return { type: 'bool', value: t.text === 'true', span: t.span };
        if (t.text === 'none') return { type: 'none', span: t.span };
        if (t.text === 'not') {
          const operand = this.expr(BP.not);
          return { type: 'unary', op: 'not', operand, span: cover(t.span, operand.span) };
        }
        this.fail('parse.value', `Expected a value before "${t.text}"`, t.span);
      // falls through (fail never returns)
      case 'op':
        if (t.text === '(') {
          if (this.isOp(')'))
            this.fail(
              'parse.value',
              'Empty parentheses',
              cover(t.span, this.peek().span),
              'Put a value inside, or remove them',
            );
          const inner = this.expr(0);
          const close = this.expectOp(')', '")"', 'Close the parenthesis');
          return { ...inner, span: cover(t.span, close.span) };
        }
        if (t.text === '[') {
          const items: Expr[] = [];
          if (!this.isOp(']'))
            for (;;) {
              items.push(this.expr(0));
              if (this.isOp(',')) {
                this.next();
                continue;
              }
              break;
            }
          const close = this.expectOp(']', '"," or "]" in the list');
          return { type: 'list', items, span: cover(t.span, close.span) };
        }
        if (t.text === '-') {
          const operand = this.expr(BP.neg);
          return { type: 'unary', op: '-', operand, span: cover(t.span, operand.span) };
        }
        if (t.text === '.') {
          const n = this.next();
          if (n.type !== 'ident' && n.type !== 'keyword')
            this.fail(
              'parse.member',
              `Expected a property name after "."${describe(n)}`,
              n.span,
              'Like  .defense',
            );
          return { type: 'accessor', name: n.text, span: cover(t.span, n.span), nameSpan: n.span };
        }
        if (t.text === '+') this.fail('parse.plus', 'There is no unary +', t.span, 'Remove the +');
        this.fail('parse.value', `Expected a value${describe(t)}`, t.span);
      // falls through
      case 'eof':
      case 'newline':
      case 'comment':
        this.fail('parse.value', 'Expected a value here', t.span);
    }
  }
}

const describeToken = (t: Token): string =>
  t.type === 'eof' || t.type === 'newline'
    ? 'end of line'
    : t.type === 'string'
      ? 'text'
      : `"${t.text}"`;
const describe = (t: Token): string => `, found ${describeToken(t)}`;

export interface ParseResult {
  program: Program;
  diagnostics: Diagnostic[];
}

/** Parses a whole `formulas.carbon` source. Never throws. */
export function parseProgram(source: string): ParseResult {
  const { tokens, diagnostics } = lex(source);
  const items: Item[] = [];
  let line: Token[] = [];
  let comment: Token | undefined;
  let pendingBlank: Span | undefined;
  const flush = (end: Span): void => {
    if (line.length === 0) {
      if (comment) {
        if (pendingBlank && items.length > 0) items.push({ type: 'blank', span: pendingBlank });
        pendingBlank = undefined;
        items.push({ type: 'comment', text: comment.text, span: comment.span });
      } else pendingBlank ??= end;
      comment = undefined;
      return;
    }
    if (pendingBlank && items.length > 0) items.push({ type: 'blank', span: pendingBlank });
    pendingBlank = undefined;
    const first = line[0];
    const last = line[line.length - 1];
    const lineEnd = last ? { start: last.span.end, end: last.span.end } : end;
    const p = new LineParser(line, lineEnd);
    try {
      const def = p.parseDef();
      if (comment) def.comment = comment.text;
      items.push(def);
    } catch (e) {
      if (!(e instanceof Stop)) throw e;
      diagnostics.push(e.diagnostic);
      // Keep the name defined (with an error body), so other lines don't also
      // report it as unknown.
      const name = first;
      if (name && name.type === 'ident') {
        const params: Param[] = [];
        let isFunc = false;
        const eqAt = line.findIndex((t) => t.type === 'op' && t.text === '=');
        if (line[1]?.type === 'op' && line[1].text === '(') {
          isFunc = true;
          for (let k = 2; k < line.length; k++) {
            const tk = line[k];
            if (!tk || (tk.type === 'op' && tk.text === ')')) break;
            if (tk.type === 'ident' && !(line[k - 1]?.type === 'op' && line[k - 1]?.text === ':'))
              params.push({ name: tk.text, span: tk.span });
          }
        }
        if (eqAt > 0) {
          const span = cover(name.span, last ? last.span : name.span);
          const body: Expr = { type: 'error', span };
          items.push(
            isFunc
              ? { type: 'func', name: name.text, nameSpan: name.span, params, body, span }
              : { type: 'const', name: name.text, nameSpan: name.span, body, span },
          );
        }
      }
    }
    line = [];
    comment = undefined;
  };
  for (const t of tokens) {
    if (t.type === 'newline' || t.type === 'eof') {
      flush(t.span);
      continue;
    }
    if (t.type === 'comment') {
      comment = t;
      continue;
    }
    line.push(t);
  }
  return { program: { items }, diagnostics };
}

/** Parses one standalone expression (a curve's, a query typed in the view). */
export function parseExpression(source: string): { expr: Expr; diagnostics: Diagnostic[] } {
  const { tokens, diagnostics } = lex(source);
  const toks = tokens.filter(
    (t) => t.type !== 'comment' && t.type !== 'newline' && t.type !== 'eof',
  );
  const end = { start: source.length, end: source.length };
  if (toks.length === 0) {
    diagnostics.push(diag('parse', 'parse.empty', 'Expected an expression', end));
    return { expr: { type: 'error', span: end }, diagnostics };
  }
  const p = new LineParser(toks, end);
  try {
    const expr = p.expr(0);
    if (!p.atEnd()) {
      const t = p.peek();
      p.fail(
        'parse.trailing',
        `Unexpected ${describeToken(t)}`,
        t.span,
        'Join it with an operator, like + or and',
      );
    }
    return { expr, diagnostics };
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    diagnostics.push(e.diagnostic);
    return { expr: { type: 'error', span: { start: 0, end: source.length } }, diagnostics };
  }
}
