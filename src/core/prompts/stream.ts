/**
 * Incremental extraction of a top-level array's items from streamed JSON text,
 * e.g. the candidates of `{"axes": {...}, "candidates": [{...}, {...`. Each
 * complete item is yielded once, as soon as its closing brace arrives, so a
 * spread can show candidates while the rest are still being written.
 *
 * It is a small character scanner (strings, escapes and nesting depth), not a
 * full parser: each item's text is handed to `JSON.parse`, and an item that
 * fails to parse is reported as `undefined` (the caller counts it as dropped).
 */
export class JsonArrayStreamer {
  private text = '';
  private pos = 0;
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** Depth of the target array's contents, once found. */
  private arrayDepth = -1;
  private itemStart = -1;
  private done = false;
  private keyBuffer = '';
  private lastKey = '';
  private stringStart = -1;

  constructor(private readonly key: string) {}

  /** Feeds more text; returns the items completed by it, in order. */
  push(delta: string): unknown[] {
    this.text += delta;
    const out: unknown[] = [];
    for (; this.pos < this.text.length; this.pos++) {
      const c = this.text[this.pos];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === '\\') this.escaped = true;
        else if (c === '"') {
          this.inString = false;
          if (this.depth === 1 && this.arrayDepth < 0)
            this.keyBuffer = this.text.slice(this.stringStart + 1, this.pos);
        }
        continue;
      }
      if (this.done) continue;
      switch (c) {
        case '"':
          this.inString = true;
          this.stringStart = this.pos;
          break;
        case ':':
          if (this.depth === 1) this.lastKey = this.keyBuffer;
          break;
        case '{':
        case '[':
          this.depth++;
          if (c === '[' && this.arrayDepth < 0 && this.depth === 2 && this.lastKey === this.key) {
            this.arrayDepth = 2;
          } else if (
            this.arrayDepth > 0 &&
            this.depth === this.arrayDepth + 1 &&
            this.itemStart < 0
          ) {
            this.itemStart = this.pos;
          }
          break;
        case '}':
        case ']':
          if (this.arrayDepth > 0 && this.depth === this.arrayDepth + 1 && this.itemStart >= 0) {
            const raw = this.text.slice(this.itemStart, this.pos + 1);
            this.itemStart = -1;
            try {
              out.push(JSON.parse(raw));
            } catch {
              out.push(undefined);
            }
          }
          if (this.arrayDepth > 0 && this.depth === this.arrayDepth && c === ']') this.done = true;
          this.depth--;
          break;
        case ',':
          if (this.depth === 1) this.lastKey = '';
          break;
        default:
          break;
      }
    }
    return out;
  }
}
