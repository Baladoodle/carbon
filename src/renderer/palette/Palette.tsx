import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ENTITY_KINDS, type EntityKind, type EntityState } from '@core/model/kinds';
import { schemaOf } from '@core/model/world';
import { useActions, useAllActions } from '../actions';
import { focusEntity, setUi } from '../state/ui';
import { useWorld } from '../state/world';
import { Kbd, StateGlyph } from '../ui';
import { rank, type Match } from './fuzzy';
import './palette.css';

/**
 * The command palette (ctrl+k): every action and every entity, ranked by fuzzy
 * match (fuzzy.ts), recent use breaking ties. Results are grouped by type:
 * actions, then one group per entity kind, groups ordered by their best match.
 * A group's label shows only when there's more than one group (VISUAL.md §5).
 *
 * Keys: ↑/↓ (or ctrl+p/ctrl+n), page up/down, tab/shift+tab between groups,
 * ctrl+home/end, enter to run, escape (or ctrl+k) to close.
 */
interface Item {
  id: string;
  /** The group: `actions` or an entity kind. */
  type: 'actions' | EntityKind;
  label: string;
  terms: string[];
  keys?: string;
  state?: EntityState;
  run: () => void;
}

const RECENT_KEY = 'carbon.palette.recent';
const RECENT_MAX = 30;
const LIMIT = 60;
const EMPTY_ENTITIES = 8;

function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function pushRecent(id: string): void {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // storage unavailable: no recents
  }
}

interface Row {
  item: Item;
  match: Match;
}

interface Group {
  type: Item['type'];
  label: string;
  rows: Row[];
}

function Highlight({ text, positions }: { text: string; positions: number[] }): ReactNode {
  if (positions.length === 0) return text;
  const set = new Set(positions);
  const parts: ReactNode[] = [];
  let run = '';
  let hit = false;
  const flush = (i: number): void => {
    if (!run) return;
    parts.push(
      hit ? (
        <mark key={i} className="palette-hit">
          {run}
        </mark>
      ) : (
        run
      ),
    );
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const h = set.has(i);
    if (h !== hit) {
      flush(i);
      hit = h;
    }
    run += text[i] ?? '';
  }
  flush(text.length);
  return parts;
}

