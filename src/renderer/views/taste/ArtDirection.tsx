import { useRef, useState, type ReactNode } from 'react';
import { cmd } from '@core/commands/registry';
import { ENTITY_KINDS, type EntityKind } from '@core/model/kinds';
import { schemaOf } from '@core/model/world';
import { flash } from '../../state/ui';
import { currentWorld, dispatch, useWorld } from '../../state/world';
import { Button, IconButton, IconClose, IconPlus, Input, Menu, Textarea } from '../../ui';
import { artOf, type ArtDirection } from '../../images/model';

/**
 * Taste's Art direction (docs/IMAGES.md §5): the paragraph that goes into
 * every image prompt, and a note per kind. One setting (`settings.art`), so
 * every edit is one undoable command.
 */
export function ArtDirectionSection(): ReactNode {
  const art = useWorld((w) => artOf(w), (a, b) => JSON.stringify(a) === JSON.stringify(b));
  const labels = useWorld((w) => {
    const kinds = schemaOf(w).kinds;
    return Object.fromEntries(ENTITY_KINDS.map((k) => [k, kinds[k].label])) as Record<
      EntityKind,
      string
    >;
  });
  // A kind just added, before its note has text (so its input shows and takes focus).
  const [adding, setAdding] = useState<EntityKind | null>(null);
  if (!art || !labels) return null;

  const save = async (next: ArtDirection): Promise<void> => {
    const w = currentWorld();
    const before = w ? artOf(w) : undefined;
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    const r = await dispatch(cmd('settings.set', { key: 'art', value: next }));
    if (!r.ok) flash(r.error.message, 'error');
  };
  const setKind = (k: EntityKind, text: string): void => {
    const kinds = { ...art.kinds };
    if (text.trim() === '') delete kinds[k];
    else kinds[k] = text.trim();
    void save({ ...art, kinds });
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
          value={art.direction}
          onCommit={(v) => void save({ ...art, direction: v.trim() })}
          render={(p) => (
            <Textarea
              {...p}
              aria-label="Art direction"
              placeholder="painterly, muted earth tones, soft rim light"
              rows={3}
              className="taste-art-direction"
              data-testid="taste-art-direction"
            />
          )}
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
              render={(p) => (
                <Input
                  {...p}
                  aria-label={`${labels[k]} art note`}
                  autoFocus={adding === k}
                  data-testid="taste-art-kind-input"
                />
              )}
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
              <Button size="sm" variant="ghost" className="taste-art-add" data-testid="taste-art-add">
                <IconPlus /> Kind
              </Button>
            }
            items={rest.map((k) => ({ label: labels[k], onSelect: () => setAdding(k) }))}
            onClosed={() => undefined}
          />
        )}
      </div>
    </section>
  );
}

interface DraftProps {
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}

/** A text draft that commits when you leave it (or `ctrl+enter`), and `escape` puts back. */
function Draft({
  value,
  onCommit,
  render,
}: {
  value: string;
  onCommit: (v: string) => void;
  render: (p: DraftProps) => ReactNode;
}): ReactNode {
  const [draft, setDraftState] = useState<string | null>(null);
  // The draft the handlers read (a blur can come before React renders the last keystroke).
  const ref = useRef<string | null>(null);
  const setDraft = (d: string | null): void => {
    ref.current = d;
    setDraftState(d);
  };
  return render({
    value: draft ?? value,
    onChange: (e) => setDraft(e.target.value),
    onBlur: () => {
      const d = ref.current;
      setDraft(null);
      if (d !== null && d !== value) onCommit(d);
    },
    onKeyDown: (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDraft(null);
        (e.currentTarget as HTMLElement).blur();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.currentTarget.tagName === 'INPUT')) {
        e.preventDefault();
        (e.currentTarget as HTMLElement).blur();
      }
    },
  });
}
