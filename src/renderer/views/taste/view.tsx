import { cmd } from '@core/commands/registry';
import type { Taste } from '@core/model/world';
import { reasonOrder } from '@core/taste/commands';
import { judgedSinceRun, PATTERN_EVERY } from '@core/taste/patterns';
import { useRef, useState, type ReactNode } from 'react';
import { useActions, type Action } from '../../actions';
import { useAiStatus } from '../../ai/client';
import { createStore, useStore } from '../../state/store';
import { flash } from '../../state/ui';
import { dispatch, transact, useWorld } from '../../state/world';
import {
  Button,
  cx,
  IconButton,
  IconClose,
  IconSpark,
  IconTaste,
  Empty,
  Input,
  Kbd,
  Tooltip,
} from '../../ui';
import { defineView } from '../define';
import { startSpread } from '../spread/start';
import { learnPatterns, learnStore, useLearning } from './learn';
import { ArtDirectionSection } from './ArtDirection';
import './taste.css';

/**
 * Taste (docs/EXPERIENCE.md §6): your rules, the kill-reason vocabulary with
 * how often each is used, and the patterns carbon learned, to promote or
 * dismiss. Three columns, one keyboard cursor: h/l between columns, j/k
 * within one.
 */

type Col = 'rules' | 'reasons' | 'patterns';
const COLS: Col[] = ['rules', 'reasons', 'patterns'];

const cursorStore = createStore<{ col: Col; row: number; editing: string | null }>({
  col: 'rules',
  row: 0,
  editing: null,
});
const useCursor = (): { col: Col; row: number; editing: string | null } =>
  useStore(
    cursorStore,
    (s) => s,
    (a, b) => a.col === b.col && a.row === b.row && a.editing === b.editing,
  );
const setCursor = (p: Partial<{ col: Col; row: number; editing: string | null }>): void =>
  cursorStore.set((s) => ({ ...s, ...p }));

const run = async (label: string, ...cs: Parameters<typeof transact>[1]): Promise<boolean> => {
  const r = await transact(label, cs);
  if (!r.ok) flash(r.error.message, 'error');
  return r.ok;
};

type Pattern = Taste['patterns'][number];
const patternOrder = (ps: readonly Pattern[]): Pattern[] => {
  const rank = { proposed: 0, promoted: 1, dismissed: 2 } as const;
  return [...ps].sort((a, b) => rank[a.status] - rank[b.status]);
};
const strength = (p: Pattern): number => (typeof p.strength === 'number' ? p.strength : 0);

function TasteView(): ReactNode {
  const taste = useWorld(
    (w) => w.taste,
    (a, b) => a === b,
  );
  const since = useWorld(judgedSinceRun);
  if (!taste) return null;
  return <TasteBody taste={taste} since={since ?? 0} />;
}

