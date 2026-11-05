import type { Move } from '@core/ai/moments';
import type { World } from '@core/model/world';
import { neighbour, readingOrder, type Direction, type Placed } from '@core/spreads/field';
import { AXIS_LIBRARY, MOVE_DEFS, MOVE_LIST, moveByKey } from '@core/spreads/moves';
import { allSpreads, openCandidates, type SpreadData } from '@core/spreads/record';
import { checkSpot, spotFromUi, spotLabel } from '@core/spreads/spot';
import { judgementCount } from '@core/taste/patterns';
import { reasonOrder } from '@core/taste/commands';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useActions, type Action } from '../../actions';
import { useAiStatus } from '../../ai/client';
import { flash, setUi, uiStore, useUi } from '../../state/ui';
import { currentWorld, useWorld } from '../../state/world';
import {
  Button,
  cx,
  IconSpread,
  Input,
  Empty,
  Kbd,
  Menu,
  Popover,
  ResizablePane,
  Select,
  Tooltip,
} from '../../ui';
import { learnIfDue } from '../taste/learn';
import { defineView } from '../define';
import {
  follow,
  followWith,
  keep,
  kill,
  merge,
  toggleMark,
  triageTarget,
  undoLast,
} from './actions';
import { Detail } from './Detail';
import { clearHandoff, handedSpot, handoffKey } from './handoff';
import { SpotPicker } from './SpotPicker';
import { ChoiceList, Field, type FieldCard } from './Field';
import {
  adoptSpot,
  COUNTS,
  effectiveAxes,
  effectiveRules,
  patchSession,
  patchSetup,
  runSpread,
  sessionStore,
  shownSpread,
  stopSpread,
  useSession,
  type SpreadSession,
} from './session';
import { startFindingNotes } from './notes';
import './spread.css';

// Kept findings are notes in every view, not only while Spread is open.
startFindingNotes();

const whole = (w: World): World => w;
const sameWorld = (a: World, b: World): boolean => a === b;

function SpreadView(): ReactNode {
  const world = useWorld(whole, sameWorld);
  const s = useSession((x) => x);
  const handoff = useUi(handoffKey);
  // The hand-off: a spot set in UI state by another view (see start.ts, handoff.ts).
  useEffect(() => {
    const w = currentWorld();
    const ui = uiStore.get();
    const spot = handedSpot(ui);
    if (!spot || !w) return;
    adoptSpot(w, spot);
    setUi(clearHandoff());
  }, [handoff]);
  // No hand-off and nothing on the field: aim at the selection or the Bench entity.
  useEffect(() => {
    const w = currentWorld();
    const cur = sessionStore.get();
    if (!w || handedSpot(uiStore.get()) || cur.live || cur.current || cur.setup.spot) return;
    const spot = spotFromUi(w, uiStore.get());
    if (spot) adoptSpot(w, spot);
  }, []);

  // Pattern learning after every 25 judgements.
  const judged = useWorld(judgementCount);
  useEffect(() => {
    if (judged !== undefined) learnIfDue();
  }, [judged]);

  if (!world) return null;
  return <SpreadBody world={world} s={s} />;
}

