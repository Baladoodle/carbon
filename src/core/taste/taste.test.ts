import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FakeAiGateway } from '../ai/fake';
import type { Candidate } from '../ai/moments';
import { applyCommand, applyCommands } from '../commands/apply';
import { applyPatch } from '../commands/patch';
import { cmd, type Command } from '../commands/registry';
import type { World } from '../model/world';
import { makeSpread } from '../spreads/record';
import { killCommands, keepCommands } from '../spreads/triage';
import { MOVE_DEFS } from '../spreads/moves';
import { SAMPLE_TIME, sampleWorld } from '../testing/sample';
import { deepEqual } from '../util/json';
import { reasonOrder, ruleIdFor } from './commands';
import { activeRules, renderTaste, tasteContext, topPatterns } from './context';
import {
  judgedSinceRun,
  judgementCount,
  lastPatternsRun,
  mergePatterns,
  PATTERN_EVERY,
  patternId,
  patternsDue,
  patternsRequest,
} from './patterns';
import { buildPatternsPrompt, PATTERNS_TASK } from './prompt';

const ctx = { now: SAMPLE_TIME };
const run = (w: World, ...cs: Command[]): World => {
  const r = applyCommands(w, cs, ctx);
  if (!r.ok) throw new Error(r.error.message);
  expect(deepEqual(applyPatch(r.value.world, r.value.inverse), w)).toBe(true);
  return r.value.world;
};
const fails = (w: World, c: Command): string => {
  const r = applyCommand(w, c, ctx);
  if (r.ok) throw new Error('expected a failure');
  return r.error.code;
};

const cand = (i: number): Candidate => ({
  key: `c${i}`,
  kind: 'item',
  name: `Thing ${i}`,
  identity: `It does ${i}.`,
  fields: {},
  attributes: {},
  relations: [],
  position: { x: 0.5, y: 0.5 },
  wildcard: false,
});

/** A world with one spread of `n` candidates, the first `kills` killed with reason 1 and the rest kept. */
function judged(n: number, kills: number): World {
  let w = sampleWorld();
  const spread = makeSpread({
    id: 's',
    now: SAMPLE_TIME,
    request: {
      spot: { type: 'entity', entity: 'glide' },
      move: 'vary',
      count: 16,
      axes: MOVE_DEFS.vary.axes,
      ruleIds: [],
    },
    candidates: Array.from({ length: n }, (_, i) => cand(i + 1)),
    status: 'done',
  });
  w = run(w, cmd('spread.save', { record: spread }));
  for (let i = 1; i <= n; i++) {
    const t =
      i <= kills
        ? killCommands(w, spread, `c${i}`, '1', i === 1 ? 'meh' : undefined)
        : keepCommands(w, spread, `c${i}`);
    if (!t.ok) throw new Error(t.error.message);
    const r = applyCommands(w, t.value.commands, {
      now: `2026-11-01T12:00:${String(i).padStart(2, '0')}.000Z`,
    });
    if (!r.ok) throw new Error(r.error.message);
    w = r.value.world;
  }
  return w;
}

