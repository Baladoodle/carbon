import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fc from 'fast-check';
import { decodePng } from './png';
import { describe, expect, it } from 'vitest';
import { filterImage } from './filter';
import { GUIDE_CELL, GUIDE_GUTTER, cropSheet, drawGuide, sheetLayout } from './sheet';
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

describe('drawGuide', () => {
  it('fills each cell flat MID-GREY on a flat DARK GREY gutter, with no lines (Genforge drafts)', () => {
    const l = sheetLayout(4, { w: 64, h: 64 }, { gutter: 4 });
    const g = drawGuide(l);
    const px = (x: number, y: number): number[] => [
      ...g.data.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4),
    ];
    const c = l.cells[0]!;
    expect(px(c.x, c.y)).toEqual([...GUIDE_CELL, 255]);
    expect(px(c.x + c.w - 1, c.y + c.h - 1)).toEqual([...GUIDE_CELL, 255]);
    expect(px(c.x - 1, c.y)).toEqual([...GUIDE_GUTTER, 255]);
    expect(px(0, 0)).toEqual([...GUIDE_GUTTER, 255]);
    const colours = new Set<string>();
    for (let i = 0; i < g.data.length; i += 4) colours.add(g.data.slice(i, i + 3).join());
    expect(colours.size).toBe(2);
  });

  it('scales the cells to the requested canvas and takes custom colours', () => {
    const l = sheetLayout(4, { w: 64, h: 64 }, { gutter: 4 });
    const g = drawGuide(l, { w: 128, h: 128 }, { cell: [1, 2, 3], gutter: [9, 9, 9] });
    expect([g.width, g.height]).toEqual([128, 128]);
    const c = l.cells[0]!;
    const at = (x: number, y: number): number[] => [
      ...g.data.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 4),
    ];
    expect(at(c.x * 2, c.y * 2)).toEqual([1, 2, 3, 255]);
    expect(at(c.x * 2 - 1, c.y * 2)).toEqual([9, 9, 9, 255]);
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
    expect(good!.bbox).toEqual({
      x: layout.cells[0]!.x + 20,
      y: layout.cells[0]!.y + 30,
      w: 40,
      h: 20,
    });
    expect([good!.crop!.width, good!.crop!.height]).toEqual([40, 40]);
    // padded to square: top rows transparent, sprite centred vertically
    expect(good!.crop!.data[3]).toBe(0);
    expect(good!.crop!.data[20 * 40 * 4 + 3]).toBe(255);
    expect(empty!.flags).toEqual([segmentation === 'colour' ? 'background_only' : 'empty']);
    expect(empty!.crop).toBeNull();
    expect(edge!.flags).toContain('touches_edge');
    expect(frag!.flags).toEqual(['fragmented']);
    // a crop goes straight through the item filter
    expect(filterImage(good!.crop!, { target: { w: 16, h: 16 }, preset: 'item' }).image.width).toBe(
      16,
    );
  });

  it('flags a nearly empty cell with a speck as empty, not background_only', () => {
    const img = makeSheet(layout, [250, 250, 245, 255]);
    const e = layout.cells[1]!;
    paint(img, e.x + 40, e.y + 40, [0, 0, 0, 255]);
    expect(cropSheet(img, layout)[1]!.flags).toEqual(['empty']);
  });

  it('survives background noise and honours an explicit background', () => {
    const img = makeSheet(layout, [250, 250, 245, 255]);
    // deterministic ±12 jitter on every channel, as a lossy or dithered model output has
    for (let p = 0; p < img.data.length; p += 4) {
      const n = ((p * 2654435761) >>> 0) % 25;
      for (let c = 0; c < 3; c++) img.data[p + c] = img.data[p + c]! + n - 12;
    }
    const auto = cropSheet(img, layout);
    const fixed = cropSheet(img, layout, { background: [250, 250, 245] });
    for (const cells of [auto, fixed]) {
      expect(cells[0]!.flags).toEqual([]);
      expect(cells[0]!.bbox).toEqual({
        x: layout.cells[0]!.x + 20,
        y: layout.cells[0]!.y + 30,
        w: 40,
        h: 20,
      });
      expect(cells[1]!.flags).toEqual(['empty']); // noisy, so not background_only
      expect(cells[3]!.flags).toEqual(['fragmented']);
    }
  });

  it("forces alpha segmentation with background: 'alpha'", () => {
    const img = makeSheet(layout, null);
    const cells = cropSheet(img, layout, { background: 'alpha' });
    expect(cells[0]!.segmentation).toBe('alpha');
    expect(cells[0]!.flags).toEqual([]);
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

describe('cropSheet against grid drift', () => {
  const layout = sheetLayout(4, { w: 256, h: 256 });
  const blank = (): RgbaImage => ({
    width: 256,
    height: 256,
    data: new Uint8ClampedArray(256 * 256 * 4),
  });

  it('keeps a drifted sprite whole and unflagged in the cell its centre falls in', () => {
    // like the real sheet: the model's grid sits up to ~half a gutter off ours (28 of 58 px)
    const wide = sheetLayout(4, { w: 400, h: 400 }, { gutter: 40 });
    const img: RgbaImage = { width: 400, height: 400, data: new Uint8ClampedArray(400 * 400 * 4) };
    wide.cells.forEach((c, i) =>
      rect(img, c.x - 30, c.y - 25, 110, 100, [60 * (i + 1), 90, 40, 255]),
    );
    const cells = cropSheet(img, wide);
    expect(cells.map((c) => c.flags)).toEqual([[], [], [], []]);
    cells.forEach((c, i) => {
      const cell = wide.cells[i]!;
      expect(c.bbox).toEqual({ x: cell.x - 30, y: cell.y - 25, w: 110, h: 100 });
    });
  });

  it('gives a sprite whose centre lies in a gutter to the nearest cell', () => {
    const img = blank();
    const [a, b] = layout.cells;
    rect(img, a!.x + a!.w - 8, a!.y + 30, 12, 20, [200, 40, 40, 255]); // centre just past a's right edge
    const cells = cropSheet(img, layout);
    expect(cells[0]!.bbox).not.toBeNull();
    expect(cells[1]!.bbox).toBeNull();
    expect(b).toBeDefined();
  });

  it('flags touches_edge on both sprites when they really run into each other', () => {
    const img = blank();
    const [a, b, c] = layout.cells;
    rect(img, a!.x + 20, a!.y + 30, 60, 40, [200, 40, 40, 255]);
    rect(img, b!.x + 20, b!.y + 30, 60, 40, [40, 40, 200, 255]);
    rect(img, a!.x + 70, a!.y + 45, b!.x - a!.x, 8, [120, 120, 120, 255]); // a bridge joining them
    rect(img, c!.x + 30, c!.y + 30, 40, 40, [40, 200, 40, 255]);
    const cells = cropSheet(img, layout);
    // the merged part goes to one cell (flagged), the other cell is left empty and says why
    const [first, second] = [cells[0]!, cells[1]!];
    const owner = first.bbox ? first : second;
    const robbed = first.bbox ? second : first;
    expect(owner.flags).toContain('touches_edge');
    expect(robbed.flags).toEqual(['empty', 'touches_edge']);
    expect(cells[2]!.flags).toEqual([]);
  });
});

describe('the recorded real sheet (images-core, gpt-image-2.6-flare, 100 items, 2880² stored at 1440²)', () => {
  const dir = resolve(import.meta.dirname, '../../../fixtures/pixel/sheets');
  const sheet = decodePng(readFileSync(`${dir}/items-sheet-100-flare.png`));
  const layout = sheetLayout(100, { w: 2880, h: 2880 });

  it('crops all 100 sprites with no flags, despite the model drifting up to ~28 px from the grid', () => {
    const cells = cropSheet(sheet, layout);
    expect(cells.filter((c) => c.crop === null)).toEqual([]);
    expect(cells.filter((c) => c.flags.length).map((c) => [c.index, c.flags])).toEqual([]);
    const k = 2880 / sheet.width;
    for (const c of cells) {
      const cell = layout.cells[c.index]!;
      const cx = (c.bbox!.x + c.bbox!.w / 2) * k;
      const cy = (c.bbox!.y + c.bbox!.h / 2) * k;
      expect(Math.abs(cx - (cell.x + cell.w / 2))).toBeLessThan(cell.w / 2);
      expect(Math.abs(cy - (cell.y + cell.h / 2))).toBeLessThan(cell.h / 2);
    }
  });

  it('every crop goes through the item preset to a non-empty 16×16 icon', () => {
    for (const c of cropSheet(sheet, layout)) {
      const { image, report } = filterImage(c.crop!, { target: { w: 16, h: 16 }, preset: 'item' });
      expect([image.width, image.height]).toEqual([16, 16]);
      expect(report.opaquePixels).toBeGreaterThan(20);
    }
  });
});