function SpreadBody({ world, s }: { world: World; s: SpreadSession }): ReactNode {
  const status = useAiStatus();
  const direction = useRef<HTMLInputElement>(null);
  const [placed, setPlaced] = useState<Placed[]>([]);
  const onLayout = useCallback((p: Placed[]) => setPlaced(p), []);
  const [picking, setPicking] = useState(false);

  const spread = shownSpread(world, s);
  const live = s.live;
  const axes = live?.axes ?? spread?.axes ?? effectiveAxes(s.setup);
  const queuedState = new Map<string, FieldCard['state']>();
  for (const q of s.queued)
    for (const k of q.type === 'merge' ? q.keys : [q.key]) queuedState.set(k, q.type);
  const cards: FieldCard[] = live
    ? live.candidates.map((candidate) => ({
        candidate,
        state: queuedState.get(candidate.key) ?? 'open',
      }))
    : (spread?.candidates.map((candidate) => ({
        candidate,
        state: spread.judgements[candidate.key]?.verdict ?? 'open',
      })) ?? []);
  const order = readingOrder(placed);
  const focusCard = cards.find((c) => c.candidate.key === s.focus && c.state === 'open');
  // Triage works while streaming too: judgements queue until the record is saved.
  // Its keys read their target when pressed (triageTarget), not from this render.

  const moveTo = (key: string | undefined): void => {
    if (key) patchSession({ focus: key });
  };
  const step = (by: number): void => {
    if (order.length === 0) return;
    const i = s.focus ? order.indexOf(s.focus) : -1;
    moveTo(order[(i + by + order.length) % order.length]);
  };
  const go = (dir: Direction): void => {
    if (!s.focus) return moveTo(order[0]);
    moveTo(neighbour(placed, s.focus, dir));
  };
  const pickMove = (m: Move): void => {
    if (!s.setup.spot) return;
    const check = checkSpot(world, s.setup.spot, m);
    if (!check.ok) return flash(check.error.message, 'error');
    patchSetup({ move: m });
  };
  const run = (): void => {
    direction.current?.blur();
    void runSpread().then((e) => e && flash(e, 'error'));
  };

  const actions: Action[] = [
    ...MOVE_LIST.map((m) => ({
      id: `spread.move.${m.move}`,
      label: `Move: ${m.label}`,
      group: 'Spread',
      keys: [m.key],
      enabled: () => !!sessionStore.get().setup.spot && !sessionStore.get().prompt,
      run: () => pickMove(m.move),
    })),
    {
      id: 'spread.run',
      label: 'Start the spread',
      group: 'Spread',
      keys: ['enter'],
      inInputs: true,
      enabled: () => !!sessionStore.get().setup.spot && !sessionStore.get().prompt,
      run,
    },
    {
      id: 'spread.spot',
      label: 'Change the spot',
      group: 'Spread',
      keys: ['s'],
      run: () => setPicking(true),
    },
    {
      id: 'spread.direction',
      label: 'Edit the direction',
      group: 'Spread',
      keys: ['e'],
      run: () => direction.current?.focus(),
    },
    {
      id: 'spread.stop',
      label: 'Stop the spread',
      group: 'Spread',
      keys: ['escape'],
      inInputs: true,
      enabled: () =>
        !!sessionStore.get().live ||
        document.activeElement === direction.current ||
        sessionStore.get().marked.length > 0,
      run: () => {
        if (document.activeElement === direction.current) return direction.current?.blur();
        if (sessionStore.get().live) return stopSpread();
        patchSession({ marked: [] });
      },
    },
    {
      id: 'spread.next-order',
      label: 'Next candidate',
      keys: ['tab'],
      hidden: true,
      run: () => step(1),
    },
    {
      id: 'spread.prev',
      label: 'Previous candidate',
      keys: ['shift+tab'],
      hidden: true,
      run: () => step(-1),
    },
    {
      id: 'spread.up',
      label: 'Candidate above',
      keys: ['arrowup'],
      hidden: true,
      run: () => go('up'),
    },
    {
      id: 'spread.down',
      label: 'Candidate below',
      keys: ['arrowdown'],
      hidden: true,
      run: () => go('down'),
    },
    {
      id: 'spread.left',
      label: 'Candidate to the left',
      keys: ['arrowleft'],
      hidden: true,
      run: () => go('left'),
    },
    {
      id: 'spread.keep',
      label: 'Keep',
      group: 'Spread',
      keys: ['k'],
      enabled: () => triageTarget() !== null,
      run: () => {
        const key = triageTarget();
        if (key) void keep(key, order);
      },
    },
    {
      id: 'spread.kill',
      label: 'Kill…',
      group: 'Spread',
      keys: ['x'],
      enabled: () => triageTarget() !== null,
      run: () => {
        const key = triageTarget();
        if (key) patchSession({ prompt: { type: 'kill', key } });
      },
    },
    {
      id: 'spread.mark',
      label: 'Mark for merging',
      group: 'Spread',
      keys: ['space'],
      enabled: () => triageTarget() !== null,
      run: () => {
        const key = triageTarget();
        if (key) toggleMark(key);
      },
    },
    {
      id: 'spread.merge',
      label: 'Merge marked',
      group: 'Spread',
      keys: ['m'],
      enabled: () => !!live || !!spread,
      run: () => void merge(order),
    },
    {
      id: 'spread.follow',
      label: 'Follow with a move…',
      group: 'Spread',
      keys: ['arrowright'],
      enabled: () =>
        !!s.focus && (live ?? spread)?.candidates.some((c) => c.key === s.focus) === true,
      run: () => s.focus && void follow(s.focus, order),
    },
    { id: 'spread.undo', label: 'Undo', group: 'Spread', keys: ['u'], run: undoLast },
  ];
  useActions(actions);

  const prompt =
    s.prompt && s.focus === s.prompt.key ? <PromptFor world={world} order={order} /> : undefined;
  // Only one empty state carries a message: there's nothing to aim at.
  const empty = !s.setup.spot ? (
    <Empty>
      Nothing to spread on. <Kbd>s</Kbd> to choose a spot.
    </Empty>
  ) : !status.enabled && !live && !spread ? (
    <span className="t-3" data-testid="spread-ai-off">
      {status.reason ?? 'AI is off'}
    </span>
  ) : null;

  return (
    <div className="spread-view" data-testid="spread-view">
      <Bar
        world={world}
        s={s}
        spread={spread}
        onRun={run}
        direction={direction}
        aiOff={!status.enabled ? (status.reason ?? 'AI is off') : null}
        picking={picking}
        setPicking={setPicking}
      />
      <Field
        cards={cards}
        axes={axes}
        focus={s.focus}
        marked={s.marked}
        streaming={!!live}
        onFocus={(key) => patchSession({ focus: key, prompt: null })}
        onLayout={onLayout}
        prompt={prompt}
        empty={empty}
      />
      {s.error && (
        <div className="spread-error t-danger" data-testid="spread-error">
          {s.error.message}
        </div>
      )}
      <ResizablePane
        id="spread-detail"
        axis="y"
        edge="start"
        min={64}
        max={({ parent }) => parent * 0.6}
        label="Detail height"
        className="spread-detail-pane"
      >
        {focusCard ? (
          <Detail world={world} spread={spread} candidate={focusCard.candidate} />
        ) : (
          <div className="spread-detail spread-detail-empty" />
        )}
      </ResizablePane>
    </div>
  );
}

