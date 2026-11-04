import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommands } from '../commands/apply';
import { cmd } from '../commands/registry';
import { sampleWorld } from '../testing/sample';
import {
  acceptanceQuestions,
  buildSpec,
  changedSinceExport,
  exportCommands,
  exportPath,
  readExportHeader,
  selectForExport,
  slugify,
  withExportHeader,
} from './spec';

const ctx = { now: '2026-11-04T10:00:00.000Z' };

describe('choosing entities', () => {
  const w = sampleWorld();
  const decided = Object.values(w.entities).filter(
    (e) => e.state === 'decided' || e.state === 'exported',
  );

  it('nothing chosen, nothing selected', () => {
    expect(selectForExport(w, {})).toEqual([]);
  });

  it('by kind: only exportable entities of those kinds', () => {
    const r = selectForExport(w, { kinds: ['band'] });
    expect(r.length).toBeGreaterThan(0);
    for (const e of r)
      expect([e.kind, ['decided', 'exported'].includes(e.state)]).toEqual(['band', true]);
  });

  it('by band: entities placed in it (and the band itself)', () => {
    const r = selectForExport(w, { bands: ['low-sky', 'groundline'] });
    expect(r.map((e) => e.id)).toContain('groundline');
    expect(r.map((e) => e.id)).not.toContain('hollows');
  });

  it('hand-picked ids add to the rule, never a non-exportable one', () => {
    const idea = Object.values(w.entities).find((e) => e.state === 'idea');
    const r = selectForExport(w, { kinds: ['band'], ids: [decided[0]?.id ?? '', idea?.id ?? ''] });
    expect(r.map((e) => e.id)).toContain(decided[0]?.id);
    expect(r.map((e) => e.id)).not.toContain(idea?.id);
  });

  it('property: always exportable, unique and in a stable order', () => {
    const ids = Object.keys(w.entities);
    fc.assert(
      fc.property(
        fc.record({
          kinds: fc.subarray(['band', 'biome', 'item', 'capability', 'feat', 'material'] as const),
          bands: fc.subarray(['undercroft', 'hollows', 'groundline', 'low-sky', 'high-drift']),
          ids: fc.subarray(ids),
        }),
        (sel) => {
          const r = selectForExport(w, sel);
          expect(new Set(r.map((e) => e.id)).size).toBe(r.length);
          for (const e of r) expect(['decided', 'exported']).toContain(e.state);
          expect(selectForExport(w, sel)).toEqual(r);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('file names and the header', () => {
  it('slugs and unique paths', () => {
    expect(slugify('Low Sky: accessories!')).toBe('low-sky-accessories');
    expect(slugify('Élan  vital')).toBe('elan-vital');
    expect(slugify('***')).toBe('spec');
    const taken = new Set(['exports/2026-11-04-low-sky.md', 'exports/2026-11-04-low-sky-2.md']);
    expect(exportPath('2026-11-04', 'Low Sky', taken)).toBe('exports/2026-11-04-low-sky-3.md');
    expect(exportPath('2026-11-04', 'Other', taken)).toBe('exports/2026-11-04-other.md');
  });

  it('property: the header round-trips', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,12}$/)),
        fc.string(),
        (name, entities, body) => {
          const text = withExportHeader(body, { name, date: '2026-11-04', entities });
          expect(readExportHeader(text)).toEqual({ name, date: '2026-11-04', entities });
        },
      ),
    );
  });

  it('a file without carbon’s header is not an export record', () => {
    expect(readExportHeader('# just markdown')).toBeNull();
    expect(readExportHeader('---\nfoo: 1\n---\n')).toBeNull();
    expect(readExportHeader('---\n: [\n---\n')).toBeNull();
  });
});

describe('marking entities exported', () => {
  it('one transaction moves every decided entity to exported, and undoes as one', () => {
    const w = sampleWorld();
    const ids = Object.values(w.entities)
      .filter((e) => e.state === 'decided' || e.state === 'exported')
      .map((e) => e.id);
    const cmds = exportCommands(w, ids);
    expect(cmds.length).toBeGreaterThan(0);
    const r = applyCommands(w, cmds, ctx);
    if (!r.ok) throw new Error(r.error.message);
    for (const id of ids) expect(r.value.world.entities[id]?.state).toBe('exported');
    expect(exportCommands(r.value.world, ids)).toEqual([]);
  });

  it('flags entities edited after export', () => {
    const w = sampleWorld();
    const id = Object.values(w.entities).find((e) => e.state === 'decided')?.id ?? '';
    const r = applyCommands(
      w,
      [...exportCommands(w, [id]), cmd('entity.update', { id, set: { description: 'Changed.' } })],
      ctx,
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.world.entities[id]?.state).toBe('decided');
    expect(
      changedSinceExport(r.value.world, [{ name: 'x', date: 'd', entities: [id, 'gone'] }]).map(
        (e) => e.id,
      ),
    ).toEqual([id]);
  });
});

describe('the deterministic spec', () => {
  const w = sampleWorld();
  const ids = selectForExport(w, {
    kinds: ['band', 'biome', 'capability', 'item', 'feat', 'material', 'creature', 'structure'],
  }).map((e) => e.id);

  it('has a summary, each entity, its fields, relations and why, and acceptance questions', () => {
    const md = buildSpec(w, ids, { name: 'Sample set' });
    expect(md.startsWith('# Sample set\n\n## Summary\n')).toBe(true);
    for (const id of ids) {
      const e = w.entities[id];
      expect(md).toContain(`## ${e?.name ?? ''}`);
      if (e?.why) expect(md).toContain(`**Why:** ${e.why}`);
    }
    expect(md).toContain('## Acceptance questions');
    expect(md).toMatch(/- \[ \] /);
    expect(md).not.toMatch(/\n{3,}/);
  });

  it('is deterministic', () => {
    expect(buildSpec(w, ids, { name: 'x' })).toBe(buildSpec(sampleWorld(), ids, { name: 'x' }));
  });

  it('includes the formulas the entities’ attributes appear in', () => {
    const w2 = sampleWorld();
    const armor = Object.values(w2.entities).find((e) => e.kind === 'item');
    if (!armor) throw new Error('sample changed');
    w2.entities[armor.id] = { ...armor, attributes: { defense: 12 } };
    w2.numbers.formulas =
      'k = 100\ntaken(raw, def) = raw * k / (k + def)\nband_defense(b) = sum(items, .defense)\n# defense comment\n';
    // From the numbers engine: the formula that reads the attribute, not the others.
    const md = buildSpec(w2, [armor.id], { name: 'x' });
    expect(md).toContain('## Formulas\n\n```\nband_defense(b) = sum(items, .defense)\n```');
    expect(md).not.toContain('taken(raw, def)');
    // The numbers engine's answer wins when it has one (W3).
    expect(
      buildSpec(w2, [armor.id], {
        name: 'x',
        numbers: {
          formulaProblems: () => [],
          curveDeviations: () => [],
          dependencies: () => ['taken(raw, def) = …'],
        },
      }),
    ).toContain('taken(raw, def) = …');
  });

  it('asks about items’ change, trade-off, moment and route', () => {
    const w2 = sampleWorld();
    const item = Object.values(w2.entities).find((e) => e.kind === 'item');
    if (!item) throw new Error('sample changed');
    const e = {
      ...item,
      fields: {
        ...item.fields,
        change: 'You float.',
        tradeoff: 'You sink slower.',
        moment: 'Falling.',
        route: [{ text: 'Find it', needs: ['glide', 'missing'] }],
      },
    };
    const qs = acceptanceQuestions(w2, e);
    expect(qs).toContain(`With ${e.name}, does the game change like this: You float.?`);
    expect(qs).toContain(`Can a player get ${e.name} only by way of Glide, missing?`);
  });
});
