import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { filterImage } from './filter';
import { sheetPrompt } from './prompts';
import type { IconSubject } from './prompts';
import { cropSheet, sheetGuide, sheetLayout } from './sheet';
import type { SheetLayout } from './sheet';
import type { RgbaImage } from './types';

type Paint = (img: RgbaImage, x: number, y: number, rgba: readonly number[]) => void;
const paint: Paint = (img, x, y, rgba) => {
  if (x >= 0 && y >= 0 && x < img.width && y < img.height)
    img.data.set(rgba, (y * img.width + x) * 4);
};
const rect = (
  img: RgbaImage,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: readonly number[],
): void => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) paint(img, x + i, y + j, rgba);
};

/** A 2×2 sheet: [good sprite, empty, sprite touching the cell edge, two separate blobs]. */
function makeSheet(layout: SheetLayout, background: readonly number[] | null): RgbaImage {
  const { w, h } = layout.canvas;
  const img: RgbaImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  if (background) rect(img, 0, 0, w, h, background);
  const [a, , c, d] = layout.cells;
  rect(img, a!.x + 20, a!.y + 30, 40, 20, [200, 40, 40, 255]);
  rect(img, c!.x - 20, c!.y + 30, 40, 20, [40, 200, 40, 255]); // crosses the cell's left edge, off the canvas
  rect(img, d!.x + 10, d!.y + 10, 20, 20, [40, 40, 200, 255]);
  rect(img, d!.x + 60, d!.y + 60, 20, 20, [40, 40, 200, 255]);
  return img;
}

describe('sheetLayout', () => {
  it('makes a near-square grid of equal cells inside the canvas', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), (n) => {
        const l = sheetLayout(n, { w: 1024, h: 1024 });
        expect(l.cols * l.rows).toBeGreaterThanOrEqual(n);
        expect(l.cols).toBeLessThanOrEqual(10);
        expect(l.rows).toBeLessThanOrEqual(10);
        expect(l.cells).toHaveLength(n);
        for (const c of l.cells) {
          expect(c.w).toBe(l.cells[0]!.w);
          expect(c.x + c.w).toBeLessThanOrEqual(1024 - l.gutter);
          expect(c.y + c.h).toBeLessThanOrEqual(1024 - l.gutter);
        }
      }),
    );
    expect(sheetLayout(100, { w: 1024, h: 1024 })).toMatchObject({ cols: 10, rows: 10 });
    expect(sheetLayout(5, { w: 1024, h: 1024 })).toMatchObject({ cols: 3, rows: 2 });
  });

  it('rejects impossible layouts', () => {
    expect(() => sheetLayout(0, { w: 100, h: 100 })).toThrow(/1\.\.100/);
    expect(() => sheetLayout(101, { w: 100, h: 100 })).toThrow(/1\.\.100/);
    expect(() => sheetLayout(5, { w: 100, h: 100 }, { cols: 2, rows: 2 })).toThrow(/cannot hold/);
    expect(() => sheetLayout(100, { w: 40, h: 40 })).toThrow(/too small/);
  });
});

describe('sheetGuide', () => {
  it('draws faint boxes just outside each cell on a flat background', () => {
    const l = sheetLayout(4, { w: 64, h: 64 }, { gutter: 4 });
    const g = sheetGuide(l);
    const px = (x: number, y: number): number[] => [
      ...g.data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4),
    ];
    const c = l.cells[0]!;
    expect(px(c.x - 1, c.y + 3)).toEqual([220, 220, 220, 255]);
    expect(px(c.x + 3, c.y + 3)).toEqual([255, 255, 255, 255]);
    expect(px(0, 0)).toEqual([255, 255, 255, 255]);
  });
});

