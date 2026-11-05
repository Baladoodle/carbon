import { describe, expect, it } from 'vitest';
import { applyCommand, applyCommands } from '../commands/apply';
import { cmd, type Command } from '../commands/registry';
import { runChecks } from '../checks/runner';
import { bandSpans } from '../checks/placement';
import { entityToMarkdown } from '../files/entity-file';
import { worldFromFiles, worldToFiles } from '../files/world-files';
import { sampleWorld } from '../testing/sample';
import { deepFreeze } from '../util/json';
import { EntitySchema, type Entity } from './entity';
import { BAND_INVERTED, TOLERATED_ON_LOAD, validateWorld, entityProblems } from './validate';
import { getEntity, schemaOf, type World } from './world';

/**
 * A band's bottom edge must lie strictly below its top edge (both set). An
 * inverted (or zero-height) band is an error: commands refuse to make one. A
 * file on disk with one still loads (it is the user's file): the band is kept,
 * treated as edgeless by placement, the Column and Climate, and named by a
 * mechanical check so the user knows why it has no place.
 */

const ctx = { now: '2026-11-05T10:00:00.000Z' };
const base = (): World => deepFreeze(sampleWorld());

/** The sample world with one band's edges replaced directly (as a hand edit would). */
function withEdges(id: string, bottom: unknown, top: unknown): World {
  const w = structuredClone(sampleWorld());
  const e = w.entities[id] as Entity;
  const fields: Record<string, unknown> = { ...e.fields, y_bottom: bottom, y_top: top };
  for (const k of ['y_bottom', 'y_top']) if (fields[k] === undefined) delete fields[k];
  w.entities[id] = { ...e, fields };
  return w;
}

const codes = (w: World): string[] => validateWorld(w).map((p) => `${p.severity}:${p.code}`);
const fail = (w: World, c: Command | Command[]): string => {
  const r = Array.isArray(c) ? applyCommands(w, c, ctx) : applyCommand(w, c, ctx);
  if (r.ok) throw new Error('expected the command to be refused');
  return `${r.error.code}: ${r.error.message}`;
};

describe('band edges: the rule', () => {
  it('flags a band whose bottom is above its top as an error', () => {
    const w = withEdges('low-sky', 640, 96);
    expect(codes(w)).toEqual([`error:${BAND_INVERTED}`]);
    expect(validateWorld(w)[0]?.message).toMatch(/bottom \(640\) .*top \(96\)/);
  });

  it('flags a zero-height band, and the endless ends the wrong way round', () => {
    expect(codes(withEdges('low-sky', 300, 300))).toEqual([`error:${BAND_INVERTED}`]);
    expect(codes(withEdges('low-sky', '+inf', 700))).toEqual([`error:${BAND_INVERTED}`]);
    expect(codes(withEdges('low-sky', 0, '-inf'))).toEqual([`error:${BAND_INVERTED}`]);
    expect(codes(withEdges('low-sky', '-inf', '-inf'))).toEqual([`error:${BAND_INVERTED}`]);
  });

  it('accepts ordered, endless and half-written bands', () => {
    expect(codes(withEdges('low-sky', 96, 700))).toEqual([]);
    expect(codes(withEdges('low-sky', '-inf', '+inf'))).toEqual([]);
    expect(codes(withEdges('low-sky', undefined, 96))).toEqual([]);
    expect(codes(withEdges('low-sky', 640, undefined))).toEqual([]);
  });

  it('is a load-tolerated error, kept apart from the shape errors', () => {
    expect(TOLERATED_ON_LOAD.has(BAND_INVERTED)).toBe(true);
    // Only bands carry edges; other kinds don't get the check.
    const w = sampleWorld();
    for (const e of Object.values(w.entities))
      if (e.kind !== 'band')
        expect(entityProblems(schemaOf(w), e).some((p) => p.code === BAND_INVERTED)).toBe(false);
  });
});

describe('band edges: commands refuse to invert a band', () => {
  it('entity.setField refuses a bottom above the top, or a top below the bottom', () => {
    // low-sky is 96..640.
    expect(
      fail(base(), cmd('entity.setField', { id: 'low-sky', field: 'y_bottom', value: 700 })),
    ).toMatch(/^world\.invalid: .*bottom \(700\) .*top \(640\)/);
    expect(
      fail(base(), cmd('entity.setField', { id: 'low-sky', field: 'y_top', value: 96 })),
    ).toMatch(/^world\.invalid/);
    expect(
      fail(base(), cmd('entity.setField', { id: 'low-sky', field: 'y_top', value: '-inf' })),
    ).toMatch(/^world\.invalid/);
  });

  it('entity.update refuses both edges at once the wrong way round', () => {
    expect(
      fail(base(), cmd('entity.update', { id: 'low-sky', set: { y_bottom: 900, y_top: 100 } })),
    ).toMatch(/^world\.invalid/);
  });

  it('entity.create refuses an inverted band', () => {
    expect(
      fail(
        base(),
        cmd('entity.create', { kind: 'band', name: 'Flip', fields: { y_bottom: 5, y_top: 1 } }),
      ),
    ).toMatch(/^world\.invalid/);
  });

  it('still allows a valid move of both edges, and clearing one', () => {
    const r = applyCommand(
      base(),
      cmd('entity.update', { id: 'low-sky', set: { y_bottom: 800, y_top: 900 } }),
      ctx,
    );
    expect(r.ok).toBe(true);
    const cleared = applyCommand(
      base(),
      cmd('entity.setField', { id: 'low-sky', field: 'y_bottom', value: null }),
      ctx,
    );
    expect(cleared.ok).toBe(true);
  });

  it("doesn't block unrelated edits of a band that was inverted on disk, and lets one edit fix it", () => {
    const w = deepFreeze(withEdges('low-sky', 640, 96));
    expect(
      applyCommand(w, cmd('entity.update', { id: 'low-sky', set: { name: 'Lo' } }), ctx).ok,
    ).toBe(true);
    // Fixing it with one edge is fine…
    const fixed = applyCommand(
      w,
      cmd('entity.setField', { id: 'low-sky', field: 'y_top', value: 700 }),
      ctx,
    );
    expect(fixed.ok).toBe(true);
    if (fixed.ok) expect(codes(fixed.value.world)).toEqual([]);
    // …but an edit that leaves it inverted another way is a new error, refused.
    expect(
      fail(w, cmd('entity.setField', { id: 'low-sky', field: 'y_bottom', value: 500 })),
    ).toMatch(/^world\.invalid/);
  });
});

