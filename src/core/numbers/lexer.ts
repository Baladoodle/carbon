import { diag, type Diagnostic, type Span } from './span';

/**
 * The lexer. Newlines end definitions, except inside brackets, where they are
 * whitespace (so a long formula can wrap inside its parentheses). `#` starts a
 * comment that runs to the end of the line.
 */
export type TokenType =
  'number' | 'string' | 'ident' | 'keyword' | 'op' | 'newline' | 'comment' | 'eof';

export interface Token {
  type: TokenType;
  /** The source text (for strings: the decoded value is in `value`). */
  text: string;
  span: Span;
  /** Numbers: the parsed value. */
  num?: number;
  /** Strings: the decoded value. */
  value?: string;
}

export const KEYWORDS = new Set(['and', 'or', 'not', 'where', 'true', 'false', 'none']);

/** Two-character operators first, so `==` never lexes as `=` `=`. */
const OPS2 = ['==', '!=', '<=', '>='];
const OPS1 = new Set([
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '<',
  '>',
  '=',
  '(',
  ')',
  '[',
  ']',
  ',',
  '.',
  ':',
]);

const isDigit = (c: string): boolean => c >= '0' && c <= '9';
const isIdentStart = (c: string): boolean =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdent = (c: string): boolean => isIdentStart(c) || isDigit(c);

/** Whether a token (or whitespace) can start at this character. */
const startsToken = (c: string): boolean =>
  isIdent(c) ||
  OPS1.has(c) ||
  c === '"' ||
  c === '#' ||
  c === ' ' ||
  c === '\t' ||
  c === '\r' ||
  c === '\n';

const NAME_HINT = 'Names use the letters a–z and A–Z, digits and _';

const CHAR_HINTS: Record<string, string> = {
  '&': 'Use and',
  '|': 'Use or',
  '!': 'Use not, or != to compare',
  "'": 'Strings use double quotes',
  '{': 'Group with ( and )',
  '}': 'Group with ( and )',
};

export interface LexResult {
  tokens: Token[];
  diagnostics: Diagnostic[];
}

/** Tokenises a source. Never throws; problems become diagnostics. Comments are kept as tokens. */
export function lex(source: string): LexResult {
  const tokens: Token[] = [];
  const diagnostics: Diagnostic[] = [];
  let depth = 0;
  let i = 0;
  const push = (type: TokenType, start: number, end: number, extra: Partial<Token> = {}): void => {
    tokens.push({ type, text: source.slice(start, end), span: { start, end }, ...extra });
  };
  while (i < source.length) {
    const c = source.charAt(i);
    if (c === '\n') {
      // Inside brackets, an indented next line (or one starting with a closing
      // bracket) continues the formula. Anything else starts a new line, so
      // one unclosed parenthesis can't swallow the rest of the file.
      const next = source.charAt(i + 1);
      const continues =
        depth > 0 && (next === ' ' || next === '\t' || next === ')' || next === ']');
      if (!continues) {
        depth = 0;
        push('newline', i, i + 1);
      }
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      const start = i;
      while (i < source.length && source.charAt(i) !== '\n') i++;
      push('comment', start, i);
      continue;
    }
    if (isDigit(c) || (c === '.' && isDigit(source.charAt(i + 1)))) {
      const start = i;
      const digits = (): void => {
        while (i < source.length && (isDigit(source.charAt(i)) || source.charAt(i) === '_')) i++;
      };
      digits();
      if (source.charAt(i) === '.' && isDigit(source.charAt(i + 1))) {
        i++;
        digits();
      }
      const e = source.charAt(i);
      if (e === 'e' || e === 'E') {
        const sign = source.charAt(i + 1);
        const at = sign === '+' || sign === '-' ? i + 2 : i + 1;
        if (isDigit(source.charAt(at))) {
          i = at;
          digits();
        }
      }
      const text = source.slice(start, i);
      const clean = text.replace(/_/g, '');
      const bad = /_$|_\.|\._|__|_[eE]/.test(text);
      const num = Number(clean);
      if (bad || !Number.isFinite(num)) {
        diagnostics.push(
          diag(
            'parse',
            'lex.number',
            `"${text}" is not a number`,
            { start, end: i },
            {
              hint: bad ? 'Use _ only between digits, like 1_000' : 'Use a smaller number',
            },
          ),
        );
        push('number', start, i, { num: 0 });
      } else push('number', start, i, { num });
      if (isIdentStart(source.charAt(i))) {
        const s2 = i;
        while (i < source.length && isIdent(source.charAt(i))) i++;
        diagnostics.push(
          diag(
            'parse',
            'lex.number_suffix',
            `"${source.slice(start, i)}" is not a number or a name`,
            { start, end: i },
            {
              hint: `Write ${source.slice(start, s2)} * ${source.slice(s2, i)} to multiply, or start the name with a letter`,
            },
          ),
        );
      }
      continue;
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < source.length && isIdent(source.charAt(i))) i++;
      const text = source.slice(start, i);
      push(KEYWORDS.has(text) ? 'keyword' : 'ident', start, i);
      continue;
    }
    if (c === '"') {
      const start = i;
      i++;
      let value = '';
      let closed = false;
      while (i < source.length) {
        const d = source.charAt(i);
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\n') break;
        if (d === '\\') {
          const n = source.charAt(i + 1);
          // A backslash at the end of the line or source can't escape anything.
          if (n === '' || n === '\n') {
            i++;
            break;
          }
          const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
          const m = map[n];
          if (m === undefined) {
            // The escaped character, whole (an astral one is two UTF-16 units).
            const width = (source.codePointAt(i + 1) ?? 0) > 0xffff ? 2 : 1;
            const ch = source.slice(i + 1, i + 1 + width);
            diagnostics.push(
              diag(
                'parse',
                'lex.escape',
                `"\\${ch}" is not an escape`,
                { start: i, end: i + 1 + width },
                {
                  hint: 'Escapes are \\" \\\\ \\n and \\t',
                },
              ),
            );
            value += ch;
            i += 1 + width;
            continue;
          }
          value += m;
          i += 2;
          continue;
        }
        value += d;
        i++;
      }
      if (!closed)
        diagnostics.push(
          diag(
            'parse',
            'lex.unterminated',
            'This string never ends',
            { start, end: i },
            {
              hint: 'Close it with "',
            },
          ),
        );
      push('string', start, i, { value });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (OPS2.includes(two)) {
      push('op', i, i + 2);
      i += 2;
      continue;
    }
    if (OPS1.has(c)) {
      if (c === '(' || c === '[') depth++;
      if ((c === ')' || c === ']') && depth > 0) depth--;
      push('op', i, i + 1);
      i++;
      continue;
    }
    // Anything else isn't part of the language. A run of such characters is
    // one error, and its span covers whole characters (never half of an
    // astral one), so the editor can underline it.
    const start = i;
    while (i < source.length && !startsToken(source.charAt(i)))
      i += (source.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
    const text = source.slice(start, i);
    diagnostics.push(
      diag(
        'parse',
        'lex.char',
        `"${text}" isn't part of the language`,
        { start, end: i },
        { hint: CHAR_HINTS[c] ?? (/^\p{L}/u.test(text) ? NAME_HINT : undefined) },
      ),
    );
  }
  push('eof', source.length, source.length);
  return { tokens, diagnostics };
}
