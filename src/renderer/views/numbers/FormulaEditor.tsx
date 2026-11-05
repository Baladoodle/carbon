import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import {
  completions,
  formatValue,
  lineCol,
  lineStarts,
  type Completions,
  type Diagnostic,
  type NumbersAnalysis,
} from '@core/numbers';
import { schemaOf } from '@core/model/world';
import { lex, type Token } from '@core/numbers/lexer';
import type { World } from '@core/model/world';
import { useActions } from '../../actions';
import { dispatch } from '../../state/world';
import { flash } from '../../state/ui';
import { cx } from '../../ui';
import { numbersUi } from './analysis';

const COMMIT_MS = 600;

type Cls = 'kw' | 'num' | 'str' | 'op' | 'cmt' | 'def' | 'id';

/** Splits the source into highlighted runs (whitespace stays plain text). */
function runs(source: string): { text: string; cls?: Cls }[] {
  const { tokens } = lex(source);
  const out: { text: string; cls?: Cls }[] = [];
  let at = 0;
  let lineStart = true;
  const push = (t: Token, cls: Cls): void => {
    if (t.span.start > at) out.push({ text: source.slice(at, t.span.start) });
    out.push({ text: source.slice(t.span.start, t.span.end), cls });
    at = t.span.end;
  };
  for (const t of tokens) {
    if (t.type === 'eof') break;
    if (t.type === 'newline') {
      lineStart = true;
      continue;
    }
    const cls: Cls =
      t.type === 'keyword'
        ? t.text === 'true' || t.text === 'false' || t.text === 'none'
          ? 'num'
          : 'kw'
        : t.type === 'number'
          ? 'num'
          : t.type === 'string'
            ? 'str'
            : t.type === 'comment'
              ? 'cmt'
              : t.type === 'op'
                ? 'op'
                : lineStart
                  ? 'def'
                  : 'id';
    push(t, cls);
    if (t.type !== 'comment') lineStart = false;
  }
  if (at < source.length) out.push({ text: source.slice(at) });
  return out;
}

/** The source with each diagnostic's span marked (zero-width spans widen to one character). */
function marks(source: string, ds: Diagnostic[]): ReactNode[] {
  const spans = ds
    .map((d) => {
      let { start, end } = d.span;
      if (end <= start) {
        if (start > 0 && (start >= source.length || source.charAt(start) === '\n')) start -= 1;
        end = start + 1;
      }
      return { start, end, severity: d.severity };
    })
    .sort((a, b) => a.start - b.start);
  const out: ReactNode[] = [];
  let at = 0;
  spans.forEach((s, i) => {
    const start = Math.max(s.start, at);
    if (start >= s.end) return;
    if (start > at) out.push(source.slice(at, start));
    out.push(
      <mark key={i} className={cx('numbers-mark', s.severity === 'warning' && 'numbers-mark-warn')}>
        {source.slice(start, s.end)}
      </mark>,
    );
    at = s.end;
  });
  out.push(source.slice(at));
  return out;
}

interface LineInfo {
  text: string;
  tone: 'value' | 'type' | 'error' | 'warn' | 'muted';
  title?: string;
}

/** What the gutter shows on each line: a value, a signature, or a problem. */
function lineInfo(analysis: NumbersAnalysis, world: World, source: string): Map<number, LineInfo> {
  const out = new Map<number, LineInfo>();
  const name = (id: string): string | undefined => world.entities[id]?.name;
  for (const d of analysis.defs) {
    const line = lineCol(source, d.span.start).line;
    if (d.kind === 'func') out.set(line, { text: d.type, tone: 'type' });
    else if (d.result?.ok)
      out.set(line, {
        text: formatValue(d.result.value, { name, maxItems: 3 }),
        tone: 'value',
        title: d.type,
      });
    else if (d.result?.error.code === 'eval.dependency')
      out.set(line, { text: d.result.error.message, tone: 'muted' });
  }
  for (const d of [...analysis.diagnostics].reverse()) {
    const line = lineCol(source, d.span.start).line;
    const cur = out.get(line);
    if (cur && (cur.tone === 'error' || (cur.tone === 'warn' && d.severity === 'warning')))
      continue;
    out.set(line, { text: d.message, tone: d.severity === 'error' ? 'error' : 'warn' });
  }
  return out;
}

