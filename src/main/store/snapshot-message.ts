import { ENTITY_KINDS } from '@core/model/kinds';
import type { World } from '@core/model/world';

/**
 * The commit message for a git snapshot of the world directory, generated from
 * what changed (pure; `git status --porcelain -z` in, message out).
 *
 * ```
 * Add Glass Lung; edit Cloud Anklet, Low Sky; remove Old Lamp
 *
 * added    item Glass Lung
 * edited   item Cloud Anklet
 * edited   band Low Sky
 * removed  item Old Lamp
 * edited   numbers/formulas.carbon
 *
 * carbon snapshot (idle)
 * ```
 */
export interface StatusEntry {
  /** Two-letter porcelain status, e.g. ` M`, `??`, `D `, `R `. */
  xy: string;
  path: string;
  /** For renames and copies: the old path. */
  from?: string;
}

/** Parses `git status --porcelain=v1 -z` output. */
export function parsePorcelain(out: string): StatusEntry[] {
  const parts = out.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? '';
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    const entry: StatusEntry = { xy, path: p.slice(3) };
    if (xy.includes('R') || xy.includes('C')) {
      const from = parts[i + 1];
      if (from !== undefined) entry.from = from;
      i++;
    }
    entries.push(entry);
  }
  return entries;
}

type Change = 'added' | 'edited' | 'removed' | 'renamed';

const changeOf = (xy: string): Change =>
  xy === '??' || xy.includes('A')
    ? 'added'
    : xy.includes('D')
      ? 'removed'
      : xy.includes('R')
        ? 'renamed'
        : 'edited';

const ENTITY_PATH = /^entities\/([a-z]+)\/([^/]+)\.md$/;

interface Line {
  change: Change;
  label: string;
  /** The entity's name, when the file is an entity. */
  name?: string;
}

function describe(e: StatusEntry, world: World | null, names: ReadonlyMap<string, string>): Line {
  const change = changeOf(e.xy);
  const m = ENTITY_PATH.exec(e.path);
  if (m && (ENTITY_KINDS as readonly string[]).includes(m[1] ?? '')) {
    const id = m[2] ?? '';
    const name = world?.entities[id]?.name ?? names.get(e.path) ?? id;
    return { change, label: `${m[1] ?? ''} ${name}`, name };
  }
  return { change, label: e.from ? `${e.from} → ${e.path}` : e.path };
}

const VERB: Record<Change, string> = {
  added: 'add',
  edited: 'edit',
  removed: 'remove',
  renamed: 'rename',
};

function listNames(names: string[], room: number): string {
  const out: string[] = [];
  let used = 0;
  for (let i = 0; i < names.length; i++) {
    const n = names[i] ?? '';
    const rest = names.length - i - 1;
    const tail = rest > 0 ? ` and ${rest} more` : '';
    if (out.length > 0 && used + n.length + 2 + tail.length > room) {
      return `${out.join(', ')} and ${names.length - out.length} more`;
    }
    out.push(n);
    used += n.length + 2;
  }
  return out.join(', ');
}

/** The subject (≤ 72 characters where it can be) and body of a snapshot commit. */
export function snapshotMessage(
  entries: readonly StatusEntry[],
  world: World | null,
  reason: 'idle' | 'quit' | 'manual',
  /** Names of entities that are gone from the world, by path (read from the last commit). */
  names: ReadonlyMap<string, string> = new Map(),
): string {
  const lines = entries
    .map((e) => describe(e, world, names))
    .sort((a, b) => a.change.localeCompare(b.change) || a.label.localeCompare(b.label));
  const groups: string[] = [];
  const order: Change[] = ['added', 'edited', 'renamed', 'removed'];
  const named = lines.filter((l) => l.name !== undefined);
  const others = lines.filter((l) => l.name === undefined);
  const budget = Math.max(
    16,
    Math.floor(60 / Math.max(1, new Set(named.map((l) => l.change)).size)),
  );
  for (const c of order) {
    const names = named.filter((l) => l.change === c).map((l) => l.name ?? '');
    if (names.length > 0) groups.push(`${VERB[c]} ${listNames(names, budget)}`);
  }
  if (others.length > 0) {
    const what = [...new Set(others.map((l) => l.label.split('/')[0] ?? l.label))].map((s) =>
      s.replace(/\.json$|\.carbon$/, ''),
    );
    groups.push(`${named.length > 0 ? 'and ' : 'update '}${what.join(', ')}`);
  }
  let subject = groups.join('; ').replace(/; and /, ' and ');
  subject = subject.charAt(0).toUpperCase() + subject.slice(1);
  if (subject === '') subject = 'Snapshot';
  const body = lines.map((l) => `${l.change.padEnd(8)} ${l.label}`).join('\n');
  return `${subject}\n\n${body}\n\ncarbon snapshot (${reason})\n`;
}