describe('taste commands', () => {
  it('adds, edits, switches and removes rules', () => {
    let w = sampleWorld();
    w = run(w, cmd('taste.addRule', { text: '  Every item changes a verb. ' }));
    const rule = w.taste.rules.at(-1);
    expect(rule).toEqual({
      id: 'rule-every-item-changes-a-verb',
      text: 'Every item changes a verb.',
      enabled: true,
    });
    expect(
      fails(w, cmd('taste.addRule', { text: 'x', id: 'rule-every-item-changes-a-verb' })),
    ).toBe('taste.rule_exists');
    expect(fails(w, cmd('taste.addRule', { text: '   ' }))).toBe('command.payload');
    w = run(w, cmd('taste.updateRule', { id: rule!.id, enabled: false }));
    expect(w.taste.rules.at(-1)?.enabled).toBe(false);
    w = run(w, cmd('taste.updateRule', { id: rule!.id, text: 'Items change verbs.' }));
    expect(w.taste.rules.at(-1)).toMatchObject({ text: 'Items change verbs.', enabled: false });
    w = run(w, cmd('taste.removeRule', { id: rule!.id }));
    expect(w.taste.rules.map((r) => r.id)).toEqual(['no-pure-numbers']);
    expect(fails(w, cmd('taste.updateRule', { id: 'x' }))).toBe('taste.no_rule');
    expect(fails(w, cmd('taste.removeRule', { id: 'x' }))).toBe('taste.no_rule');
    expect(ruleIdFor([{ id: 'rule-a', text: 'a', enabled: true }], 'A')).toBe('rule-a-2');
  });

  it('edits the kill-reason vocabulary and counts its use', () => {
    let w = sampleWorld();
    w = run(w, cmd('taste.addReason', { key: '8', label: 'too cute' }));
    expect(w.taste.reasons.map((r) => r.key)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '0',
    ]);
    expect(fails(w, cmd('taste.addReason', { key: '8', label: 'x' }))).toBe('taste.reason_exists');
    expect(fails(w, cmd('taste.addReason', { key: '10', label: 'x' }))).toBe('command.payload');
    w = run(w, cmd('taste.updateReason', { key: '8', label: 'twee' }));
    expect(w.taste.reasons.find((r) => r.key === '8')?.label).toBe('twee');
    w = run(w, cmd('taste.countReason', { key: '8', by: 2 }));
    expect(w.taste.reasons.find((r) => r.key === '8')?.count).toBe(2);
    expect(fails(w, cmd('taste.countReason', { key: '8', by: -3 }))).toBe('taste.count');
    expect(fails(w, cmd('taste.countReason', { key: '9', by: 1 }))).toBe('taste.no_reason');
    w = run(w, cmd('taste.removeReason', { key: '8' }));
    expect(fails(w, cmd('taste.removeReason', { key: '0' }))).toBe('taste.reason_other');
    expect(fails(w, cmd('taste.removeReason', { key: '9' }))).toBe('taste.no_reason');
    expect(fails(w, cmd('taste.updateReason', { key: '9', label: 'x' }))).toBe('taste.no_reason');
    expect(reasonOrder('0')).toBeGreaterThan(reasonOrder('9'));
  });

  it('learns, promotes and dismisses patterns', () => {
    let w = sampleWorld();
    w = run(
      w,
      cmd('taste.learnPatterns', {
        patterns: [
          { text: 'You keep movement.', examples: ['Glide', 'Glide'], strength: 0.7 },
          { text: 'You kill pure numbers.', examples: [], strength: 0.5 },
        ],
        judged: 25,
        at: SAMPLE_TIME,
      }),
    );
    expect(w.taste.patterns.map((p) => p.status)).toEqual(['proposed', 'proposed']);
    expect(w.taste.patterns[0]?.examples).toEqual(['Glide']);
    expect(lastPatternsRun(w)).toBe(25);
    const id = w.taste.patterns[0]!.id;
    w = run(
      w,
      cmd('taste.addRule', { text: 'You keep movement.', from: id }),
      cmd('taste.setPatternStatus', { id, status: 'promoted' }),
    );
    expect(w.taste.rules.at(-1)).toMatchObject({ text: 'You keep movement.', from: id });
    expect(w.taste.patterns[0]?.status).toBe('promoted');
    w = run(w, cmd('taste.setPatternStatus', { id: w.taste.patterns[1]!.id, status: 'dismissed' }));
    expect(fails(w, cmd('taste.setPatternStatus', { id: 'x', status: 'dismissed' }))).toBe(
      'taste.no_pattern',
    );
    // An update keeps the status; a dismissed pattern stays dismissed when restated.
    w = run(
      w,
      cmd('taste.learnPatterns', {
        patterns: [
          {
            text: 'You keep movement that changes a verb.',
            examples: ['Glide'],
            strength: 0.9,
            updates: id,
          },
          { text: 'you kill PURE numbers', examples: [], strength: 0.6 },
        ],
        judged: 50,
        at: SAMPLE_TIME,
      }),
    );
    expect(w.taste.patterns.map((p) => [p.text, p.status])).toEqual([
      ['You keep movement that changes a verb.', 'promoted'],
      ['you kill PURE numbers', 'dismissed'],
    ]);
  });
});