describe('band edges: files on disk', () => {
  const filesWith = (bottom: unknown, top: unknown): Map<string, string> => {
    const files = worldToFiles(sampleWorld());
    const e = EntitySchema.parse({
      ...getEntity(sampleWorld(), 'low-sky'),
      fields: { ...getEntity(sampleWorld(), 'low-sky')!.fields, y_bottom: bottom, y_top: top },
    });
    files.set('entities/band/low-sky.md', entityToMarkdown(e));
    return files;
  };

  it('loads an inverted band instead of rejecting the file, and keeps it edgeless', () => {
    const { world, issues } = worldFromFiles(filesWith(640, 96));
    expect(issues).toEqual([]);
    const e = getEntity(world, 'low-sky');
    expect(e?.fields.y_bottom).toBe(640);
    expect(e?.fields.y_top).toBe(96);
    // The fallback: no span anywhere.
    expect(bandSpans(world).some((s) => s.id === 'low-sky')).toBe(false);
  });

  it('still rejects other errors in the same file', () => {
    const files = filesWith(640, 96);
    files.set(
      'entities/band/low-sky.md',
      (files.get('entities/band/low-sky.md') ?? '').replace('y_bottom: 640', 'y_bottom: high'),
    );
    const { world, issues } = worldFromFiles(files);
    expect(issues.map((i) => i.code)).toEqual(['file.invalid']);
    expect(getEntity(world, 'low-sky')).toBeUndefined();
  });
});

describe('band edges: the mechanical check', () => {
  it('names an inverted band, and only that', () => {
    const notes = runChecks(withEdges('low-sky', 640, 96));
    const inverted = notes.filter((n) => n.kind === 'band-inverted');
    expect(inverted).toHaveLength(1);
    expect(inverted[0]).toMatchObject({ severity: 'error', entities: ['low-sky'] });
    expect(inverted[0]?.text).toMatch(/Low Sky.*bottom \(640\).*top \(96\)/);
    expect(runChecks(sampleWorld()).some((n) => n.kind === 'band-inverted')).toBe(false);
  });

  it('leaves an inverted band out of the band-based checks (no overlap, no empty lane over it)', () => {
    const notes = runChecks(withEdges('low-sky', 640, 96));
    const about = notes.filter((n) => n.kind !== 'band-inverted' && n.entities.includes('low-sky'));
    expect(about.map((n) => n.kind)).not.toContain('band-overlap');
    expect(about.map((n) => n.kind)).not.toContain('lane-empty');
  });
});

describe('band edges: AI proposals', () => {
  it('suggest one drops an edge that would invert the band (the command would refuse it)', async () => {
    const { suggestOneBuilder } = await import('../prompts/suggest');
    const world = sampleWorld(); // low-sky is 96..640
    const req = { entityId: 'low-sky', field: 'y_bottom', avoid: [] };
    expect(suggestOneBuilder.parse({ suggestion: { value: 700 } }, world, req)).toMatchObject({
      ok: false,
    });
    expect(suggestOneBuilder.parse({ suggestion: { value: 200 } }, world, req)).toMatchObject({
      ok: true,
    });
  });

  it('fill drops the later of two edges that cross, and keeps each edge that fits alone', async () => {
    const { fillBuilder } = await import('../prompts/fill');
    const w = withEdges('low-sky', undefined, undefined);
    const r = fillBuilder.parse(
      { proposals: { y_bottom: { value: 500 }, y_top: { value: 100 } } },
      w,
      { entityId: 'low-sky' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.result.proposals.map((p) => p.field)).toEqual(['y_bottom']);
      expect(r.value.dropped).toBe(1);
    }
  });

  it("the fake gateway's fill proposes edges in order on a band without any", async () => {
    const { FakeAiGateway } = await import('../ai/fake');
    const w = withEdges('low-sky', undefined, undefined);
    const g = new FakeAiGateway({ getWorld: () => w });
    const out = await g.run('fill_entity', { entityId: 'low-sky' });
    if (!out.ok) throw new Error(out.error.message);
    const by = Object.fromEntries(out.result.proposals.map((p) => [p.field, p.value]));
    expect(typeof by.y_bottom).toBe('number');
    expect(typeof by.y_top).toBe('number');
    expect(by.y_bottom as number).toBeLessThan(by.y_top as number);
  });
});
