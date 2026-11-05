import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { applyCommand } from '../commands/apply';
import { applyPatch } from '../commands/patch';
import type { Command } from '../commands/registry';
import { filesForPatch, worldFromFiles, worldToFiles } from '../files/world-files';
import { validateWorld } from '../model/validate';
import type { World } from '../model/world';
import { IMAGE_ID_POOL, imageIdArb, imageMetaArb } from '../testing/arbitraries';
import { sampleWorld } from '../testing/sample';
import { imagesProblems } from './commands';
import { entityImageFiles, imageFilesOf, imagesFromFiles } from './files';
import { ImageMetaSchema, type ImageMeta } from './model';
import { exportImages, imagesSection } from './export';
import { costNanos, estimateNanos, imageSettings, OUTPUT_TOKENS } from './pricing';
import { imagePromptAsk, paletteWords } from './prompt';

const ctx = { now: '2026-11-05T01:00:00.000Z' };
const ENTITIES = ['glide', 'cinder-sting'] as const;

const meta = (id: string, entity: string, kind: 'concept' | 'icon', from?: string): ImageMeta => ({
  id,
  entity,
  kind,
  origin: from
    ? { by: 'filter', from, preset: 'item' }
    : {
        by: 'openai',
        model: 'gpt-image-2.6-flare',
        quality: 'low',
        size: '1024x1024',
        prompt: 'p',
      },
  created: ctx.now,
  hashes: { output: 'a'.repeat(64) },
});

/** Image commands only, over a small pool so they interact. */
const imageCommandArb: fc.Arbitrary<Command> = fc.oneof(
  fc
    .record({ image: imageMetaArb([...ENTITIES]), select: fc.boolean() })
    .map((payload) => ({ type: 'image.add', payload }) as Command),
  fc
    .record({ entity: fc.constantFrom(...ENTITIES), image: imageIdArb })
    .map((payload): Command => ({ type: 'image.select', payload })),
  fc
    .record({ entity: fc.constantFrom(...ENTITIES), kind: fc.constantFrom('concept', 'icon') })
    .map((payload): Command => ({ type: 'image.unselect', payload })),
  fc
    .record({ entity: fc.constantFrom(...ENTITIES), image: imageIdArb })
    .map((payload): Command => ({ type: 'image.remove', payload })),
  fc.constant<Command>({ type: 'entity.delete', payload: { id: 'glide' } }),
);

function run(world: World, cmds: Command[]): { world: World; applied: number; steps: World[] } {
  let w = world;
  let applied = 0;
  const steps: World[] = [w];
  for (const c of cmds) {
    const r = applyCommand(w, c, ctx);
    if (!r.ok) continue;
    // Every applied command's inverse restores the world before it, exactly.
    expect(applyPatch(r.value.world, r.value.inverse)).toEqual(w);
    w = r.value.world;
    applied++;
    steps.push(w);
  }
  return { world: w, applied, steps };
}

describe('image commands (properties)', () => {
  it('keep world.images canonical and valid, and every inverse is exact', () => {
    let total = 0;
    fc.assert(
      fc.property(fc.array(imageCommandArb, { maxLength: 25 }), (cmds) => {
        const r = run(sampleWorld(), cmds);
        total += r.applied;
        for (const w of r.steps) {
          expect(imagesProblems(w.images)).toEqual([]);
          expect(validateWorld(w).filter((p) => p.severity === 'error')).toEqual([]);
        }
      }),
      { numRuns: 300 },
    );
    expect(total).toBeGreaterThan(500);
  });

  it('files: save then load gives back the world, and patches write exactly the changed files', () => {
    fc.assert(
      fc.property(fc.array(imageCommandArb, { maxLength: 20 }), (cmds) => {
        const start = sampleWorld();
        let w = start;
        const files = worldToFiles(w);
        for (const c of cmds) {
          const r = applyCommand(w, c, ctx);
          if (!r.ok) continue;
          const ch = filesForPatch(w, r.value.world, r.value.patch);
          for (const p of ch.remove) files.delete(p);
          for (const [p, t] of ch.write) files.set(p, t);
          w = r.value.world;
          // Applying only the patch's files gives the same files as a full write.
          expect(new Map([...files].sort())).toEqual(new Map([...worldToFiles(w)].sort()));
        }
        const back = worldFromFiles(files);
        expect(back.issues).toEqual([]);
        expect(back.world).toEqual(w);
      }),
      { numRuns: 200 },
    );
  });
});

