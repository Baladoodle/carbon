import { useMemo, useState, type ReactNode } from 'react';
import type { EntityState } from '@core/model/kinds';
import { useActions, useAllActions } from '../actions';
import { focusEntity, setUi } from '../state/ui';
import { useWorld } from '../state/world';
import { Kbd, StateGlyph } from '../ui';

interface Item {
  id: string;
  group: string;
  label: string;
  keys?: string;
  hint?: string;
  state?: EntityState;
  run: () => void;
}

/**
 * The command palette (ctrl+k): every action and every entity. A stub that
 * package W6 extends (ranking, recents, arguments). Group labels show only when
 * there's more than one group (VISUAL.md §5).
 */
export function Palette(): ReactNode {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const actions = useAllActions();
  const entities = useWorld((w) => Object.values(w.entities));
  const close = (): void => setUi({ overlay: null });
  useActions([
    { id: 'palette.close', label: 'Close the palette', keys: ['escape'], run: close, hidden: true },
  ]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase();
    const fromActions: Item[] = actions
      .filter((a) => !a.hidden && (a.enabled?.() ?? true))
      .map((a) => ({
        id: `action:${a.id}`,
        group: 'Actions',
        label: a.label,
        ...(a.keys?.[0] ? { keys: a.keys[0] } : {}),
        run: a.run,
      }));
    const fromEntities: Item[] = (entities ?? []).map((e) => ({
      id: `entity:${e.id}`,
      group: 'Entities',
      label: e.name,
      hint: e.kind,
      state: e.state,
      run: () => focusEntity(e.id),
    }));
    return [...fromActions, ...fromEntities]
      .filter((i) => q === '' || i.label.toLowerCase().includes(q))
      .slice(0, 60);
  }, [actions, entities, query]);

  const groups = [...new Set(items.map((i) => i.group))];
  const choose = (item: Item | undefined): void => {
    if (!item) return;
    close();
    item.run();
  };

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
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, items.length - 1));
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
            else if (e.key === 'Enter') choose(items[index]);
            else return;
            e.preventDefault();
          }}
        />
        {items.length > 0 && (
          <div className="palette-list" role="listbox">
            {groups.map((g) => (
              <div key={g} role="group" aria-label={g}>
                {groups.length > 1 && <div className="palette-group section-label">{g}</div>}
                {items.map((item, i) =>
                  item.group !== g ? null : (
                    <div
                      key={item.id}
                      role="option"
                      aria-selected={i === index}
                      data-highlighted={i === index ? '' : undefined}
                      className="palette-item"
                      onMouseMove={() => setIndex(i)}
                      onMouseDown={() => choose(item)}
                    >
                      {item.state && <StateGlyph state={item.state} tooltip={false} />}
                      <span className="palette-label">{item.label}</span>
                      {item.hint && <span className="t-3 t-meta">{item.hint}</span>}
                      {item.keys && <Kbd>{item.keys}</Kbd>}
                    </div>
                  ),
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
