import type { BinaryOp, Def, Expr, Program } from './ast';
import { BP } from './parser';

/**
 * The pretty-printer: canonical source for an AST, with the fewest
 * parentheses that keep its structure. `parse(print(ast))` gives back the same
 * AST (spans aside); the round-trip property test checks it.
 */
const BINARY_BP: Record<BinaryOp, number> = {
  or: BP.or,
  and: BP.and,
  '==': BP.compare,
  '!=': BP.compare,
  '<': BP.compare,
  '<=': BP.compare,
  '>': BP.compare,
  '>=': BP.compare,
  '+': BP.add,
  '-': BP.add,
  '*': BP.mul,
  '/': BP.mul,
  '%': BP.mul,
  '^': BP.pow,
};

/** How tightly an expression binds, for deciding where parentheses go. */
function precedence(e: Expr): number {
  switch (e.type) {
    case 'binary':
      return BINARY_BP[e.op];
    case 'where':
      return BP.where;
    case 'unary':
      return e.op === 'not' ? BP.not : BP.neg;
    default:
      return 100;
  }
}

export function printNumber(n: number): string {
  if (Object.is(n, -0)) return '0';
  return String(n);
}

export function printString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t')}"`;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function printExpr(e: Expr): string {
  const wrap = (child: Expr, needs: boolean): string =>
    needs ? `(${printExpr(child)})` : printExpr(child);
  switch (e.type) {
    case 'num':
      return printNumber(e.value);
    case 'str':
      return printString(e.value);
    case 'bool':
      return e.value ? 'true' : 'false';
    case 'none':
      return 'none';
    case 'name':
      return e.name;
    case 'accessor':
      return `.${e.name}`;
    case 'member':
      return `${wrap(e.object, precedence(e.object) < BP.postfix || e.object.type === 'num')}.${e.name}`;
    case 'call':
      return `${e.callee}(${e.args.map(printExpr).join(', ')})`;
    case 'list':
      return `[${e.items.map(printExpr).join(', ')}]`;
    case 'unary': {
      const p = e.op === 'not' ? BP.not : BP.neg;
      // A nested prefix operator is parenthesised for readability: -(-x).
      const needs = precedence(e.operand) < p || e.operand.type === 'unary';
      return e.op === 'not' ? `not ${wrap(e.operand, needs)}` : `-${wrap(e.operand, needs)}`;
    }
    case 'binary': {
      const p = BINARY_BP[e.op];
      const right = e.op === '^';
      const cmp = p === BP.compare;
      const lp = precedence(e.left);
      const rp = precedence(e.right);
      const left = wrap(e.left, lp < p || (lp === p && (right || cmp)));
      const r = wrap(e.right, rp < p || (rp === p && !right));
      return `${left} ${e.op} ${r}`;
    }
    case 'where': {
      const left = wrap(e.source, precedence(e.source) < BP.where);
      const cond = wrap(e.cond, precedence(e.cond) <= BP.where);
      return `${left} where ${cond}`;
    }
    case 'error':
      return '?';
  }
}

export function printDef(d: Def): string {
  const head =
    d.type === 'const'
      ? d.name
      : `${d.name}(${d.params.map((p) => (p.annotation ? `${p.name}: ${p.annotation.name}` : p.name)).join(', ')})`;
  const text = `${head} = ${printExpr(d.body)}`;
  return d.comment ? `${text}  ${d.comment}` : text;
}

/** The canonical source of a whole program: one definition per line, comments kept. */
export function printProgram(p: Program): string {
  const lines: string[] = [];
  for (const item of p.items) {
    if (item.type === 'comment') lines.push(item.text);
    else if (item.type === 'blank') lines.push('');
    else lines.push(printDef(item));
  }
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export const isIdentifier = (s: string): boolean => IDENT.test(s);
