import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '@core/commands/apply';
import type { Command } from '@core/commands/registry';
import { worldFromFiles, worldToFiles } from '@core/files/world-files';
import { imagesProblems } from '@core/images/commands';
import { IMAGE_ID_POOL, imageMetaArb } from '@core/testing/arbitraries';
import { sampleWorld } from '@core/testing/sample';
import { applyFileChanges } from '../store/apply-files';

/**
 * External edits of image files (by hand, or by Claude Code): applying only
 * the changed files gives the same world as reading every file again.
 */
const ctx = { now: '2026-11-05T01:00:00.000Z' };
const ENTITIES = ['glide', 'cinder-sting'];

function worldWithImages(adds: unknown[]) {
  let w = sampleWorld();
  for (const image of adds) {
    const r = applyCommand(
      w,
      { type: 'image.add', payload: { image, select: true } } as Command,
      ctx,
    );
    if (r.ok) w = r.value.world;
  }
  return w;
}

const changeArb = fc.oneof(
  // A new or rewritten metadata file (valid).
  imageMetaArb(ENTITIES).map((m) => {
    const meta = m as { id: string; entity: string };
    return [`images/${meta.entity}/${meta.id}.json`, `${JSON.stringify(m, null, 2)}\n`] as [
      string,
      string | null,
    ];
  }),
  // A selection file.
  fc
    .record({
      e: fc.constantFrom(...ENTITIES),
      c: fc.option(fc.constantFrom(...IMAGE_ID_POOL), { nil: undefined }),
      i: fc.option(fc.constantFrom(...IMAGE_ID_POOL), { nil: undefined }),
    })
    .map(
      ({ e, c, i }) =>
        [
          `images/${e}/selected.json`,
          JSON.stringify({ ...(c ? { concept: c } : {}), ...(i ? { icon: i } : {}) }),
        ] as [string, string | null],
    ),
  // A deleted file.
  fc
    .record({ e: fc.constantFrom(...ENTITIES), id: fc.constantFrom(...IMAGE_ID_POOL, 'selected') })
    .map(({ e, id }) => [`images/${e}/${id}.json`, null] as [string, string | null]),
);

describe('external edits of image files', () => {
  it('property: applying the changed files equals reading them all', () => {
    fc.assert(
      fc.property(
        fc.array(imageMetaArb(ENTITIES), { maxLength: 4 }),
        fc.array(changeArb, { minLength: 1, maxLength: 5 }),
        (adds, changes) => {
          const w = worldWithImages(adds);
          const ch = new Map(changes);
          const files = worldToFiles(w);
          for (const [p, c] of ch) {
            if (c === null) files.delete(p);
            else files.set(p, c);
          }
          const full = worldFromFiles(files);
          const inc = applyFileChanges(w, ch);
          // Invalid files differ by design (applying keeps the world's version); compare when all are valid.
          const bad = full.issues.filter((i) => i.code !== 'image.selection');
          fc.pre(bad.length === 0);
          expect(inc.world).toEqual(full.world);
          expect(imagesProblems(inc.world.images)).toEqual([]);
        },
      ),
      { numRuns: 400 },
    );
  });

  it('an invalid edit is not applied: the world keeps its version and reports it', () => {
    const [A] = IMAGE_ID_POOL;
    const w = worldWithImages([
      {
        id: A,
        entity: 'glide',
        kind: 'concept',
        origin: { by: 'fake', prompt: 'p', size: '1024x1024' },
        created: ctx.now,
        hashes: { output: 'a'.repeat(64) },
      },
    ]);
    const r = applyFileChanges(w, new Map([[`images/glide/${A}.json`, '{ broken']]));
    expect(r.world).toEqual(w);
    expect(r.issues.map((i) => i.code)).toEqual(['file.json']);
    const del = applyFileChanges(w, new Map([[`images/glide/${A}.json`, null]]));
    expect(del.world.images).toBeUndefined();
  });
});
