import type { Axis, Candidate } from '@core/ai/moments';
import { layoutField, type Placed } from '@core/spreads/field';
import { nearDuplicates } from '@core/spreads/similarity';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cx, IconSpark, Kbd } from '../../ui';

export const CARD_W = 208;
export const CARD_H = 70;
const GAP = 12;
/** How long a judged card stays to animate out (ms): a little over --dur-panel. */
const LEAVE_MS = 260;

export type CardState = 'open' | 'keep' | 'kill' | 'merge';

export interface FieldCard {
  candidate: Candidate;
  state: CardState;
}

export interface FieldProps {
  cards: FieldCard[];
  axes: { x: Axis; y: Axis };
  focus: string | null;
  marked: readonly string[];
  streaming: boolean;
  onFocus: (key: string) => void;
  /** Reports the cards' reading order and placement (for keyboard navigation). */
  onLayout: (placed: Placed[]) => void;
  /** A prompt (kill reason, follow move) shown beside the focused card. */
  prompt?: ReactNode;
  /** Shown in the middle when there are no cards. */
  empty?: ReactNode;
}

/** The spread field (docs/VISUAL.md §6.3): a faint dot grid, cards on two axes, hairlines between near-duplicates. */
export function Field({
  cards,
  axes,
  focus,
  marked,
  streaming,
  onFocus,
  onLayout,
  prompt,
  empty,
}: FieldProps): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const open = cards.filter((c) => c.state === 'open');
  const openSig = open.map((c) => c.candidate.key).join('|');
  const lastPlace = useRef(new Map<string, Placed>());
  // Judged cards stay for a moment to animate out, from their last place.
  const leaving = useLeaving(cards, lastPlace);
  const placedOpen = useMemo(
    () =>
      size.width > 0
        ? layoutField(
            open.map((c) => ({
              key: c.candidate.key,
              x: c.candidate.position.x,
              y: c.candidate.position.y,
            })),
            { width: size.width, height: size.height, cardW: CARD_W, cardH: CARD_H, gap: GAP },
          )
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-layout only when the open set or size changes
    [openSig, size.width, size.height],
  );
  // Where each card last sat: a prompt about a card that just left (→ on a new
  // candidate keeps it first) still anchors there.
  const [seen, setSeen] = useState<ReadonlyMap<string, Placed>>(new Map());
  useEffect(() => {
    for (const p of placedOpen) lastPlace.current.set(p.key, p);
    setSeen(new Map(lastPlace.current));
    onLayout(placedOpen);
  }, [placedOpen, onLayout]);

  const pairs = useMemo(
    () =>
      nearDuplicates(
        open.map((c) => ({
          key: c.candidate.key,
          name: c.candidate.name,
          identity: c.candidate.identity,
          description: c.candidate.description,
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- same open set, same pairs
    [openSig],
  );
  const at = new Map(placedOpen.map((p) => [p.key, p]));
  const byKey = new Map(cards.map((c) => [c.candidate.key, c]));
  const focusPlace = focus ? (at.get(focus) ?? seen.get(focus)) : undefined;

  return (
    <div
      className="spread-field"
      ref={ref}
      data-testid="spread-field"
      data-streaming={streaming ? '' : undefined}
    >
      <AxisLabels axes={axes} />
      <svg className="spread-lines" width={size.width} height={size.height} aria-hidden="true">
        {pairs.map((p) => {
          const a = at.get(p.a);
          const b = at.get(p.b);
          if (!a || !b) return null;
          return (
            <line
              key={`${p.a}-${p.b}`}
              data-testid="spread-hairline"
              x1={a.left + CARD_W / 2}
              y1={a.top + CARD_H / 2}
              x2={b.left + CARD_W / 2}
              y2={b.top + CARD_H / 2}
            />
          );
        })}
      </svg>
      {placedOpen.map((p) => {
        const card = byKey.get(p.key);
        if (!card) return null;
        return (
          <Card
            key={p.key}
            card={card}
            place={p}
            focused={focus === p.key}
            marked={marked.includes(p.key)}
            onFocus={onFocus}
          />
        );
      })}
      {leaving.map((l) => (
        <Card
          key={`out-${l.card.candidate.key}`}
          card={l.card}
          place={l.place}
          focused={false}
          marked={false}
          leaving
        />
      ))}
      {open.length === 0 && leaving.length === 0 && empty && (
        <div className="spread-empty">{empty}</div>
      )}
      {prompt && focusPlace && (
        <div
          className="spread-prompt-anchor"
          style={{
            left: Math.min(focusPlace.left + CARD_W + 8, Math.max(0, size.width - 220)),
            top: Math.min(focusPlace.top, Math.max(0, size.height - 280)),
          }}
        >
          {prompt}
        </div>
      )}
    </div>
  );
}

function Card({
  card,
  place,
  focused,
  marked,
  leaving,
  onFocus,
}: {
  card: FieldCard;
  place: Placed;
  focused: boolean;
  marked: boolean;
  leaving?: boolean;
  onFocus?: (key: string) => void;
}): ReactNode {
  const c = card.candidate;
  return (
    <div
      role="button"
      tabIndex={-1}
      aria-pressed={marked}
      aria-label={c.name}
      data-testid="spread-card"
      data-key={c.key}
      data-state={card.state}
      data-focused={focused ? '' : undefined}
      data-marked={marked ? '' : undefined}
      data-wildcard={c.wildcard ? '' : undefined}
      className={cx('spread-card', leaving && `spread-card-out spread-card-out-${card.state}`)}
      style={{
        left: place.left,
        top: place.top,
        width: CARD_W,
        height: CARD_H,
        ['--to-x' as string]: `${-place.left}px`,
        ['--to-y' as string]: `${-place.top - 40}px`,
      }}
      onMouseDown={(e) => {
        e.preventDefault();
        onFocus?.(c.key);
      }}
    >
      <div className="spread-card-name">
        {c.wildcard && (
          <span className="spread-wild" aria-label="wildcard">
            <IconSpark />
          </span>
        )}
        <span className="spread-card-title">{c.name}</span>
      </div>
      <div className="spread-card-identity">{c.identity}</div>
    </div>
  );
}

function AxisLabels({ axes }: { axes: { x: Axis; y: Axis } }): ReactNode {
  return (
    <>
      <div className="spread-axis spread-axis-x" aria-hidden="true">
        <span>{axes.x.low}</span>
        <span className="spread-axis-name">{axes.x.label}</span>
        <span>{axes.x.high}</span>
      </div>
      <div className="spread-axis spread-axis-y" aria-hidden="true">
        <span>{axes.y.low}</span>
        <span className="spread-axis-name">{axes.y.label}</span>
        <span>{axes.y.high}</span>
      </div>
    </>
  );
}

interface Leaving {
  card: FieldCard;
  place: Placed;
}

/** Cards that just left the open set, kept for `LEAVE_MS` so they can animate out from `places`. */
function useLeaving(cards: FieldCard[], places: { current: Map<string, Placed> }): Leaving[] {
  const prevOpen = useRef(new Set<string>());
  const [leaving, setLeaving] = useState<Leaving[]>([]);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const signature = cards.map((c) => `${c.candidate.key}:${c.state}`).join('|');
  useEffect(() => {
    const nowOpen = new Set(cards.filter((c) => c.state === 'open').map((c) => c.candidate.key));
    const gone = cards.filter((c) => c.state !== 'open' && prevOpen.current.has(c.candidate.key));
    prevOpen.current = nowOpen;
    if (gone.length === 0) return;
    const keys = new Set(gone.map((g) => g.candidate.key));
    const out = gone.flatMap((card) => {
      const place = places.current.get(card.candidate.key);
      return place ? [{ card, place }] : [];
    });
    setLeaving((l) => [...l.filter((x) => !keys.has(x.card.candidate.key)), ...out]);
    // Not cleared on the next change: each batch leaves on its own clock.
    setTimeout(() => {
      if (mounted.current) setLeaving((l) => l.filter((x) => !keys.has(x.card.candidate.key)));
    }, LEAVE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the signature
  }, [signature]);
  return leaving.filter(
    (l) => !cards.some((c) => c.candidate.key === l.card.candidate.key && c.state === 'open'),
  );
}

/** A list of choices with their keys (the kill reasons, the follow moves). */
export function ChoiceList({
  items,
  testId,
}: {
  items: { key: string; label: string; disabled?: boolean; onPick: () => void }[];
  testId: string;
}): ReactNode {
  return (
    <div className="ui-overlay spread-choices" role="menu" data-testid={testId}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          role="menuitem"
          className="spread-choice"
          disabled={it.disabled}
          onMouseDown={(e) => {
            e.preventDefault();
            if (!it.disabled) it.onPick();
          }}
        >
          <Kbd>{it.key}</Kbd>
          <span>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
