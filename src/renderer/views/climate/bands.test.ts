import { describe, expect, it } from 'vitest';
import { applyCommands } from '@core/commands/apply';
import { cmd } from '@core/commands/registry';
import { sampleWorld } from '@core/testing/sample';
import { bandsOf, biomesInBand } from './bands';

const ctx = { now: '2026-11-05T00:00:00.000Z' };

describe('climate bands', () => {
  it('orders bands sky to depths, edgeless bands last', () => {
    const w = sampleWorld();
    const r = applyCommands(
      w,
      [cmd('entity.create', { kind: 'band', name: 'Aether', id: 'aether' })],
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    const ids = bandsOf(r.value.world).map((b) => b.id);
    expect(ids.at(-1)).toBe('aether');
    expect(ids.indexOf('high-drift')).toBeLessThan(ids.indexOf('undercroft'));
  });

  it('shows a biome made on an edgeless band on that band', () => {
    const w = sampleWorld();
    const r = applyCommands(
      w,
      [
        cmd('entity.create', { kind: 'band', name: 'Aether', id: 'aether' }),
        cmd('entity.create', {
          kind: 'biome',
          name: 'Mist',
          id: 'mist',
          fields: { band: 'aether' },
        }),
        cmd('entity.create', {
          kind: 'biome',
          name: 'Haze',
          id: 'haze',
          relations: [{ type: 'in_band', target: 'aether' }],
        }),
      ],
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(biomesInBand(r.value.world, 'aether')).toEqual(['haze', 'mist']);
    expect(biomesInBand(r.value.world, 'hollows')).toEqual(['ash-vents', 'glowmoss-caverns']);
  });
});
