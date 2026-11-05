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
    process.stderr.write(
      `keystroke re-analysis: median ${median(times).toFixed(2)} ms, max ${Math.max(...times).toFixed(2)} ms\n`,
    );
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
    process.stderr.write(`completion: median ${median(times).toFixed(2)} ms\n`);
    expect(median(times)).toBeLessThan(8);
  });
});