describe('cropSheet', () => {
  const layout = sheetLayout(4, { w: 256, h: 256 });

  it.each([
    ['alpha', null],
    ['colour', [250, 250, 245, 255]],
  ] as const)('finds sprites and flags problems (%s segmentation)', (segmentation, bg) => {
    const cells = cropSheet(makeSheet(layout, bg), layout);
    expect(cells.map((c) => c.segmentation)).toEqual(Array(4).fill(segmentation));
    const [good, empty, edge, frag] = cells;
    expect(good!.flags).toEqual([]);
    expect(good!.box).toEqual({
      x: layout.cells[0]!.x + 20,
      y: layout.cells[0]!.y + 30,
      w: 40,
      h: 20,
    });
    expect([good!.crop!.width, good!.crop!.height]).toEqual([40, 40]);
    // padded to square: top rows transparent, sprite centred vertically
    expect(good!.crop!.data[3]).toBe(0);
    expect(good!.crop!.data[20 * 40 * 4 + 3]).toBe(255);
    expect(empty!.flags).toEqual([segmentation === 'colour' ? 'uniform' : 'empty']);
    expect(empty!.crop).toBeNull();
    expect(edge!.flags).toContain('touches-edge');
    expect(frag!.flags).toEqual(['fragmented']);
    // a crop goes straight through the item filter
    expect(filterImage(good!.crop!, { target: { w: 16, h: 16 }, preset: 'item' }).image.width).toBe(
      16,
    );
  });

  it('flags a noisy but nearly empty cell as empty, not uniform', () => {
    const img = makeSheet(layout, [250, 250, 245, 255]);
    const e = layout.cells[1]!;
    paint(img, e.x + 40, e.y + 40, [0, 0, 0, 255]);
    expect(cropSheet(img, layout)[1]!.flags).toEqual(['empty']);
  });

  it('scales the grid when the model returns a different size', () => {
    const big = sheetLayout(4, { w: 512, h: 512 });
    const sheet = makeSheet(big, null);
    const cells = cropSheet(sheet, layout); // layout planned at 256², sheet came back at 512²
    expect(cells[0]!.flags).toEqual([]);
    expect(cells[0]!.region.w).toBeGreaterThan(200);
  });

  it('is deterministic and rejects bad buffers', () => {
    const s = makeSheet(layout, null);
    expect(cropSheet(s, layout)).toEqual(cropSheet(s, layout));
    expect(() =>
      cropSheet({ width: 2, height: 2, data: new Uint8ClampedArray(1) }, layout),
    ).toThrow(/bytes/);
  });
});

describe('sheetPrompt', () => {
  const world = { entities: { iron: { kind: 'material' as const, name: 'Iron' } } };
  const e = (id: string, name: string, extra: Partial<IconSubject> = {}): IconSubject => ({
    id,
    kind: 'item',
    name,
    identity: '',
    description: '',
    fields: {},
    relations: [],
    ...extra,
  });

  it('states the house style once, then each cell by position', () => {
    const items = [
      e('p', 'Pickaxe', {
        fields: { subkind: 'tool' },
        relations: [{ type: 'made_from', target: 'iron' }],
      }),
      e('o', 'Orb', { identity: 'sees through walls' }),
      e('a', 'Ash', { kind: 'material' }),
    ];
    const l = sheetLayout(3, { w: 1024, h: 1024 });
    const p = sheetPrompt(
      items,
      l,
      world,
      { direction: 'warm ochre', notes: { item: 'worn' } },
      {
        background: 'flat pure white #FFFFFF',
      },
    );
    expect(p).toContain('3 separate game inventory icons on a 2×2 grid');
    expect(p).toContain('row 1, col 1: Pickaxe, a chunky tool of Iron, diagonal from lower left');
    expect(p).toContain('row 1, col 2: Orb, a chunky item (sees through walls), upright');
    expect(p).toContain('(sees through walls)');
    expect(p).toContain('row 2, col 1: Ash, a chunky material, upright');
    expect(p).toContain('Palette: warm ochre.');
    expect(p).toContain('Art note (item): worn.');
    expect(p).not.toContain('Art note (material)');
    expect(p).toContain('Background: flat pure white #FFFFFF');
    expect(p).toMatch(/no item touches or crosses a cell edge/);
    expect(p.match(/Never:/g)).toHaveLength(1);
    expect(sheetPrompt(items, l, world)).toContain('Background: fully transparent');
  });

  it('rejects a mismatched grid', () => {
    expect(() => sheetPrompt([e('a', 'A')], sheetLayout(2, { w: 256, h: 256 }), world)).toThrow(
      /cells/,
    );
  });
});