describe('image commands (examples)', () => {
  const w0 = sampleWorld();
  const [A, B] = IMAGE_ID_POOL;
  const add = (w: World, m: ImageMeta, select = true): World => {
    const r = applyCommand(w, { type: 'image.add', payload: { image: m, select } }, ctx);
    if (!r.ok) throw new Error(r.error.message);
    return r.value.world;
  };

  it('add selects by kind; select, unselect and remove keep the canonical form', () => {
    let w = add(w0, meta(B, 'glide', 'icon'));
    w = add(w, meta(A, 'glide', 'concept'), false);
    expect(w.images?.glide).toEqual({
      icon: B,
      all: [meta(A, 'glide', 'concept'), meta(B, 'glide', 'icon')],
    });
    const sel = applyCommand(
      w,
      { type: 'image.select', payload: { entity: 'glide', image: A } },
      ctx,
    );
    expect(sel.ok && sel.value.world.images?.glide?.concept).toBe(A);
    const rm = applyCommand(
      w,
      { type: 'image.remove', payload: { entity: 'glide', image: B } },
      ctx,
    );
    expect(rm.ok && rm.value.world.images?.glide).toEqual({ all: [meta(A, 'glide', 'concept')] });
    // The last image leaves no trace.
    const w1 = add(w0, meta(A, 'glide', 'concept'));
    const gone = applyCommand(
      w1,
      { type: 'image.remove', payload: { entity: 'glide', image: A } },
      ctx,
    );
    expect(gone.ok && 'images' in gone.value.world).toBe(false);
  });

  it('refuses what would break it', () => {
    const w = add(w0, meta(A, 'glide', 'concept'));
    const codes = [
      applyCommand(w, { type: 'image.add', payload: { image: meta(A, 'glide', 'icon') } }, ctx),
      applyCommand(w0, { type: 'image.add', payload: { image: meta(A, 'nope', 'icon') } }, ctx),
      applyCommand(w0, { type: 'image.add', payload: { image: meta(B, 'glide', 'icon', A) } }, ctx),
      applyCommand(w, { type: 'image.select', payload: { entity: 'glide', image: B } }, ctx),
      applyCommand(w, { type: 'image.remove', payload: { entity: 'cinder-sting', image: A } }, ctx),
    ].map((r) => (r.ok ? 'ok' : r.error.code));
    expect(codes).toEqual([
      'image.exists',
      'entity.not_found',
      'image.not_found',
      'image.not_found',
      'image.not_found',
    ]);
  });

  it('art.set: direction and per-kind notes; clearing everything removes the key', () => {
    let r = applyCommand(
      w0,
      {
        type: 'art.set',
        payload: { direction: 'painterly, muted earth tones', kinds: { biome: 'wide shots' } },
      },
      ctx,
    );
    expect(r.ok && r.value.world.settings.art).toEqual({
      direction: 'painterly, muted earth tones',
      kinds: { biome: 'wide shots' },
    });
    if (!r.ok) return;
    const w = r.value.world;
    r = applyCommand(w, { type: 'art.set', payload: { kinds: { biome: null } } }, ctx);
    expect(r.ok && r.value.world.settings.art).toEqual({
      direction: 'painterly, muted earth tones',
      kinds: {},
    });
    r = applyCommand(w, { type: 'art.set', payload: { direction: '', kinds: { biome: '' } } }, ctx);
    expect(r.ok && 'art' in r.value.world.settings).toBe(false);
    expect(
      applyCommand(w0, { type: 'art.set', payload: { direction: 'x'.repeat(4001) } }, ctx).ok,
    ).toBe(false);
    expect(applyCommand(w0, { type: 'art.set', payload: { kinds: { dragon: 'x' } } }, ctx).ok).toBe(
      false,
    );
  });
});

describe('image files', () => {
  const [A, B] = IMAGE_ID_POOL;
  it('reports bad files with quarantine codes and keeps the good ones', () => {
    const good = meta(A, 'glide', 'concept');
    const files = new Map([
      ...entityImageFiles('glide', { concept: A, all: [good] }),
      [`images/glide/${B}.json`, '{ not json'],
      [`images/cinder-sting/${A}.json`, JSON.stringify(meta(A, 'glide', 'concept'))],
      [`images/cinder-sting/selected.json`, JSON.stringify({ icon: B })],
      [`images/x/${B}.json`, JSON.stringify({ id: B })],
    ]);
    const r = imagesFromFiles(files);
    expect(r.images).toEqual({ glide: { concept: A, all: [good] } });
    expect(r.issues.map((i) => [i.path, i.code])).toEqual([
      [`images/cinder-sting/${A}.json`, 'file.location'],
      [`images/glide/${B}.json`, 'file.json'],
      [`images/x/${B}.json`, 'file.invalid'],
      ['images/cinder-sting/selected.json', 'image.selection'],
    ]);
  });

  it('metadata files are stable JSON in schema key order', () => {
    const m = meta(A, 'glide', 'icon', B);
    const text = imageFilesOf({ glide: { all: [m] } }).get(`images/glide/${A}.json`) ?? '';
    expect(ImageMetaSchema.parse(JSON.parse(text))).toEqual(m);
    expect(text.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'id',
      'entity',
      'kind',
      'origin',
      'created',
      'hashes',
    ]);
  });
});

