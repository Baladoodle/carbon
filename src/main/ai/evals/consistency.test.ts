import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONSISTENCY_CASES,
  consistencyMetric,
  consistencyWorld,
  fixtureAnswerer,
  loadConsistencyFixtures,
  noteField,
  runConsistency,
  type ConsistencyRun,
} from './consistency';

const DIR = path.resolve(import.meta.dirname, '../../../../evals/fixtures/consistency');
const fixtures = loadConsistencyFixtures(DIR);

describe('the self-consistency eval (fill, then critique)', () => {
  it('has a fixture for every case', () => {
    for (const c of CONSISTENCY_CASES) expect(fixtures.has(c.entityId), c.id).toBe(true);
  });

  it('reproduces the reported conflict without the quality bar’s self-check', async () => {
    const runs = await runConsistency(
      consistencyWorld(),
      CONSISTENCY_CASES,
      fixtureAnswerer(fixtures, { selfCheck: false }),
    );
    expect(runs.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    const charm = runs.find((r) => r.case.entityId === 'thermal-charm')!;
    expect(charm.filled).toContain('identity');
    expect(charm.notes).toEqual([{ kind: 'just_a_number', field: 'identity' }]);
    const m = consistencyMetric(runs);
    expect(m.value).toBe(0.5);
    expect(m.pass).toBe(false);
    expect(m.detail).toContain('consistency-thermal-charm: just_a_number on identity');
  });

  it('passes with it: the pure-number identity is dropped and counted, not critiqued', async () => {
    const runs = await runConsistency(
      consistencyWorld(),
      CONSISTENCY_CASES,
      fixtureAnswerer(fixtures),
    );
    expect(runs.filter((r) => !r.ok).map((r) => r.error)).toEqual([]);
    const charm = runs.find((r) => r.case.entityId === 'thermal-charm')!;
    expect(charm.dropped).toBe(1);
    expect(charm.filled).not.toContain('identity');
    expect(charm.filled).toEqual(['description', 'slot', 'change', 'tradeoff']);
    const m = consistencyMetric(runs);
    expect(m.value).toBe(0);
    expect(m.pass).toBe(true);
    expect(m.detail).toMatch(/^0 of 2 notes on just-filled fields, over 3 fills/);
  });

  it('a missing fixture fails the case, and a failed case fails the metric', async () => {
    const runs = await runConsistency(
      consistencyWorld(),
      [{ id: 'x', entityId: 'glide' }],
      fixtureAnswerer(fixtures),
    );
    expect(runs[0]).toMatchObject({ ok: false, error: 'fill: no fixture' });
    expect(consistencyMetric(runs)).toMatchObject({ value: null, pass: null });
    const ok: ConsistencyRun = {
      case: { id: 'a', entityId: 'a' },
      ok: true,
      filled: ['identity'],
      dropped: 0,
      notes: [],
      costUsd: 0,
    };
    expect(consistencyMetric([ok])).toMatchObject({ value: 0, pass: true });
    expect(consistencyMetric([ok, { ...runs[0]!, filled: [] }]).pass).toBe(false);
    const tenth: ConsistencyRun = {
      ...ok,
      notes: [
        { kind: 'weak_identity' },
        ...Array.from({ length: 9 }, () => ({ kind: 'duplicate' as const })),
      ],
    };
    expect(consistencyMetric([tenth])).toMatchObject({ value: 0.1, pass: true });
  });

  it('a weak identity note is about the identity field', () => {
    expect(noteField({ kind: 'weak_identity' })).toBe('identity');
    expect(noteField({ kind: 'just_a_number', field: 'change' })).toBe('change');
    expect(noteField({ kind: 'duplicate' })).toBeUndefined();
  });
});
