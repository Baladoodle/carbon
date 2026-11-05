import { ENTITY_KINDS } from '../model/kinds';
import type { WorldSchema } from '../model/schema';
import { defsOf } from './ast';
import { BUILTINS } from './builtins';
import type { NumbersAnalysis } from './engine';
import { KEYWORDS, lex } from './lexer';
import { COLLECTIONS, propsOf } from './props';

/**
 * Name completion for the formula editor: what can be typed at a caret, from
 * the analysis (definitions with their types), the variables, the built-ins,
 * the collections, entity properties and the keywords. Pure, so it's tested
 * here and the editor only draws the list.
 */
export type CompletionKind =
  'param' | 'def' | 'variable' | 'builtin' | 'collection' | 'property' | 'keyword';

export interface Completion {
  label: string;
  kind: CompletionKind;
  /** A type, a value or a usage, shown dimmed next to the label. */
  detail: string;
  /** What accepting it inserts (a function's name gets its opening parenthesis). */
  insert: string;
}

export interface Completions {
  /** The span the accepted completion replaces (the name typed so far). */
  from: number;
  to: number;
  items: Completion[];
}

const RANK: Record<CompletionKind, number> = {
  param: 0,
  def: 1,
  variable: 2,
  property: 3,
  collection: 4,
  builtin: 5,
  keyword: 6,
};

const isIdent = (c: string): boolean => /[A-Za-z0-9_]/.test(c);

export interface CompleteOptions {
  schema: WorldSchema;
  variables: Record<string, number | string | boolean>;
  /** Show completions with nothing typed yet (an explicit ctrl+space). */
  explicit?: boolean;
  limit?: number;
}

export function completions(
  analysis: NumbersAnalysis,
  source: string,
  offset: number,
  opts: CompleteOptions,
): Completions | null {
  const at = Math.max(0, Math.min(offset, source.length));
  let from = at;
  while (from > 0 && isIdent(source.charAt(from - 1))) from--;
  const prefix = source.slice(from, at);
  // Not inside a string or a comment, and not a number.
  for (const t of lex(source).tokens)
    if ((t.type === 'string' || t.type === 'comment') && t.span.start < at && at <= t.span.end)
      if (!(t.type === 'string' && t.span.end === at && source.charAt(at - 1) === '"')) return null;
  if (/^[0-9]/.test(prefix)) return null;
  const member = source.charAt(from - 1) === '.';
  if (!member && prefix === '' && !opts.explicit) return null;

  const items = new Map<string, Completion>();
  const add = (c: Completion): void => {
    const had = items.get(c.label);
    if (!had || RANK[c.kind] < RANK[had.kind]) items.set(c.label, c);
  };
  // Entity properties: after a dot only these.
  const props = new Map<string, Set<string>>();
  for (const k of ENTITY_KINDS)
    for (const p of propsOf(opts.schema, k).props.values()) {
      let s = props.get(p.name);
      if (!s) props.set(p.name, (s = new Set()));
      s.add(k);
    }
  for (const [name, kinds] of props)
    add({
      label: name,
      kind: 'property',
      detail: kinds.size === ENTITY_KINDS.length ? 'every kind' : [...kinds].join(', '),
      insert: name,
    });
  if (!member) {
    // The parameters of the definition the caret is in.
    const line = source.lastIndexOf('\n', at - 1) + 1;
    const here = defsOf(analysis.program).find((d) => d.span.start >= line && d.span.start < at);
    if (here?.type === 'func')
      for (const p of here.params)
        add({
          label: p.name,
          kind: 'param',
          detail: p.annotation?.name ?? 'parameter',
          insert: p.name,
        });
    for (const d of analysis.defs)
      if (d.name !== here?.name)
        add({
          label: d.name,
          kind: 'def',
          detail: d.type,
          insert: d.kind === 'func' ? `${d.name}(` : d.name,
        });
    for (const [name, v] of Object.entries(opts.variables))
      add({ label: name, kind: 'variable', detail: JSON.stringify(v), insert: name });
    for (const b of Object.values(BUILTINS))
      add({ label: b.name, kind: 'builtin', detail: b.usage, insert: `${b.name}(` });
    for (const [name, kind] of Object.entries(COLLECTIONS))
      add({
        label: name,
        kind: 'collection',
        detail: `list of ${kind ?? 'entity'}`,
        insert: name,
      });
    for (const k of KEYWORDS) add({ label: k, kind: 'keyword', detail: '', insert: k });
    add({ label: 'it', kind: 'keyword', detail: 'the current element', insert: 'it' });
  }
  const lower = prefix.toLowerCase();
  const out = [...items.values()]
    .filter((c) => c.label.toLowerCase().startsWith(lower) && c.label !== prefix)
    .sort(
      (a, b) =>
        Number(!a.label.startsWith(prefix)) - Number(!b.label.startsWith(prefix)) ||
        RANK[a.kind] - RANK[b.kind] ||
        a.label.length - b.label.length ||
        (a.label < b.label ? -1 : 1),
    )
    .slice(0, opts.limit ?? 8);
  return out.length === 0 ? null : { from, to: at, items: out };
}