describe('pricing', () => {
  it('costs from usage in exact nano-dollars', () => {
    const p = { textInput: 5, imageInput: 8, imageOutput: 30 };
    expect(costNanos(p, { inputTextTokens: 100, inputImageTokens: 1000, outputTokens: 272 })).toBe(
      100 * 5000 + 1000 * 8000 + 272 * 30000,
    );
    // Input without a split counts as text.
    expect(costNanos(p, { inputTokens: 100, outputTokens: 0 })).toBe(500_000);
    // A split with only image tokens: the rest of the input is text.
    expect(costNanos(p, { inputTokens: 1100, inputImageTokens: 1000 })).toBe(
      100 * 5000 + 1000 * 8000,
    );
  });

  it('estimates by quality and size, and settings override the defaults', () => {
    const s = imageSettings({});
    expect(s).toMatchObject({
      model: 'gpt-image-2.6-flare',
      quality: 'low',
      budget: { sessionUsd: 1, monthUsd: 10 },
    });
    const low = estimateNanos(s, {
      model: 'gpt-image-2.6-flare',
      quality: 'low',
      size: '1024x1024',
      promptChars: 400,
    });
    expect(low).toBe(100 * 5000 + OUTPUT_TOKENS.low['1024x1024'] * 30000);
    const high = estimateNanos(s, {
      model: 'gpt-image-2.6-flare',
      quality: 'high',
      size: '1536x1024',
      promptChars: 400,
    });
    expect(high).toBeGreaterThan(low * 10);
    const custom = imageSettings({
      images: {
        pricing: { 'gpt-image-2.6-flare': { textInput: 0, imageInput: 0, imageOutput: 60 } },
      },
    });
    expect(
      estimateNanos(custom, {
        model: 'gpt-image-2.6-flare',
        quality: 'low',
        size: '1024x1024',
        promptChars: 400,
      }),
    ).toBe(OUTPUT_TOKENS.low['1024x1024'] * 60000);
    // An invalid settings value falls back to the defaults.
    expect(imageSettings({ images: { quality: 'ultra' } }).quality).toBe('low');
  });
});

describe('the image prompt', () => {
  it('icons follow the item conventions plus the palette words; concepts the art direction', () => {
    const w = sampleWorld();
    w.settings.art = {
      direction: 'painterly, muted earth tones, soft rim light',
      kinds: { item: 'chunky brass fittings' },
    };
    const e = w.entities['cinder-sting'];
    if (!e) throw new Error('sample');
    const icon = imagePromptAsk(w, e, 'icon');
    expect(icon).toContain('Fully transparent background');
    expect(icon).toContain('Palette, from the art direction: muted earth tones');
    expect(icon).toContain('chunky brass fittings');
    expect(icon).not.toContain('painterly');
    const concept = imagePromptAsk(w, e, 'concept');
    expect(concept).toContain('Art direction: painterly, muted earth tones, soft rim light');
    expect(paletteWords('ink and gold, soft light. Cool palette')).toBe(
      'ink and gold, Cool palette',
    );
  });
});

describe('export', () => {
  it('lists the selected icon and concept with their sizes', () => {
    const [A, B] = IMAGE_ID_POOL;
    const w = sampleWorld();
    w.images = {
      glide: {
        concept: A,
        icon: B,
        all: [
          { ...meta(A, 'glide', 'concept'), width: 1536, height: 1024 },
          { ...meta(B, 'glide', 'icon', A), width: 16, height: 16 },
        ],
      },
      nope: { all: [meta(A, 'nope', 'concept')], concept: A },
    };
    const imgs = exportImages(w, ['glide', 'nope', 'cinder-sting'], 'exports/2026-11-05-x.md');
    expect(imgs.map((i) => [i.from, i.to])).toEqual([
      [`images/glide/${B}.png`, 'exports/2026-11-05-x/images/glide.icon.png'],
      [`images/glide/${A}.png`, 'exports/2026-11-05-x/images/glide.concept.png'],
    ]);
    expect(imagesSection(w, imgs)).toContain(
      '- Glide, icon: `exports/2026-11-05-x/images/glide.icon.png` (16×16)',
    );
    expect(imagesSection(w, [])).toBe('');
  });
});