export function Palette(): ReactNode {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const actions = useAllActions();
  const entities = useWorld((w) => Object.values(w.entities));
  const kindLabels = useWorld((w) =>
    Object.fromEntries(ENTITY_KINDS.map((k) => [k, schemaOf(w).kinds[k].plural])),
  );
  const close = (): void => setUi({ overlay: null });
  useActions([
    { id: 'palette.close', label: 'Close the palette', keys: ['escape'], run: close, hidden: true },
  ]);

  const items = useMemo<Item[]>(() => {
    const fromActions: Item[] = actions
      .filter((a) => !a.hidden && a.id !== 'palette.open' && (a.enabled?.() ?? true))
      .map((a) => ({
        id: `action:${a.id}`,
        type: 'actions' as const,
        label: a.label,
        terms: [a.group ?? '', 'action'].filter(Boolean),
        ...(a.keys?.[0] ? { keys: a.keys[0] } : {}),
        run: a.run,
      }));
    const fromEntities: Item[] = (entities ?? []).map((e) => ({
      id: `entity:${e.id}`,
      type: e.kind,
      label: e.name,
      terms: [e.kind, e.state, e.id],
      state: e.state,
      run: () => focusEntity(e.id),
    }));
    return [...fromActions, ...fromEntities];
  }, [actions, entities]);

  const groups = useMemo<Group[]>(() => {
    const recent = readRecent();
    const boost = (i: Item): number => {
      const r = recent.indexOf(i.id);
      const recency = r < 0 ? 0 : (RECENT_MAX - r) * 2;
      // The graveyard sinks below the living.
      return recency - (i.state === 'graveyard' ? 20 : 0);
    };
    const q = query.trim();
    let rows: Row[];
    if (q === '') {
      const acts = items.filter((i) => i.type === 'actions');
      const ents = items
        .filter((i) => i.type !== 'actions' && recent.includes(i.id))
        .slice(0, EMPTY_ENTITIES);
      rows = [...acts, ...ents]
        .map((item) => ({ item, match: { score: boost(item), positions: [] } }))
        .sort((a, b) => b.match.score - a.match.score || a.item.label.localeCompare(b.item.label));
    } else rows = rank(q, items, boost).slice(0, LIMIT);
    const by = new Map<Item['type'], Row[]>();
    for (const r of rows) by.set(r.item.type, [...(by.get(r.item.type) ?? []), r]);
    const out = [...by].map(([type, rs]) => ({
      type,
      label: type === 'actions' ? 'Actions' : (kindLabels?.[type] ?? type),
      rows: rs,
    }));
    if (q === '')
      return out.sort(
        (a, b) =>
          (a.type === 'actions' ? -1 : 0) - (b.type === 'actions' ? -1 : 0) ||
          ENTITY_KINDS.indexOf(a.type as EntityKind) - ENTITY_KINDS.indexOf(b.type as EntityKind),
      );
    return out.sort((a, b) => (b.rows[0]?.match.score ?? 0) - (a.rows[0]?.match.score ?? 0));
  }, [items, query, kindLabels]);

  const flat = groups.flatMap((g) => g.rows);
  const current = Math.min(index, Math.max(0, flat.length - 1));
  const starts: number[] = [];
  groups.reduce((at, g) => {
    starts.push(at);
    return at + g.rows.length;
  }, 0);

  useEffect(() => {
    listRef.current?.querySelector('[data-highlighted]')?.scrollIntoView({ block: 'nearest' });
  }, [current, query]);

  const choose = (row: Row | undefined): void => {
    if (!row) return;
    pushRecent(row.item.id);
    close();
    row.item.run();
  };

  const move = (to: number): void => setIndex(Math.max(0, Math.min(flat.length - 1, to)));
  const groupStep = (dir: 1 | -1): void => {
    const g = starts.findLastIndex((s) => s <= current);
    const next = starts[(g + dir + starts.length) % Math.max(1, starts.length)];
    if (next !== undefined) setIndex(next);
  };

  const showLabels = groups.length > 1;
  let n = -1;
  return (
    <div className="palette-scrim" onMouseDown={close}>
      <div
        className="ui-overlay palette"
        data-testid="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="palette-input"
          aria-label="Search actions and entities"
          role="combobox"
          aria-expanded={flat.length > 0}
          aria-controls="palette-list"
          aria-activedescendant={flat[current] ? `palette-opt-${current}` : undefined}
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            const k = e.key;
            if (k === 'ArrowDown' || (e.ctrlKey && (k === 'n' || k === 'j'))) move(current + 1);
            else if (k === 'ArrowUp' || (e.ctrlKey && k === 'p')) move(current - 1);
            else if (k === 'PageDown') move(current + 8);
            else if (k === 'PageUp') move(current - 8);
            else if (e.ctrlKey && k === 'Home') move(0);
            else if (e.ctrlKey && k === 'End') move(flat.length - 1);
            else if (k === 'Tab') groupStep(e.shiftKey ? -1 : 1);
            else if (k === 'Enter') choose(flat[current]);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        {flat.length > 0 && (
          <div className="palette-list" role="listbox" id="palette-list" ref={listRef}>
            {groups.map((g) => (
              <div key={g.type} role="group" aria-label={g.label}>
                {showLabels && <div className="palette-group">{g.label}</div>}
                {g.rows.map((row) => {
                  n++;
                  const i = n;
                  const { item } = row;
                  return (
                    <div
                      key={item.id}
                      id={`palette-opt-${i}`}
                      role="option"
                      aria-selected={i === current}
                      data-highlighted={i === current ? '' : undefined}
                      data-item={item.id}
                      className={item.state === 'graveyard' ? 'palette-item t-3' : 'palette-item'}
                      onMouseMove={() => i !== current && setIndex(i)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        choose(row);
                      }}
                    >
                      {item.state && <StateGlyph state={item.state} tooltip={false} />}
                      <span className="palette-label">
                        <Highlight text={item.label} positions={row.match.positions} />
                      </span>
                      {item.keys && <Kbd>{item.keys}</Kbd>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
