import { z } from 'zod';
import { defineCommand } from '../commands/define';
import { slugify } from '../model/ids';
import type { Taste, World } from '../model/world';
import { err, ok } from '../util/result';
import { mergePatterns, PatternInputSchema } from './patterns';

/**
 * Taste commands (docs/EXPERIENCE.md §6), finer than the foundation's
 * `taste.set`, so each edit in the Taste view is its own undo step and the
 * kill-reason counts move with the kills that use them.
 */

type Rule = Taste['rules'][number];
type Reason = Taste['reasons'][number];

const RuleTextSchema = z.string().trim().min(1, 'a rule needs text').max(300);
const ReasonKeySchema = z.string().regex(/^[0-9]$/, 'a reason key is one digit');
const ReasonLabelSchema = z.string().trim().min(1, 'a reason needs a label').max(40);

/** A rule id from its text, unique among the rules: `rule-<slug>`. */
export function ruleIdFor(rules: readonly Rule[], text: string): string {
  const base = `rule-${slugify(text).slice(0, 40).replace(/-+$/, '')}`;
  const taken = new Set(rules.map((r) => r.id));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

const setRules = (rules: Rule[]) =>
  ok([{ op: 'set' as const, path: ['taste', 'rules'], value: rules }]);
const setReasons = (reasons: Reason[]) =>
  ok([{ op: 'set' as const, path: ['taste', 'reasons'], value: reasons }]);

const findRule = (world: World, id: string): Rule | undefined =>
  world.taste.rules.find((r) => r.id === id);

export const addRule = defineCommand({
  payload: z.object({
    text: RuleTextSchema,
    id: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    /** The pattern it was promoted from. */
    from: z.string().optional(),
  }),
  label: (p) => `Add rule "${p.text}"`,
  plan(world, p) {
    const id = p.id ?? ruleIdFor(world.taste.rules, p.text);
    if (findRule(world, id)) return err('taste.rule_exists', `a rule "${id}" already exists`);
    const rule: Rule = { id, text: p.text, enabled: true, ...(p.from ? { from: p.from } : {}) };
    return setRules([...world.taste.rules, rule]);
  },
});

export const updateRule = defineCommand({
  payload: z.object({
    id: z.string(),
    text: RuleTextSchema.optional(),
    enabled: z.boolean().optional(),
  }),
  label: (p, w) =>
    p.enabled === undefined
      ? `Edit rule "${findRule(w, p.id)?.text ?? p.id}"`
      : `${p.enabled ? 'Enable' : 'Disable'} rule "${findRule(w, p.id)?.text ?? p.id}"`,
  plan(world, p) {
    if (!findRule(world, p.id)) return err('taste.no_rule', `no rule "${p.id}"`);
    return setRules(
      world.taste.rules.map((r) =>
        r.id === p.id
          ? {
              ...r,
              ...(p.text !== undefined ? { text: p.text } : {}),
              ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
            }
          : r,
      ),
    );
  },
});

export const removeRule = defineCommand({
  payload: z.object({ id: z.string() }),
  label: (p, w) => `Remove rule "${findRule(w, p.id)?.text ?? p.id}"`,
  plan(world, p) {
    if (!findRule(world, p.id)) return err('taste.no_rule', `no rule "${p.id}"`);
    return setRules(world.taste.rules.filter((r) => r.id !== p.id));
  },
});

/** Adds a kill reason on a free digit key. */
export const addReason = defineCommand({
  payload: z.object({ key: ReasonKeySchema, label: ReasonLabelSchema }),
  label: (p) => `Add kill reason "${p.label}"`,
  plan(world, p) {
    if (world.taste.reasons.some((r) => r.key === p.key))
      return err('taste.reason_exists', `key ${p.key} already has a reason`);
    const reasons = [...world.taste.reasons, { key: p.key, label: p.label, count: 0 }];
    return setReasons(reasons.sort((a, b) => reasonOrder(a.key) - reasonOrder(b.key)));
  },
});

export const updateReason = defineCommand({
  payload: z.object({ key: ReasonKeySchema, label: ReasonLabelSchema }),
  label: (p) => `Rename kill reason ${p.key} to "${p.label}"`,
  plan(world, p) {
    if (!world.taste.reasons.some((r) => r.key === p.key))
      return err('taste.no_reason', `no reason on key ${p.key}`);
    return setReasons(
      world.taste.reasons.map((r) => (r.key === p.key ? { ...r, label: p.label } : r)),
    );
  },
});

/** Removes a kill reason. "0" (other) always stays: it's the way to say anything else. */
export const removeReason = defineCommand({
  payload: z.object({ key: ReasonKeySchema }),
  label: (p, w) =>
    `Remove kill reason "${w.taste.reasons.find((r) => r.key === p.key)?.label ?? p.key}"`,
  plan(world, p) {
    if (p.key === '0') return err('taste.reason_other', '"other" can’t be removed');
    if (!world.taste.reasons.some((r) => r.key === p.key))
      return err('taste.no_reason', `no reason on key ${p.key}`);
    return setReasons(world.taste.reasons.filter((r) => r.key !== p.key));
  },
});

/** Moves a reason's usage count (a kill counts +1; its undo takes it back exactly). */
export const countReason = defineCommand({
  payload: z.object({ key: ReasonKeySchema, by: z.number().int() }),
  label: (p) => `Count kill reason ${p.key}`,
  plan(world, p) {
    const r = world.taste.reasons.find((x) => x.key === p.key);
    if (!r) return err('taste.no_reason', `no reason on key ${p.key}`);
    if (r.count + p.by < 0) return err('taste.count', 'a count can’t go below 0');
    return setReasons(
      world.taste.reasons.map((x) => (x.key === p.key ? { ...x, count: x.count + p.by } : x)),
    );
  },
});

/** "1".."9" in order, then "0" last (as on the keyboard). */
export const reasonOrder = (key: string): number => (key === '0' ? 10 : Number(key));

/**
 * Takes in the result of a `patterns` moment: new patterns are added as
 * proposed, updates replace the text of the pattern they name, and the run is
 * marked against `judged` (the judgement count it learned from).
 */
export const learnPatterns = defineCommand({
  payload: z.object({
    patterns: z.array(PatternInputSchema),
    /** Judgements in the world when the run started. */
    judged: z.number().int().min(0),
    at: z.string(),
  }),
  label: (p) => `Learn ${p.patterns.length} pattern${p.patterns.length === 1 ? '' : 's'}`,
  plan(world, p) {
    const patterns = mergePatterns(world.taste.patterns, p.patterns, p.at);
    const prev = (world.settings as { patterns?: unknown }).patterns;
    return ok([
      { op: 'set', path: ['taste', 'patterns'], value: patterns },
      {
        op: 'set',
        path: ['settings', 'patterns'],
        value: { ...(isRecord(prev) ? prev : {}), judged: p.judged, at: p.at },
      },
    ]);
  },
});

export const setPatternStatus = defineCommand({
  payload: z.object({ id: z.string(), status: z.enum(['proposed', 'promoted', 'dismissed']) }),
  label: (p, w) => {
    const verb =
      p.status === 'promoted' ? 'Promote' : p.status === 'dismissed' ? 'Dismiss' : 'Reopen';
    return `${verb} pattern "${w.taste.patterns.find((x) => x.id === p.id)?.text ?? p.id}"`;
  },
  plan(world, p) {
    if (!world.taste.patterns.some((x) => x.id === p.id))
      return err('taste.no_pattern', `no pattern "${p.id}"`);
    return ok([
      {
        op: 'set',
        path: ['taste', 'patterns'],
        value: world.taste.patterns.map((x) => (x.id === p.id ? { ...x, status: p.status } : x)),
      },
    ]);
  },
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const tasteCommands = {
  'taste.addRule': addRule,
  'taste.updateRule': updateRule,
  'taste.removeRule': removeRule,
  'taste.addReason': addReason,
  'taste.updateReason': updateReason,
  'taste.removeReason': removeReason,
  'taste.countReason': countReason,
  'taste.learnPatterns': learnPatterns,
  'taste.setPatternStatus': setPatternStatus,
} as const;