/** The spread bar: spot, move, direction, axes, count, rules, start/stop, history. */
function Bar({
  world,
  s,
  spread,
  onRun,
  direction,
  aiOff,
  picking,
  setPicking,
}: {
  picking: boolean;
  setPicking: (on: boolean) => void;
  world: World;
  s: SpreadSession;
  spread: SpreadData | null;
  onRun: () => void;
  direction: React.RefObject<HTMLInputElement | null>;
  aiOff: string | null;
}): ReactNode {
  const { setup, live } = s;
  const axes = effectiveAxes(setup);
  const axisOptions = AXIS_LIBRARY.map((a) => ({ value: a.label, label: a.label }));
  const axisBy = (label: string) => AXIS_LIBRARY.find((a) => a.label === label);
  const rules = world.taste.rules;
  const on = new Set(effectiveRules(world, setup));
  const history = allSpreads(world).slice(-12).reverse();
  const shownOpen = spread ? openCandidates(spread).length : 0;
  return (
    <div className="spread-bar" data-testid="spread-bar">
      {picking ? (
        <SpotPicker
          world={world}
          onPick={(spot) => adoptSpot(world, spot)}
          onClose={() => setPicking(false)}
        />
      ) : (
        <Tooltip content="Change the spot" keys="s">
          <button
            type="button"
            className="spread-spot"
            data-testid="spread-spot"
            onClick={() => setPicking(true)}
          >
            {setup.spot ? spotLabel(world, setup.spot) : <span className="t-3">Spot</span>}
          </button>
        </Tooltip>
      )}
      <div className="spread-moves" role="radiogroup" aria-label="Move">
        {MOVE_LIST.map((m) => {
          const ok = !!setup.spot && checkSpot(world, setup.spot, m.move).ok;
          return (
            <Tooltip key={m.move} content={m.asks} keys={m.key}>
              <button
                type="button"
                role="radio"
                aria-checked={setup.move === m.move}
                data-testid={`spread-move-${m.move}`}
                className={cx('spread-move', setup.move === m.move && 'is-on')}
                disabled={!ok}
                onClick={() => patchSetup({ move: m.move })}
              >
                {m.label}
              </button>
            </Tooltip>
          );
        })}
      </div>
      <Input
        ref={direction}
        className="spread-direction"
        data-testid="spread-direction"
        aria-label="Direction"
        placeholder="Direction"
        maxLength={300}
        value={setup.direction}
        onChange={(e) => patchSetup({ direction: e.target.value })}
      />
      <div className="spread-axes">
        <Select
          aria-label="x axis"
          className="spread-axis-select"
          value={axes.x.label}
          options={axisOptions}
          onValueChange={(v) => {
            const a = axisBy(v);
            if (a) patchSetup({ axes: { x: a, y: a.label === axes.y.label ? axes.x : axes.y } });
          }}
        />
        <span className="t-3 spread-times">×</span>
        <Select
          aria-label="y axis"
          className="spread-axis-select"
          value={axes.y.label}
          options={axisOptions}
          onValueChange={(v) => {
            const a = axisBy(v);
            if (a) patchSetup({ axes: { y: a, x: a.label === axes.x.label ? axes.y : axes.x } });
          }}
        />
      </div>
      <Select
        aria-label="Candidates"
        className="spread-count"
        value={String(setup.count)}
        options={COUNTS.map((n) => ({ value: String(n), label: String(n) }))}
        onValueChange={(v) => patchSetup({ count: Number(v) })}
      />
      {rules.length > 0 && (
        <Popover
          trigger={
            <Button
              size="sm"
              variant="ghost"
              data-testid="spread-rules"
              aria-label="Rules for this spread"
            >
              <span className="num">
                {[...on].filter((id) => rules.some((r) => r.id === id)).length}/{rules.length}
              </span>
              <span>rules</span>
            </Button>
          }
          align="end"
        >
          <div className="spread-rules" data-testid="spread-rules-list">
            {rules.map((r) => (
              <label key={r.id} className="spread-rule">
                <input
                  type="checkbox"
                  checked={on.has(r.id)}
                  onChange={(e) => {
                    const next = new Set(on);
                    if (e.target.checked) next.add(r.id);
                    else next.delete(r.id);
                    patchSetup({ ruleIds: rules.map((x) => x.id).filter((id) => next.has(id)) });
                  }}
                />
                <span>{r.text}</span>
              </label>
            ))}
          </div>
        </Popover>
      )}
      <div className="spread-bar-end">
        {live ? (
          <>
            <span className="num t-ai" data-testid="spread-progress">
              {live.candidates.length}/{live.count}
            </span>
            <Tooltip content="Stop" keys="esc">
              <Button size="sm" variant="secondary" onClick={stopSpread} data-testid="spread-stop">
                Stop
              </Button>
            </Tooltip>
          </>
        ) : (
          <>
            {spread && (
              <span className="num t-2" data-testid="spread-open" title="Open candidates">
                {shownOpen}/{spread.candidates.length}
              </span>
            )}
            <Tooltip content={aiOff ?? MOVE_DEFS[setup.move].asks} keys="enter">
              <Button
                size="sm"
                variant="primary"
                onClick={onRun}
                disabled={!setup.spot || !checkSpot(world, setup.spot, setup.move).ok || !!aiOff}
                data-testid="spread-run"
              >
                {MOVE_DEFS[setup.move].label}
              </Button>
            </Tooltip>
          </>
        )}
        {history.length > 0 && (
          <Menu
            align="end"
            trigger={
              <Button
                size="sm"
                variant="ghost"
                aria-label="Earlier spreads"
                data-testid="spread-history"
              >
                <IconSpread />
              </Button>
            }
            items={history.map((h) => ({
              label: (
                <span className="spread-history-item">
                  <span>{MOVE_DEFS[h.move].label}</span>
                  <span className="t-2">{spotLabel(world, h.spot)}</span>
                  <span className="num t-3">{openCandidates(h).length}</span>
                </span>
              ),
              onSelect: () => openSpread(h),
            }))}
          />
        )}
      </div>
    </div>
  );
}