function TasteBody({ taste, since }: { taste: Taste; since: number }): ReactNode {
  const cursor = useCursor();
  const learning = useLearning();
  const status = useAiStatus();
  const [showDismissed, setShowDismissed] = useState(false);
  const newRule = useRef<HTMLInputElement>(null);
  const reasons = [...taste.reasons].sort((a, b) => reasonOrder(a.key) - reasonOrder(b.key));
  const patterns = patternOrder(taste.patterns).filter(
    (p) => showDismissed || p.status !== 'dismissed',
  );
  const dismissed = taste.patterns.filter((p) => p.status === 'dismissed').length;
  const lengths: Record<Col, number> = {
    rules: taste.rules.length,
    reasons: reasons.length,
    patterns: patterns.length,
  };
  const row = Math.min(cursor.row, Math.max(0, lengths[cursor.col] - 1));
  const at = <T,>(list: readonly T[], col: Col): T | undefined =>
    cursor.col === col ? list[row] : undefined;
  const rule = at(taste.rules, 'rules');
  const reason = at(reasons, 'reasons');
  const pattern = at(patterns, 'patterns');
  const totalKills = reasons.reduce((n, r) => n + r.count, 0);

  const moveCol = (by: number): void => {
    const i = (COLS.indexOf(cursor.col) + by + COLS.length) % COLS.length;
    setCursor({ col: COLS[i] ?? 'rules', row: 0 });
  };
  const moveRow = (by: number): void =>
    setCursor({ row: Math.max(0, Math.min(lengths[cursor.col] - 1, row + by)) });
  const promote = (p: Pattern): void =>
    void run(
      'Promote pattern',
      cmd('taste.addRule', { text: p.text, from: p.id }),
      cmd('taste.setPatternStatus', { id: p.id, status: 'promoted' }),
    );
  const dismiss = (p: Pattern): void =>
    void run('Dismiss pattern', cmd('taste.setPatternStatus', { id: p.id, status: 'dismissed' }));
  const learn = (): void =>
    void learnPatterns().then((n) => {
      const error = learnStore.get().error;
      if (n === null && error) flash(error, 'error');
      else if (n === 0) flash('No new patterns');
    });

  const idle = cursor.editing === null;
  const actions: Action[] = [
    {
      id: 'taste.left',
      label: 'Previous column',
      keys: ['h', 'arrowleft'],
      hidden: true,
      enabled: () => idle,
      run: () => moveCol(-1),
    },
    {
      id: 'taste.right',
      label: 'Next column',
      keys: ['l', 'arrowright'],
      hidden: true,
      enabled: () => idle,
      run: () => moveCol(1),
    },
    {
      id: 'taste.down',
      label: 'Next row',
      keys: ['j', 'arrowdown'],
      hidden: true,
      enabled: () => idle,
      run: () => moveRow(1),
    },
    {
      id: 'taste.up',
      label: 'Previous row',
      keys: ['k', 'arrowup'],
      hidden: true,
      enabled: () => idle,
      run: () => moveRow(-1),
    },
    {
      id: 'taste.new-rule',
      label: 'New rule',
      group: 'Taste',
      keys: ['n'],
      run: () => {
        setCursor({ col: 'rules' });
        newRule.current?.focus();
      },
    },
    {
      id: 'taste.toggle-rule',
      label: 'Switch the rule on or off',
      group: 'Taste',
      keys: ['space'],
      enabled: () => idle && !!rule,
      run: () =>
        rule &&
        void run(
          rule.enabled ? 'Disable rule' : 'Enable rule',
          cmd('taste.updateRule', { id: rule.id, enabled: !rule.enabled }),
        ),
    },
    {
      id: 'taste.edit',
      label: 'Edit',
      group: 'Taste',
      keys: ['enter'],
      enabled: () => idle && (!!rule || !!reason),
      run: () =>
        setCursor({ editing: rule ? `rule:${rule.id}` : reason ? `reason:${reason.key}` : null }),
    },
    {
      id: 'taste.remove',
      label: 'Remove',
      group: 'Taste',
      keys: ['delete', 'backspace'],
      enabled: () => idle && (!!rule || (!!reason && reason.key !== '0')),
      run: () => {
        if (rule) void run('Remove rule', cmd('taste.removeRule', { id: rule.id }));
        else if (reason)
          void run('Remove kill reason', cmd('taste.removeReason', { key: reason.key }));
      },
    },
    {
      id: 'taste.oppose',
      label: 'Oppose this rule in a spread',
      group: 'Taste',
      keys: ['o'],
      enabled: () => idle && !!rule,
      run: () => rule && startSpread({ type: 'note', note: rule.text, entities: [] }, 'oppose'),
    },
    {
      id: 'taste.promote',
      label: 'Promote the pattern to a rule',
      group: 'Taste',
      keys: ['p'],
      enabled: () => idle && !!pattern && pattern.status !== 'promoted',
      run: () => pattern && promote(pattern),
    },
    {
      id: 'taste.dismiss',
      label: 'Dismiss the pattern',
      group: 'Taste',
      keys: ['d'],
      enabled: () => idle && !!pattern && pattern.status !== 'dismissed',
      run: () => pattern && dismiss(pattern),
    },
    {
      id: 'taste.learn',
      label: 'Learn patterns now',
      group: 'Taste',
      keys: ['shift+l'],
      enabled: () => !learning.running,
      run: learn,
    },
  ];
  useActions(actions);

  return (
    <div className="taste-view" data-testid="taste-view">
      <div className="taste-stack">
        <section
          className={cx('taste-col', cursor.col === 'rules' && 'is-current')}
          aria-label="Rules"
          data-testid="taste-rules"
        >
          <div className="taste-col-head">
            <span>Rules</span>
          </div>
          <div className="taste-list">
            {taste.rules.map((r, i) => (
              <RuleRow
                key={r.id}
                r={r}
                current={cursor.col === 'rules' && row === i}
                onPick={() => setCursor({ col: 'rules', row: i })}
              />
            ))}
          </div>
          <form
            className="taste-add"
            onSubmit={(e) => {
              e.preventDefault();
              const input = newRule.current;
              const text = input?.value.trim() ?? '';
              if (!input || text === '') return;
              void run('Add rule', cmd('taste.addRule', { text })).then((ok) => {
                if (ok) input.value = '';
              });
            }}
          >
            <Input
              ref={newRule}
              aria-label="New rule"
              placeholder="New rule"
              data-testid="taste-new-rule"
              onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
            />
          </form>
        </section>
        <ArtDirectionSection />
      </div>

      <section
        className={cx('taste-col', cursor.col === 'reasons' && 'is-current')}
        aria-label="Kill reasons"
        data-testid="taste-reasons"
      >
        <div className="taste-col-head">
          <span>Kill reasons</span>
          {totalKills > 0 && <span className="num t-3">{totalKills}</span>}
        </div>
        <div className="taste-list">
          {reasons.map((r, i) => (
            <ReasonRow
              key={r.key}
              r={r}
              share={totalKills > 0 ? r.count / totalKills : 0}
              current={cursor.col === 'reasons' && row === i}
              onPick={() => setCursor({ col: 'reasons', row: i })}
            />
          ))}
        </div>
        <AddReason taste={taste} />
      </section>

      <section
        className={cx('taste-col', cursor.col === 'patterns' && 'is-current')}
        aria-label="Patterns"
        data-testid="taste-patterns"
      >
        <div className="taste-col-head">
          <span>Patterns</span>
          <span className="taste-col-end">
            {since > 0 && (
              <Tooltip
                content={`Judgements since the last run; it runs by itself at ${PATTERN_EVERY}`}
              >
                <span className="num t-3" data-testid="taste-since">
                  {since}/{PATTERN_EVERY}
                </span>
              </Tooltip>
            )}
            <Tooltip
              content={status.enabled ? 'Learn patterns now' : (status.reason ?? 'AI is off')}
              keys="shift+l"
            >
              <Button
                size="sm"
                variant="ghost"
                className="taste-learn"
                onClick={learn}
                disabled={learning.running || !status.enabled}
                data-testid="taste-learn"
              >
                <IconSpark />
                {learning.running ? 'Learning' : 'Learn'}
              </Button>
            </Tooltip>
          </span>
        </div>
        <div className="taste-list">
          {patterns.map((p, i) => (
            <PatternRow
              key={p.id}
              p={p}
              current={cursor.col === 'patterns' && row === i}
              onPick={() => setCursor({ col: 'patterns', row: i })}
              onPromote={() => promote(p)}
              onDismiss={() => dismiss(p)}
            />
          ))}
          {taste.patterns.length === 0 && since === 0 && (
            <Empty className="taste-empty">
              No judgements yet. <Kbd>5</Kbd> to spread.
            </Empty>
          )}
        </div>
        {dismissed > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="taste-dismissed"
            onClick={() => setShowDismissed((v) => !v)}
          >
            {showDismissed ? 'Hide dismissed' : `${dismissed} dismissed`}
          </Button>
        )}
      </section>
    </div>
  );
}

