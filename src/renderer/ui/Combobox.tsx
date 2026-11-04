import { Popover as P } from 'radix-ui';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { cx } from './cx';

export interface ComboboxItem {
  value: string;
  label: string;
  /** Secondary text on the right (e.g. the kind), in --text-2. */
  hint?: string;
  /** Leading visual (e.g. a StateGlyph). */
  glyph?: ReactNode;
  disabled?: boolean;
}

export interface ComboboxProps {
  items: ComboboxItem[];
  value: string | null;
  onChange: (value: string) => void;
  /** Only when it adds something beyond the label (VISUAL.md §1). */
  placeholder?: string;
  invalid?: boolean;
  /** Custom matching; default: case-insensitive substring of label or value. */
  filter?: (item: ComboboxItem, query: string) => boolean;
  /** Shown when nothing matches. Default: nothing. */
  empty?: ReactNode;
  id?: string;
  className?: string;
  autoFocus?: boolean;
  'aria-label'?: string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
}

const defaultFilter = (item: ComboboxItem, q: string): boolean => {
  const s = q.trim().toLowerCase();
  return s === '' || item.label.toLowerCase().includes(s) || item.value.includes(s);
};

/**
 * A searchable picker (the entity picker for relations and ref fields).
 * Type to filter, ↑/↓ to move, enter to choose, escape to close.
 */
export function Combobox({
  items,
  value,
  onChange,
  placeholder,
  invalid,
  filter = defaultFilter,
  empty,
  id,
  className,
  autoFocus,
  ...aria
}: ComboboxProps): ReactNode {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const selected = items.find((i) => i.value === value);
  const matches = useMemo(
    () => items.filter((i) => filter(i, query)).slice(0, 200),
    [items, query, filter],
  );

  const choose = (item: ComboboxItem | undefined): void => {
    if (!item || item.disabled) return;
    onChange(item.value);
    setOpen(false);
    setQuery('');
  };

  return (
    <P.Root open={open} onOpenChange={setOpen}>
      <P.Anchor asChild>
        <input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && matches[index] ? `${listId}-${index}` : undefined}
          aria-invalid={invalid || aria['aria-invalid'] || undefined}
          {...(aria['aria-label'] ? { 'aria-label': aria['aria-label'] } : {})}
          {...(aria['aria-describedby'] ? { 'aria-describedby': aria['aria-describedby'] } : {})}
          className={cx('ui-input', className)}
          autoFocus={autoFocus}
          placeholder={placeholder}
          value={open ? query : (selected?.label ?? '')}
          onFocus={() => {
            setOpen(true);
            setIndex(0);
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setIndex((i) => Math.min(i + 1, matches.length - 1));
            else if (e.key === 'ArrowUp') setIndex((i) => Math.max(i - 1, 0));
            else if (e.key === 'Enter' && open) choose(matches[index]);
            else if (e.key === 'Escape' && open) setOpen(false);
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      </P.Anchor>
      {/* Rendered only while open, so a closed list never lingers as the top layer and eats escape. */}
      {open && (
        <P.Portal>
          <P.Content
            className="ui-overlay ui-menu ui-combobox"
            align="start"
            sideOffset={4}
            onOpenAutoFocus={(e) => e.preventDefault()}
            onInteractOutside={(e) => {
              if (e.target instanceof HTMLElement && e.target.id === id) e.preventDefault();
            }}
          >
            <ul id={listId} role="listbox" className="ui-combobox-list">
              {matches.map((item, i) => (
                <li
                  key={item.value}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={item.value === value}
                  aria-disabled={item.disabled || undefined}
                  data-highlighted={i === index ? '' : undefined}
                  className="ui-menu-item"
                  onMouseMove={() => setIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(item);
                  }}
                >
                  {item.glyph}
                  <span className="ui-combobox-label">{item.label}</span>
                  {item.hint && <span className="t-2 t-meta">{item.hint}</span>}
                </li>
              ))}
              {matches.length === 0 && empty !== undefined && (
                <li className="ui-combobox-empty t-2">{empty}</li>
              )}
            </ul>
          </P.Content>
        </P.Portal>
      )}
    </P.Root>
  );
}
