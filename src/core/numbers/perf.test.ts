import { describe, expect, it } from 'vitest';
import { applyCommands } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import { completions } from './complete';
import { NumbersEngine } from './engine';
import { schemaOf, type World } from '../model/world';

/**
 * The Numbers view evaluates the draft on every keystroke (review-b): on the
 * 2,000-entity stress world, one keystroke's re-analysis must fit a frame
 * (SYSTEM §9's 16 ms round trip is the budget we hold it to).
 */
const FORMULAS = [
  'taken(raw, def) = raw * k / (k + def)',
  'band_defense(b: band) = avg(items where subkind == "armor" and band == b, .defense)',
  'per_band = sum(bands, band_defense(it))',
  'mean_hit = avg(items where subkind == "armor", taken(20, .defense))',
  'hp = base_health * 2',
  ...Array.from({ length: 40 }, (_, i) => `c${i} = hp * ${i} + k`),
].join('\n');

function stress(): World {
  const bands = ['undercroft', 'hollows', 'groundline', 'low-sky', 'high-drift'];
  const commands: Command[] = [];
  for (let i = 0; i < 2000; i++)
    commands.push(
      cmd('entity.create', {
        kind: 'item',
        name: `Armor ${i}`,
        fields: { subkind: i % 3 === 0 ? 'weapon' : 'armor' },
        attributes: i % 3 === 0 ? { damage: i % 50 } : { defense: i % 40 },
        relations: [{ type: 'in_band', target: bands[i % bands.length] as string }],
      }),
    );
  commands.push(cmd('numbers.setFormulas', { source: FORMULAS }));
  const r = applyCommands(sampleWorld(), commands, { now: SAMPLE_TIME });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.world;
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1] ?? 0;

describe('a keystroke in the formula editor, on 2,000 entities', () => {
  const w = stress();
  const engine = new NumbersEngine();
  engine.update(w);

  it('typing a new constant re-analyses within a frame (median)', () => {
    const times: number[] = [];
    let text = FORMULAS;
    for (const ch of '\nprobe = per_band * 2 + hp') {
      text += ch;
      const t = performance.now();
      engine.update({ ...w, numbers: { ...w.numbers, formulas: text } });
      times.push(performance.now() - t);
    }
    expect(median(times)).toBeLessThan(16);
  });

  it('completion at the caret is well under a frame', () => {
    const a = engine.update(w);
    const opts = { schema: schemaOf(w), variables: w.numbers.variables };
    const times: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t = performance.now();
      completions(a, `${FORMULAS}\nx = ba`, FORMULAS.length + 7, opts);
      times.push(performance.now() - t);
    }
    expect(median(times)).toBeLessThan(8);
  });
});

describe('an entity change that no formula reads, on 2,000 entities', () => {
  it('costs well under a frame: the placement map is reused, nothing is re-evaluated', () => {
    let w = stress();
    const engine = new NumbersEngine();
    engine.update(w);
    // A creature: no formula here queries creatures or entities.
    const first = engine.update(w);
    const times: number[] = [];
    for (let i = 0; i < 40; i++) {
      const r = applyCommands(
        w,
        [cmd('entity.update', { id: 'moss-grazer', set: { identity: `changed ${i}` } })],
        { now: SAMPLE_TIME },
      );
      if (!r.ok) throw new Error(r.error.message);
      w = r.value.world;
      const t = performance.now();
      const a = engine.update(w);
      times.push(performance.now() - t);
      // The mechanism, deterministically: nothing re-evaluated, the placement
      // map and the analysis's definitions reused, only the world is new.
      expect(a.evaluated).toEqual([]);
      expect(a.internals.evalWorld.placement).toBe(first.internals.evalWorld.placement);
      expect(a.defs).toBe(first.defs);
      expect(a.internals.evalWorld.world).toBe(w);
    }
    // Measured alone: 3.4 ms median before review-b (the placement map rebuilt
    // and compared, and the analysis rebuilt, every time); about 0.9 ms after,
    // most of it one identity scan over the entities. Under the parallel test
    // run, only the frame budget is asserted.
    expect(median(times)).toBeLessThan(16);
  });
});