function useEditing(id: string): [boolean, () => void] {
  const editing = useCursor().editing === id;
  return [editing, () => setCursor({ editing: null })];
}

/** Inline text edit: enter saves, escape cancels. */
function InlineEdit({
  value,
  onSave,
  onDone,
  label,
}: {
  value: string;
  onSave: (v: string) => void;
  onDone: () => void;
  label: string;
}): ReactNode {
  const [v, setV] = useState(value);
  return (
    <Input
      autoFocus
      aria-label={label}
      value={v}
      className="taste-inline"
      onChange={(e) => setV(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (v.trim() && v.trim() !== value) onSave(v.trim());
          onDone();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onDone();
        }
      }}
    />
  );
}

function RuleRow({
  r,
  current,
  onPick,
}: {
  r: Taste['rules'][number];
  current: boolean;
  onPick: () => void;
}): ReactNode {
  const [editing, done] = useEditing(`rule:${r.id}`);
  return (
    <div
      className={cx('taste-row', current && 'is-current', !r.enabled && 'is-off')}
      data-testid="taste-rule"
      data-id={r.id}
      onMouseDown={onPick}
    >
      <Tooltip content={r.enabled ? 'On for new spreads' : 'Off for new spreads'} keys="space">
        <button
          type="button"
          role="switch"
          aria-checked={r.enabled}
          aria-label={r.text}
          className="taste-switch"
          onClick={() => void dispatch(cmd('taste.updateRule', { id: r.id, enabled: !r.enabled }))}
        />
      </Tooltip>
      {editing ? (
        <InlineEdit
          label="Rule"
          value={r.text}
          onDone={done}
          onSave={(text) => void run('Edit rule', cmd('taste.updateRule', { id: r.id, text }))}
        />
      ) : (
        <span className="taste-text" onDoubleClick={() => setCursor({ editing: `rule:${r.id}` })}>
          {r.text}
        </span>
      )}
      <IconButton
        size="sm"
        label="Remove rule"
        icon={<IconClose />}
        className="taste-row-action"
        onClick={() => void run('Remove rule', cmd('taste.removeRule', { id: r.id }))}
      />
    </div>
  );
}