/** Puts an earlier spread back on the field, with its setup. */
function openSpread(h: SpreadData): void {
  stopSpread();
  sessionStore.set((s) => ({
    ...s,
    setup: {
      ...s.setup,
      spot: h.spot,
      move: h.move,
      direction: h.direction ?? '',
      axes: h.axes,
      count: h.count,
      ruleIds: h.ruleIds,
      parent: undefined,
    },
    current: h.id,
    live: null,
    error: null,
    focus: openCandidates(h)[0]?.key ?? null,
    marked: [],
    prompt: null,
  }));
}

/**
 * The prompt beside the focused card: a kill reason, the words for "other", or
 * the move to follow with. It takes the keyboard while open (handled here, so
 * digits pick a reason instead of switching views).
 */
function PromptFor({ world, order }: { world: World; order: string[] }): ReactNode {
  const prompt = useSession((x) => x.prompt);
  const box = useRef<HTMLDivElement>(null);
  const [words, setWords] = useState('');
  useEffect(() => {
    // "other" focuses its own input.
    if (prompt && prompt.type !== 'other') box.current?.focus();
  }, [prompt]);
  if (!prompt) return null;
  const close = (): void => patchSession({ prompt: null });
  const reasons = [...world.taste.reasons].sort((a, b) => reasonOrder(a.key) - reasonOrder(b.key));
  const pickReason = (key: string): void => {
    if (key === '0') return patchSession({ prompt: { type: 'other', key: prompt.key } });
    void kill(prompt.key, key, order);
  };
  const followMoves =
    prompt.type === 'follow'
      ? MOVE_LIST.filter((m) => checkSpot(world, prompt.spot, m.move).ok)
      : [];
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    // Answered already (a reason picked, the prompt cleared) but not yet
    // re-rendered away: the next key is the next triage key, not this prompt's.
    const now = sessionStore.get().prompt;
    if (now?.type !== prompt.type || now.key !== prompt.key) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return close();
    }
    if (prompt.type === 'other') {
      if (e.key === 'Enter') {
        e.preventDefault();
        void kill(prompt.key, '0', order, words);
        setWords('');
      }
      e.stopPropagation();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (prompt.type === 'kill' && reasons.some((r) => r.key === e.key)) {
      e.preventDefault();
      e.stopPropagation();
      return pickReason(e.key);
    }
    if (prompt.type === 'follow') {
      const m = moveByKey(e.key.toLowerCase());
      if (m && followMoves.includes(m)) {
        e.preventDefault();
        e.stopPropagation();
        return followWith(m.move);
      }
    }
    // Everything else is swallowed while the prompt is open, except navigation out.
    if (e.key.length === 1) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  return (
    <div
      ref={box}
      tabIndex={-1}
      className="spread-prompt"
      onKeyDown={onKey}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && close()}
    >
      {prompt.type === 'kill' && (
        <ChoiceList
          testId="spread-kill-reasons"
          items={reasons.map((r) => ({
            key: r.key,
            label: r.label,
            onPick: () => pickReason(r.key),
          }))}
        />
      )}
      {prompt.type === 'other' && (
        <div className="ui-overlay spread-choices" data-testid="spread-kill-other">
          <Input
            autoFocus
            aria-label="Reason"
            placeholder="A few words"
            maxLength={200}
            value={words}
            onChange={(e) => setWords(e.target.value)}
          />
        </div>
      )}
      {prompt.type === 'follow' && (
        <ChoiceList
          testId="spread-follow-moves"
          items={followMoves.map((m) => ({
            key: m.key,
            label: m.label,
            onPick: () => followWith(m.move),
          }))}
        />
      )}
    </div>
  );
}

export default defineView({
  id: 'spread',
  label: 'Spread',
  key: '5',
  order: 5,
  icon: IconSpread,
  component: SpreadView,
});
