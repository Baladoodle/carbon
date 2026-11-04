import { describe, expect, it } from 'vitest';
import { MOVES, type Spot } from '../ai/moments';
import { applyCommands } from '../commands/apply';
import { cmd } from '../commands/registry';
import { EntitySchema } from '../model/entity';
import type { World } from '../model/world';
import { SAMPLE_TIME, sampleWorld } from '../testing/sample';
import { MOVE_DEFS } from './moves';
import {
  buildSpreadPrompt,
  estimateTokens,
  LIMITS,
  neighbours,
  promptTokens,
  renderKind,
  worldDigest,
} from './prompt';
import { checkSpot } from './spot';

const SPOTS: Spot[] = [
  { type: 'cell', band: 'low-sky', lane: 'items' },
  {
    type: 'region',
    band: 'hollows',
    climate: { temperature: { min: 0, max: 0.3 }, moisture: { min: 0, max: 0.4 } },
  },
  { type: 'entity', entity: 'cloud-anklet' },
  { type: 'selection', entities: ['glide', 'reef-ray'] },
  { type: 'note', note: 'The sky is too safe', entities: ['low-sky'] },
];

function bigWorld(n: number): World {
  const w = sampleWorld();
  const kinds = ['material', 'creature', 'item', 'structure', 'capability', 'feat'] as const;
  for (let i = 0; i < n; i++) {
    const kind = kinds[i % kinds.length]!;
    const id = `${kind}-${i}`;
    w.entities[id] = EntitySchema.parse({
      id,
      kind,
      name: `${kind} number ${i} with a long and descriptive name`,
      identity:
        'A deliberately long identity line that goes on for a while to stress the prompt budget.'.repeat(
          3,
        ),
      description: 'x'.repeat(2000),
      fields: kind === 'item' ? { subkind: 'tool' } : {},
      relations: [{ type: 'in_band', target: i % 2 ? 'low-sky' : 'hollows' }],
      created: SAMPLE_TIME,
      updated: SAMPLE_TIME,
    });
  }
  return w;
}

