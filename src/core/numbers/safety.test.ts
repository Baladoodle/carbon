import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import { sampleWorld, SAMPLE_TIME } from '../testing/sample';
import { NumbersEngine, analyzeNumbers } from './engine';

describe('safety', () => {
  it('the engine never uses eval or Function', () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/);
    }
  });
});

describe('scale', () => {
  it('2,000 entities: a full analysis is fast and a variable change re-evaluates only its dependents', () => {
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
    commands.push(
      cmd('numbers.setFormulas', {
        source: [
          'taken(raw, def) = raw * k / (k + def)',
          'band_defense(b: band) = avg(items where subkind == "armor" and band == b, .defense)',
          'per_band = sum(bands, band_defense(it))',
          'mean_hit = avg(items where subkind == "armor", taken(20, .defense))',
          'hp = base_health * 2',
        ].join('\n'),
      }),
    );
    const r = applyCommands(sampleWorld(), commands, { now: SAMPLE_TIME });
    if (!r.ok) throw new Error(r.error.message);
    const w = r.value.world;
    const t0 = performance.now();
    const engine = new NumbersEngine();
    const a = engine.update(w);
    const full = performance.now() - t0;
    expect(a.diagnostics).toEqual([]);
    expect(typeof a.value('per_band')).toBe('number');
    expect(full).toBeLessThan(2000);
    const r2 = applyCommands(w, [cmd('numbers.setVariable', { name: 'base_health', value: 120 })], {
      now: SAMPLE_TIME,
    });
    if (!r2.ok) throw new Error(r2.error.message);
    const t1 = performance.now();
    const b = engine.update(r2.value.world);
    const incremental = performance.now() - t1;
    expect(b.evaluated).toEqual(['hp']);
    expect(incremental).toBeLessThan(full);
    expect(analyzeNumbers(r2.value.world).value('hp')).toBe(240);
  });
});