function ReasonRow({
  r,
  share,
  current,
  onPick,
}: {
  r: Taste['reasons'][number];
  share: number;
  current: boolean;
  onPick: () => void;
}): ReactNode {
  const [editing, done] = useEditing(`reason:${r.key}`);
  return (
    <div
      className={cx('taste-row', 'taste-reason', current && 'is-current')}
      data-testid="taste-reason"
      data-key={r.key}
      onMouseDown={onPick}
    >
      <Kbd>{r.key}</Kbd>
      {editing ? (
        <InlineEdit
          label="Reason"
          value={r.label}
          onDone={done}
          onSave={(label) =>
            void run('Rename kill reason', cmd('taste.updateReason', { key: r.key, label }))
          }
        />
      ) : (
        <span
          className="taste-text"
          onDoubleClick={() => setCursor({ editing: `reason:${r.key}` })}
        >
          {r.label}
        </span>
      )}
      <span className="taste-bar" aria-hidden="true">
        <span style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span
        className="num taste-count"
        data-testid="taste-reason-count"
        data-zero={r.count === 0 ? '' : undefined}
      >
        {r.count}
      </span>
    </div>
  );
}

function AddReason({ taste }: { taste: Taste }): ReactNode {
  const free = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].find(
    (k) => !taste.reasons.some((r) => r.key === k),
  );
  const input = useRef<HTMLInputElement>(null);
  if (!free) return null;
  return (
    <form
      className="taste-add taste-add-reason"
      onSubmit={(e) => {
        e.preventDefault();
        const label = input.current?.value.trim() ?? '';
        if (label === '') return;
        void run('Add kill reason', cmd('taste.addReason', { key: free, label })).then((ok) => {
          if (ok && input.current) input.current.value = '';
        });
      }}
    >
      <Kbd>{free}</Kbd>
      <Input
        ref={input}
        aria-label="New kill reason"
        placeholder="New reason"
        maxLength={40}
        data-testid="taste-new-reason"
        onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
      />
    </form>
  );
}

function PatternRow({
  p,
  current,
  onPick,
  onPromote,
  onDismiss,
}: {
  p: Pattern;
  current: boolean;
  onPick: () => void;
  onPromote: () => void;
  onDismiss: () => void;
}): ReactNode {
  return (
    <div
      className={cx('taste-row', 'taste-pattern', current && 'is-current', `is-${p.status}`)}
      data-testid="taste-pattern"
      data-status={p.status}
      onMouseDown={onPick}
    >
      <div className="taste-pattern-main">
        <span className="taste-text">{p.text}</span>
        {p.examples.length > 0 && (
          <span className="taste-examples t-3">{p.examples.join(' · ')}</span>
        )}
      </div>
      <Tooltip content={`Strength ${Math.round(strength(p) * 100)}%`}>
        <span className="taste-strength" aria-label={`strength ${Math.round(strength(p) * 100)}%`}>
          <span style={{ width: `${Math.round(strength(p) * 100)}%` }} />
        </span>
      </Tooltip>
      {p.status === 'proposed' && (
        <span className="taste-pattern-actions">
          <Tooltip content="Promote to a rule" keys="p">
            <Button size="sm" variant="secondary" onClick={onPromote} data-testid="taste-promote">
              Promote
            </Button>
          </Tooltip>
          <IconButton
            size="sm"
            label="Dismiss"
            keys="d"
            icon={<IconClose />}
            onClick={onDismiss}
            data-testid="taste-dismiss"
          />
        </span>
      )}
    </div>
  );
}

export default defineView({
  id: 'taste',
  label: 'Taste',
  key: '6',
  order: 6,
  icon: IconTaste,
  component: TasteView,
});