describe('spread prompt builder', () => {
  it('builds all nine moves for every spot they accept, in the SYSTEM.md §8 order', () => {
    const w = sampleWorld();
    let built = 0;
    for (const spot of SPOTS)
      for (const move of MOVES) {
        if (!checkSpot(w, spot, move).ok) continue;
        const p = buildSpreadPrompt(w, { spot, move, count: 10, direction: 'make it hurt' });
        expect(Object.keys(p)).toEqual(['system', 'digest', 'taste', 'focus', 'task']);
        expect(p.task).toContain(`Move: ${MOVE_DEFS[move].label}.`);
        expect(p.task).toContain(MOVE_DEFS[move].instructions);
        expect(p.focus).toContain('Direction from the designer: make it hurt');
        // The diversity contract closes the prompt.
        const contract = p.task.slice(p.task.indexOf('Diversity contract:'));
        expect(contract).toContain('Exactly 10 candidates.');
        expect(contract).toContain('"wildcard": true');
        expect(contract).toContain('ignores the taste block');
        expect(contract).toContain('No two candidates share a verb');
        expect(p.task.trimEnd().endsWith('</task>')).toBe(true);
        expect(p.task.indexOf('Diversity contract:')).toBeGreaterThan(p.task.indexOf('Field axes'));
        built++;
      }
    expect(built).toBe(23);
  });

  it('is deterministic and stable in its slow parts', () => {
    const w = sampleWorld();
    const req = { spot: SPOTS[0]!, move: 'fill' as const };
    expect(buildSpreadPrompt(w, req)).toEqual(buildSpreadPrompt(sampleWorld(), req));
    const other = buildSpreadPrompt(w, { spot: SPOTS[2]!, move: 'vary' });
    const one = buildSpreadPrompt(w, req);
    expect(other.system).toBe(one.system);
    expect(other.digest).toBe(one.digest);
    expect(other.taste).toBe(one.taste);
  });

  it('says what the candidates become', () => {
    const w = sampleWorld();
    expect(buildSpreadPrompt(w, { spot: SPOTS[0]!, move: 'fill' }).task).toContain(
      'a new item: kind "item"',
    );
    expect(buildSpreadPrompt(w, { spot: SPOTS[2]!, move: 'ground' }).task).toContain(
      '"about" to its id (one of: cloud-anklet)',
    );
    expect(buildSpreadPrompt(w, { spot: SPOTS[2]!, move: 'break' }).task).toContain('kind null');
  });

  it('uses the chosen axes, the per-spread rules and a packed digest', () => {
    const w = sampleWorld();
    const axes = {
      x: { label: 'menace', low: 'gentle', high: 'menacing' },
      y: { label: 'scale', low: 'small', high: 'vast' },
    };
    const p = buildSpreadPrompt(
      w,
      { spot: SPOTS[0]!, move: 'fill', axes },
      { digest: '<world>packed</world>' },
    );
    expect(p.task).toContain('x = menace (0 gentle → 1 menacing); y = scale (0 small → 1 vast)');
    expect(p.digest).toBe('<world>packed</world>');
    expect(p.taste).toContain('[no-pure-numbers] Nothing is just a bigger number.');
    const off = buildSpreadPrompt(w, { spot: SPOTS[0]!, move: 'fill', ruleIds: [] });
    expect(off.taste).not.toContain('no-pure-numbers');
    expect(buildSpreadPrompt(w, { spot: SPOTS[0]!, move: 'fill' }, { digest: 'x' }).task).toContain(
      `x = ${MOVE_DEFS.fill.axes.x.label}`,
    );
  });

  it('grounds the focus in the spot', () => {
    const w = sampleWorld();
    const cell = buildSpreadPrompt(w, { spot: SPOTS[0]!, move: 'fill' });
    expect(cell.focus).toContain('the items lane of the band Low Sky [low-sky]');
    expect(cell.focus).toContain('<entity id="low-sky" kind="band"');
    expect(cell.focus).toContain('Cloud Anklet [cloud-anklet]');
    expect(cell.focus).toContain('<kind name="item">');
    const region = buildSpreadPrompt(w, { spot: SPOTS[1]!, move: 'fill' });
    expect(region.focus).toContain('Glowmoss Caverns [glowmoss-caverns] climate');
    const ent = buildSpreadPrompt(w, { spot: SPOTS[2]!, move: 'vary' });
    expect(ent.focus).toContain('<entity id="cloud-anklet"');
    expect(ent.focus).not.toContain('- Cloud Anklet [cloud-anklet]');
    expect(worldDigest(w)).toMatch(
      /Undercroft[\s\S]*Hollows[\s\S]*Groundline[\s\S]*Low Sky[\s\S]*High Drift/,
    );
    expect(renderKind(w, 'item')).toContain(
      'field subkind (enum one of armor | accessory | tool | weapon | consumable)',
    );
    expect(neighbours(w, { type: 'cell', band: 'hollows', lane: 'items' }, 'item')[0]?.id).toBe(
      'spore-lantern',
    );
    expect(neighbours(w, SPOTS[0]!, 'item')[0]?.kind).toBe('biome'); // nothing of the kind in Low Sky yet
  });

  it('stays far under 100k tokens on a world of 2,000 entities', () => {
    const w = bigWorld(2000);
    for (const spot of SPOTS)
      for (const move of MOVES) {
        if (!checkSpot(w, spot, move).ok) continue;
        const p = buildSpreadPrompt(w, { spot, move, direction: 'y'.repeat(300) });
        expect(promptTokens(p)).toBeLessThan(30_000);
      }
    expect(worldDigest(w)).toContain('more');
    expect(neighbours(w, SPOTS[0]!, 'item')).toHaveLength(LIMITS.neighbours);
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('includes taste that changes as you judge', () => {
    const w = sampleWorld();
    const r = applyCommands(
      w,
      [
        cmd('taste.addRule', { text: 'Every item changes a verb.' }),
        cmd('taste.learnPatterns', {
          patterns: [
            { text: 'You keep movement over damage.', examples: ['Glide'], strength: 0.8 },
          ],
          judged: 0,
          at: SAMPLE_TIME,
        }),
      ],
      { now: SAMPLE_TIME },
    );
    if (!r.ok) throw new Error(r.error.message);
    const p = buildSpreadPrompt(r.value.world, { spot: SPOTS[0]!, move: 'fill' });
    expect(p.taste).toContain('Every item changes a verb.');
    expect(p.taste).toContain('You keep movement over damage. e.g. Glide');
  });
});
