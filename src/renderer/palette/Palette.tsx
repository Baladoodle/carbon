import { useMemo, useState, type ReactNode } from 'react';
import { useActions, useAllActions } from '../actions';
import { focusEntity, setUi } from '../state/ui';
import { useWorld } from '../state/world';

interface Item {
  id: string;
  label: string;
  hint: string;
  run: () => void;
}

/**
 * The command palette (ctrl+k). A stub over every registered action and every
 * entity; package W6 owns and extends it (ranking, recent, arguments).
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
        label: a.label,
        hint: a.keys?.[0] ?? a.group ?? '',
        run: a.run,
      }));
    const fromEntities: Item[] = (entities ?? []).map((e) => ({
      id: `entity:${e.id}`,
      label: e.name,
      hint: e.kind,
      run: () => focusEntity(e.id),
    }));
    return [...fromActions, ...fromEntities]
      .filter((i) => q === '' || i.label.toLowerCase().includes(q))
      .slice(0, 50);
  }, [actions, entities, query]);

  const choose = (item: Item | undefined): void => {
    if (!item) return;
    close();
    item.run();
  };

  return (
    <div className="overlay" onMouseDown={close} data-testid="palette">
      <div className="overlay-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="palette-input"
          placeholder="Search actions and entities…"
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
        <ul className="palette-list" role="listbox">
          {items.map((item, i) => (
            <li
              key={item.id}
              role="option"
              aria-selected={i === index}
              className={i === index ? 'active' : undefined}
              onMouseDown={() => choose(item)}
            >
              <span>{item.label}</span>
              <span className="dim mono small">{item.hint}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