/** Where a character offset of a textarea is on screen (monospace, fixed line height). */
function caretPoint(el: HTMLTextAreaElement, offset: number): { left: number; top: number } {
  const { line, col } = lineCol(el.value, offset);
  const style = getComputedStyle(el);
  const lineHeight = parseFloat(style.lineHeight) || 20;
  const ctx = document.createElement('canvas').getContext('2d');
  let ch = 7.8;
  if (ctx) {
    ctx.font = `${style.fontSize} ${style.fontFamily}`;
    ch = ctx.measureText('0000000000').width / 10 || ch;
  }
  const rect = el.getBoundingClientRect();
  return {
    left: rect.left + parseFloat(style.paddingLeft) + (col - 1) * ch,
    top: rect.top + parseFloat(style.paddingTop) + line * lineHeight,
  };
}

type Suggest = Completions & { index: number; left: number; top: number };

export interface FormulaEditorProps {
  world: World;
  analysis: NumbersAnalysis;
  /** The world's committed source. */
  committed: string;
}

export function FormulaEditor({ world, analysis, committed }: FormulaEditorProps): ReactNode {
  const [text, setText] = useState(committed);
  const [caretLine, setCaretLine] = useState<number | null>(null);
  const [suggest, setSuggest] = useState<Suggest | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = text !== committed;

  // Follow the world (undo, external edits) unless there is typing here that
  // hasn't been committed yet.
  const [seen, setSeen] = useState(committed);
  if (seen !== committed) {
    setSeen(committed);
    if (text === seen) setText(committed);
  }
  const pending = useRef(false);

  const commit = useCallback(
    async (source: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      pending.current = false;
      if (source === committed) {
        numbersUi.set({ draft: null });
        return;
      }
      const r = await dispatch(cmd('numbers.setFormulas', { source }));
      if (!r.ok) flash(r.error.message, 'error');
      numbersUi.set({ draft: null });
    },
    [committed],
  );

  /** Opens (or updates) the completion list at the caret; closes it when there's nothing to offer. */
  const complete = (source: string, explicit = false): void => {
    const el = ref.current;
    if (!el) return;
    const at = el.selectionStart;
    if (at !== el.selectionEnd) return setSuggest(null);
    const c = completions(analysis, source, at, {
      schema: schemaOf(world),
      variables: world.numbers.variables,
      explicit,
    });
    if (!c) return setSuggest(null);
    setSuggest({ ...c, index: 0, ...caretPoint(el, c.from) });
  };

  const accept = (s: Suggest, i = s.index): void => {
    const el = ref.current;
    const item = s.items[i];
    if (!el || !item) return;
    el.setRangeText(item.insert, s.from, s.to, 'end');
    setSuggest(null);
    change(el.value);
  };

  const change = (source: string): void => {
    setText(source);
    pending.current = true;
    numbersUi.set({ draft: source });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void commit(source), COMMIT_MS);
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const revert = (): void => {
    if (timer.current) clearTimeout(timer.current);
    pending.current = false;
    setText(committed);
    numbersUi.set({ draft: null });
  };

  useActions([
    {
      id: 'numbers.editFormulas',
      label: 'Edit formulas',
      group: 'Numbers',
      keys: ['e'],
      run: () => ref.current?.focus(),
    },
    {
      id: 'numbers.complete',
      label: 'Complete the name',
      group: 'Numbers',
      keys: ['ctrl+space'],
      inInputs: true,
      enabled: () => document.activeElement === ref.current,
      run: () => complete(ref.current?.value ?? text, true),
    },
    {
      // While typing, the first undo drops what hasn't been committed yet.
      id: 'numbers.revertDraft',
      label: 'Undo typing',
      keys: ['ctrl+z'],
      hidden: true,
      enabled: () => dirty && document.activeElement === ref.current,
      run: revert,
    },
  ]);

  const caret = (): void => {
    const el = ref.current;
    if (el) setCaretLine(lineCol(el.value, el.selectionStart).line);
  };

  const source = text;
  const lines = useMemo(() => lineStarts(source).length, [source]);
  const width = useMemo(
    () => Math.max(...source.split('\n').map((l) => l.length), 24) + 4,
    [source],
  );
  const info = useMemo(() => lineInfo(analysis, world, source), [analysis, world, source]);
  const highlighted = useMemo(() => runs(source), [source]);
  const problem =
    caretLine === null
      ? undefined
      : analysis.diagnostics.find((d) => lineCol(source, d.span.start).line === caretLine);

  return (
    <div
      className="numbers-editor"
      data-testid="numbers-editor"
      data-dirty={dirty ? '' : undefined}
    >
      <div className="numbers-editor-body">
        <div
          className="numbers-code"
          style={{ height: `calc(${lines} * var(--numbers-line) + 16px)` }}
        >
          <div
            className="numbers-code-inner"
            style={{ width: `max(100%, calc(${width}ch + 24px))` }}
          >
            <pre className="numbers-layer" aria-hidden="true">
              {highlighted.map((r, i) =>
                r.cls ? (
                  <span key={i} className={`hl-${r.cls}`}>
                    {r.text}
                  </span>
                ) : (
                  r.text
                ),
              )}
              {'\n'}
            </pre>
            <pre
              className="numbers-layer numbers-layer-marks"
              aria-hidden="true"
              data-testid="numbers-marks"
            >
              {marks(source, analysis.diagnostics)}
              {'\n'}
            </pre>
            <textarea
              ref={ref}
              className="numbers-input"
              data-testid="numbers-source"
              aria-label="Formulas"
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              wrap="off"
              value={text}
              placeholder="taken(raw, def) = raw * k / (k + def)"
              onChange={(e) => {
                const v = e.target.value;
                change(v);
                const kind = (e.nativeEvent as Partial<InputEvent>).inputType ?? '';
                if (kind === 'insertText' || (kind.startsWith('delete') && suggest)) complete(v);
                else setSuggest(null);
              }}
              onBlur={() => {
                setCaretLine(null);
                setSuggest(null);
                if (pending.current) void commit(text);
              }}
              onKeyUp={caret}
              onClick={() => {
                caret();
                setSuggest(null);
              }}
              onSelect={caret}
              onKeyDown={(e) => {
                if (suggest) {
                  const n = suggest.items.length;
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    const d = e.key === 'ArrowDown' ? 1 : -1;
                    setSuggest({ ...suggest, index: (suggest.index + d + n) % n });
                    return;
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault();
                    e.stopPropagation();
                    accept(suggest);
                    return;
                  }
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setSuggest(null);
                    return;
                  }
                  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') setSuggest(null);
                }
                if (e.key === 'Escape') {
                  e.currentTarget.blur();
                  e.stopPropagation();
                }
              }}
            />
          </div>
        </div>
        <ol className="numbers-gutter" aria-label="Values" data-testid="numbers-values">
          {Array.from({ length: lines }, (_, i) => {
            const li = info.get(i + 1);
            return (
              <li key={i} className={li ? `gutter-${li.tone}` : undefined} title={li?.title}>
                {li?.text ?? ''}
              </li>
            );
          })}
        </ol>
      </div>
      {suggest && (
        <ul
          className="ui-menu numbers-complete"
          role="listbox"
          aria-label="Names"
          data-testid="numbers-complete"
          style={{ left: suggest.left, top: suggest.top }}
        >
          {suggest.items.map((c, i) => (
            <li
              key={c.label}
              role="option"
              aria-selected={i === suggest.index}
              data-highlighted={i === suggest.index ? '' : undefined}
              className="ui-menu-item"
              onMouseDown={(e) => {
                e.preventDefault();
                accept(suggest, i);
              }}
            >
              <span className="mono">{c.label}</span>
              {c.detail && <span className="mono t-3 numbers-complete-detail">{c.detail}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="numbers-problem" role="status" data-testid="numbers-problem">
        {problem && (
          <>
            <span className={problem.severity === 'error' ? 't-danger' : 't-warn'}>
              {problem.message}
            </span>
            {problem.hint && <span className="t-2">{problem.hint}</span>}
          </>
        )}
      </div>
    </div>
  );
}