describe('patterns', () => {
  it('property: merging is deterministic and merging the same run twice changes nothing more', () => {
    const inArb = fc.array(
      fc.record({
        text: fc.constantFrom('A', 'B', 'b', 'C c', 'c-C', '  '),
        examples: fc.array(fc.constantFrom('x', 'y', 'z'), { maxLength: 8 }),
        strength: fc.double({ min: 0, max: 1, noNaN: true }),
      }),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(inArb, (incoming) => {
        const once = mergePatterns([], incoming, SAMPLE_TIME);
        expect(mergePatterns([], incoming, SAMPLE_TIME)).toEqual(once);
        const twice = mergePatterns(once, incoming, SAMPLE_TIME);
        expect(twice.map((p) => p.id)).toEqual(once.map((p) => p.id));
        expect(new Set(once.map((p) => p.id)).size).toBe(once.length);
        for (const p of once) expect(p.examples.length).toBeLessThanOrEqual(6);
      }),
    );
    expect(patternId('A b', new Set())).toBe(patternId('a-B', new Set()));
    const taken = new Set([patternId('A', new Set())]);
    expect(patternId('A', taken)).toBe(`${patternId('A', new Set())}-2`);
  });

  it('counts judgements and is due every 25', () => {
    expect(judgementCount(sampleWorld())).toBe(0);
    expect(patternsRequest(sampleWorld())).toBeNull();
    const w = judged(PATTERN_EVERY, 10);
    expect(judgementCount(w)).toBe(25);
    expect(patternsDue(w)).toBe(true);
    expect(patternsDue(judged(24, 3))).toBe(false);
    const after = run(w, cmd('taste.learnPatterns', { patterns: [], judged: 25, at: SAMPLE_TIME }));
    expect(judgedSinceRun(after)).toBe(0);
    expect(patternsDue(after)).toBe(false);
    // A lower total after a removed spread clamps at zero.
    const removed = run(after, cmd('spread.remove', { id: 's' }));
    expect(judgedSinceRun(removed)).toBe(0);
    const req = patternsRequest(w, 5);
    expect(req?.judgements).toHaveLength(5);
    expect(req?.judgements.at(-1)).toEqual({
      candidate: { name: 'Thing 25', identity: 'It does 25.', kind: 'item' },
      verdict: 'keep',
    });
    expect(patternsRequest(w)?.judgements[0]).toEqual({
      candidate: { name: 'Thing 1', identity: 'It does 1.', kind: 'item' },
      verdict: 'kill',
      reason: 'just a number: meh',
    });
  });

  it('builds the patterns prompt, and the fake answer merges cleanly', async () => {
    const w = judged(12, 6);
    const req = patternsRequest(w)!;
    const p = buildPatternsPrompt(w, req);
    expect(Object.keys(p)).toEqual(['system', 'digest', 'taste', 'focus', 'task']);
    expect(p.focus).toContain('- KILL Thing 1 (item): It does 1. — reason: just a number: meh');
    expect(p.focus).toContain('- KEEP Thing 12');
    expect(p.task).toBe(PATTERNS_TASK);
    const out = await new FakeAiGateway({ getWorld: () => w }).run('patterns', req);
    if (!out.ok) throw new Error(out.error.message);
    const next = run(
      w,
      cmd('taste.learnPatterns', { patterns: out.result.patterns, judged: 12, at: SAMPLE_TIME }),
    );
    expect(next.taste.patterns.length).toBe(out.result.patterns.length);
    const withOld = run(
      next,
      cmd('taste.setPatternStatus', { id: next.taste.patterns[0]!.id, status: 'dismissed' }),
    );
    expect(buildPatternsPrompt(withOld, req).focus).toContain('Dismissed by the designer');
  });
});

describe('taste in requests', () => {
  it('collects active rules, top patterns and kill examples', () => {
    let w = judged(8, 5);
    w = run(
      w,
      cmd('taste.addRule', { text: 'Off rule.' }),
      cmd('taste.learnPatterns', {
        patterns: [
          { text: 'Weak.', examples: [], strength: 0.1 },
          { text: 'Strong.', examples: ['a', 'b', 'c', 'd'], strength: 0.9 },
          { text: 'Gone.', examples: [], strength: 1 },
        ],
        judged: 8,
        at: SAMPLE_TIME,
      }),
    );
    const off = w.taste.rules.at(-1)!.id;
    w = run(w, cmd('taste.updateRule', { id: off, enabled: false }));
    const weak = w.taste.patterns.find((p) => p.text === 'Weak.')!;
    w = run(
      w,
      cmd('taste.setPatternStatus', { id: weak.id, status: 'promoted' }),
      cmd('taste.setPatternStatus', {
        id: w.taste.patterns.find((p) => p.text === 'Gone.')!.id,
        status: 'dismissed',
      }),
    );
    expect(activeRules(w.taste).map((r) => r.id)).toEqual(['no-pure-numbers']);
    expect(activeRules(w.taste, [off, 'ghost']).map((r) => r.id)).toEqual([off]);
    expect(topPatterns(w.taste).map((p) => p.text)).toEqual(['Weak.', 'Strong.']);
    const t = tasteContext(w);
    expect(t.kills).toEqual([
      { key: '1', label: 'just a number', count: 5, examples: ['Thing 5', 'Thing 4', 'Thing 3'] },
    ]);
    expect(t.patterns[1]?.examples).toEqual(['a', 'b', 'c']);
    const text = renderTaste(t);
    expect(text).toContain('- [no-pure-numbers] Nothing is just a bigger number.');
    expect(text).toContain('- Weak. (confirmed)');
    expect(text).toContain('- just a number (5×): Thing 5, Thing 4, Thing 3');
    expect(text).not.toContain('Gone.');
    expect(renderTaste({ rules: [], patterns: [], kills: [] })).toBe(
      '<taste>\nNo rules or patterns yet.\n</taste>',
    );
  });
});
