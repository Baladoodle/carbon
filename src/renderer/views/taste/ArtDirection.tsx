import { useRef, useState, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import { ENTITY_KINDS, type EntityKind } from '@core/model/kinds';
import { schemaOf } from '@core/model/world';
import { flash } from '../../state/ui';
import { dispatch, useWorld } from '../../state/world';
import { Button, IconButton, IconClose, IconPlus, Input, Menu, Textarea } from '../../ui';
import { artOf } from '../../images/model';

/**
 * Taste's Art direction (docs/IMAGES.md §5): the paragraph that goes into
 * every image prompt, and a note per kind. One setting (`settings.art`), so
 * every edit is one undoable command.
 */
export function ArtDirectionSection(): ReactNode {
  const art = useWorld(
    (w) => artOf(w),
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
  );
  const labels = useWorld((w) => {
    const kinds = schemaOf(w).kinds;
    return Object.fromEntries(ENTITY_KINDS.map((k) => [k, kinds[k].label])) as Record<
      EntityKind,
      string
    >;
  });
  // A kind just added, before its note has text (so its input shows and takes focus).
  const [adding, setAdding] = useState<EntityKind | null>(null);
  const picked = useRef<EntityKind | null>(null);
  if (!art || !labels) return null;

  const save = async (p: {
    direction?: string;
    kinds?: Partial<Record<EntityKind, string | null>>;
  }): Promise<void> => {
    const r = await dispatch(cmd('art.set', p));
    if (!r.ok) flash(r.error.message, 'error');
  };
  const setKind = (k: EntityKind, text: string): void => {
    if ((art.kinds[k] ?? '') === text.trim()) return;
    void save({ kinds: { [k]: text.trim() === '' ? null : text.trim() } });
  };
  const shown = ENTITY_KINDS.filter((k) => art.kinds[k] !== undefined || adding === k);
  const rest = ENTITY_KINDS.filter((k) => !shown.includes(k));

  return (
    <section className="taste-col taste-art" aria-label="Art direction" data-testid="taste-art">
      <div className="taste-col-head">
        <span>Art direction</span>
      </div>
      <div className="taste-art-body">
        <Draft
          multiline
          value={art.direction}
          onCommit={(v) => v.trim() !== art.direction && void save({ direction: v.trim() })}
          aria-label="Art direction"
          placeholder="painterly, muted earth tones, soft rim light"
          className="taste-art-direction"
          data-testid="taste-art-direction"
        />
        {shown.map((k) => (
          <div key={k} className="taste-art-kind" data-testid="taste-art-kind" data-kind={k}>
            <span className="taste-art-kind-label t-2">{labels[k]}</span>
            <Draft
              value={art.kinds[k] ?? ''}
              onCommit={(v) => {
                setAdding(null);
                setKind(k, v);
              }}
              aria-label={`${labels[k]} art note`}
              data-testid="taste-art-kind-input"
            />
            <IconButton
              size="sm"
              label={`Remove the ${labels[k].toLowerCase()} note`}
              icon={<IconClose />}
              onClick={() => {
                setAdding(null);
                setKind(k, '');
              }}
            />
          </div>
        ))}
        {rest.length > 0 && (
          <Menu
            trigger={
              <Button
                size="sm"
                variant="ghost"
                className="taste-art-add"
                data-testid="taste-art-add"
              >
                <IconPlus /> Kind
              </Button>
            }
            items={rest.map((k) => ({
              label: labels[k],
              onSelect: () => {
                picked.current = k;
                setAdding(k);
              },
            }))}
            // Focus the new note once the menu has let go of focus (its trap would take it back).
            onClosed={() =>
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLInputElement>(
                    `[data-testid="taste-art-kind"][data-kind="${picked.current ?? ''}"] input`,
                  )
                  ?.focus(),
              )
            }
          />
        )}
      </div>
    </section>
  );
}

/**
 * A text draft that commits when you leave it (`enter` in a one-line note,
 * `ctrl+enter` in the paragraph), and `escape` puts the stored text back.
 */
function Draft({
  value,
  onCommit,
  multiline,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
  multiline?: boolean;
  'aria-label': string;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  'data-testid'?: string;
}): ReactNode {
  const [draft, setDraftState] = useState<string | null>(null);
  // The draft the handlers read (a blur can come before React renders the last keystroke).
  const ref = useRef<string | null>(null);
  const setDraft = (d: string | null): void => {
    ref.current = d;
    setDraftState(d);
  };
  const common = {
    ...rest,
    value: draft ?? value,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
    onBlur: () => {
      const d = ref.current;
      setDraft(null);
      if (d !== null && d !== value) onCommit(d);
    },
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDraft(null);
        ref.current = null;
        e.currentTarget.blur();
      } else if (e.key === 'Enter' && (e.ctrlKey || !multiline)) {
        e.preventDefault();
        e.currentTarget.blur();
      }
    },
  };
  return multiline ? <Textarea {...common} rows={3} /> : <Input {...common} />;
}
