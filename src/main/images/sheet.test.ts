import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAiGateway } from '@core/ai/fake';
import { cmd } from '@core/commands/registry';
import { imagePaths, SHEET_SIZE } from '@core/images/model';
import { sheetItemLine, sheetPrompt, splitSheets } from '@core/images/sheet';
import { sampleWorld } from '@core/testing/sample';
import type { World } from '@core/model/world';
import { resetDiskState } from '../store/disk-state';
import { loadWorldDir, writeWorldDir } from '../store/world-dir';
import { WorldSession } from '../world-session';
import { MainImageGateway } from './gateway';
import { cropSheet, drawGuide, sheetLayout } from './pixel';
import { decodePng } from './png';
import { FakeImageProvider, type ImageProvider, type ProviderRequest } from './provider';

/** Icon sheets (docs/IMAGES.md §2a) end to end on the fake provider. */
let dir: string;
let session: WorldSession;

/** The sample world plus `n` extra items, so sheets can be large. */
function withItems(n: number): World {
  const w = sampleWorld();
  for (let i = 0; i < n; i++) {
    const id = `trinket-${i}`;
    w.entities[id] = {
      ...(w.entities['spore-lantern'] as World['entities'][string]),
      id,
      name: `Trinket ${i}`,
      identity: `A small thing, number ${i}.`,
      relations: [],
      state: 'idea',
    };
  }
  return w;
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-sheets-'));
  await writeWorldDir(dir, withItems(120));
  resetDiskState(dir);
  session = await WorldSession.open(dir);
});
afterEach(async () => {
  await session.flush();
  resetDiskState(dir);
  await rm(dir, { recursive: true, force: true });
});

class Recording implements ImageProvider {
  readonly name = 'fake' as const;
  readonly seen: ProviderRequest[] = [];
  private readonly inner = new FakeImageProvider();
  generate(req: ProviderRequest) {
    this.seen.push(req);
    return this.inner.generate(req);
  }
}

const gateway = (provider: ImageProvider = new FakeImageProvider()) =>
  new MainImageGateway({
    session,
    ai: new FakeAiGateway({ getWorld: () => session.world }),
    provider,
    mode: 'fake',
  });

const items = (ids: string[]) =>
  ids.map((entityId) => ({ entityId, line: sheetItemLine(session.world, entityId) }));
const trinkets = (n: number) => Array.from({ length: n }, (_, i) => `trinket-${i}`);

describe('icon sheets (pure)', () => {
  it('split evenly into sheets of at most 100', () => {
    expect(splitSheets(Array.from({ length: 230 }, (_, i) => i)).map((s) => s.length)).toEqual([
      77, 77, 76,
    ]);
    expect(splitSheets([1]).map((s) => s.length)).toEqual([1]);
    expect(splitSheets([])).toEqual([]);
  });

  it('lines come from the entity; the sheet prompt places each by position', () => {
    const w = sampleWorld();
    expect(sheetItemLine(w, 'spore-lantern')).toMatch(/^Spore Lantern, a tool/);
    const p = sheetPrompt(w, ['A thing', 'Another'], { cols: 2, rows: 1 });
    expect(p).toMatch(/^A sprite sheet of 2 separate game item icons on a 2×1 grid/);
    expect(p).toContain('row 1, col 2: Another');
  });

  it('the adapter crops what the fake draws, and flags an empty cell', () => {
    const layout = sheetLayout(4, { w: 200, h: 200 });
    expect([layout.cols, layout.rows]).toEqual([2, 2]);
    const guide = drawGuide(layout);
    // The guide is opaque, flat: every cell would be empty or background.
    const cells = cropSheet(
      { ...guide, data: guide.data.map((v, i) => (i % 4 === 3 ? 0 : v)) },
      layout,
    );
    expect(cells.every((c) => c.flags.includes('empty'))).toBe(true);
  });
});

describe('icon sheets through the gateway', () => {
  it('batchPlan for icons: sheets of ≤ 100 with lines, one call each, no Claude calls', async () => {
    const g = gateway();
    const plan = await g.batchPlan({ kind: 'icon', entityIds: trinkets(120) });
    expect(plan.sheets?.map((s) => s.items.length)).toEqual([60, 60]);
    expect(plan.sheets?.map((s) => [s.cols, s.rows, s.size])).toEqual([
      [8, 8, SHEET_SIZE],
      [8, 8, SHEET_SIZE],
    ]);
    expect(plan.calls).toBe(2);
    expect(plan.claudeCostUsd).toBe(0);
    expect(plan.items.every((i) => i.line && !i.prompt)).toBe(true);
    expect(plan.estimate.totalUsd).toBeCloseTo(
      (plan.sheets ?? []).reduce((n, x) => n + x.estimateUsd, 0),
      9,
    );
  });

  it('sheetRun: one edit call per sheet with the guide; the sheet is kept, cells await review', async () => {
    const provider = new Recording();
    const g = gateway(provider);
    const ids = ['spore-lantern', 'cinder-sting', 'cloud-anklet', 'vent-glass-visor', 'trinket-0'];
    const progress: number[] = [];
    const r = await g.sheetRun({ batchId: 's1', items: items(ids) }, (p) => progress.push(p.done));
    expect(provider.seen).toHaveLength(1);
    const req = provider.seen[0] as ProviderRequest;
    expect(req).toMatchObject({ size: SHEET_SIZE, background: 'transparent', quality: 'low' });
    const guide = decodePng(req.reference as Uint8Array);
    expect([guide.width, guide.height]).toEqual([2880, 2880]);
    expect(progress.at(-1)).toBe(1);
    const s = r.sheets[0];
    expect(s?.ok).toBe(true);
    if (!s?.ok) return;
    // The sheet is an image of the first entity, not selected; no icons yet.
    expect(s.review.sheet).toMatchObject({ kind: 'sheet', entity: 'spore-lantern' });
    expect(session.world.images?.['spore-lantern']).toEqual({ all: [s.review.sheet] });
    expect(session.world.images?.['cinder-sting']).toBeUndefined();
    expect(s.review.cells.map((c) => [c.entityId, c.row, c.col])).toEqual([
      ['spore-lantern', 0, 0],
      ['cinder-sting', 0, 1],
      ['cloud-anklet', 0, 2],
      ['vent-glass-visor', 1, 0],
      ['trinket-0', 1, 1],
    ]);
    for (const c of s.review.cells) {
      expect(c.flags).toEqual([]);
      expect(c.icon).toMatchObject({ width: 16, height: 16 });
    }
    expect(g.status().spend.sessionUsd).toBeGreaterThan(0);
    expect((await g.log()).map((l) => [l.kind, l.endpoint, l.outcome])).toEqual([
      ['sheet', 'edit', 'ok'],
    ]);

    // Accept three cells: three icons, one undo step, the sheet stays.
    const acc = await g.sheetAccept({
      entityId: 'spore-lantern',
      imageId: s.review.sheet.id,
      cells: [0, 1, 4],
    });
    expect(acc.ok).toBe(true);
    if (!acc.ok) return;
    expect(acc.images.map((m) => [m.entity, m.origin])).toEqual([
      ['spore-lantern', { by: 'sheet', sheet: s.review.sheet.id, cell: 0, preset: 'item' }],
      ['cinder-sting', { by: 'sheet', sheet: s.review.sheet.id, cell: 1, preset: 'item' }],
      ['trinket-0', { by: 'sheet', sheet: s.review.sheet.id, cell: 4, preset: 'item' }],
    ]);
    expect(session.world.images?.['cinder-sting']?.icon).toBe(acc.images[1]?.id);
    const icon = decodePng(
      await readFile(path.join(dir, imagePaths('trinket-0', acc.images[2]?.id ?? '').png)),
    );
    expect([icon.width, icon.height]).toEqual([16, 16]);
    expect(session.snapshot().history.undoLabel).toBe('Accept 3 icons');
    await session.flush();
    resetDiskState(dir);
    expect((await loadWorldDir(dir)).world).toEqual(session.world);
    session.undo();
    expect(session.world.images?.['cinder-sting']).toBeUndefined();
    expect(session.world.images?.['spore-lantern']?.all).toEqual([s.review.sheet]);

    // Re-crop is free and gives the same review.
    const again = await g.sheetCrop({ entityId: 'spore-lantern', imageId: s.review.sheet.id });
    expect(again?.cells.map((c) => c.icon?.dataUrl)).toEqual(
      s.review.cells.map((c) => c.icon?.dataUrl),
    );
    expect(provider.seen).toHaveLength(1);
  });

  it('120 items make two sheets, run one after the other; cancel stops before the next', async () => {
    const g = gateway(new FakeImageProvider({ delayMs: 30 }));
    const run = g.sheetRun({ batchId: 's2', items: items(trinkets(120)) });
    await new Promise((r) => setTimeout(r, 5));
    g.cancel('s2');
    const r = await run;
    expect(r.cancelled).toBe(true);
    expect(r.sheets).toHaveLength(2);
    expect(r.sheets[1]).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    if (!r.sheets[1]?.ok) expect(r.sheets[1]?.entityIds).toHaveLength(60);
  });

  it('accept refuses an empty cell, a missing sheet, and a cell past the end', async () => {
    const g = gateway();
    const r = await g.sheetRun({ batchId: 's3', items: items(['spore-lantern', 'cinder-sting']) });
    const s = r.sheets[0];
    if (!s?.ok) throw new Error('sheet failed');
    const bad = await g.sheetAccept({
      entityId: 'spore-lantern',
      imageId: s.review.sheet.id,
      cells: [7],
    });
    expect(bad.ok).toBe(false);
    const none = await g.sheetAccept({
      entityId: 'cinder-sting',
      imageId: s.review.sheet.id,
      cells: [0],
    });
    expect(none.ok).toBe(false);
    // A sheet can't be chosen as an icon.
    expect(
      session.dispatch([cmd('image.select', { entity: 'spore-lantern', image: s.review.sheet.id })])
        .ok,
    ).toBe(false);
  });

  it('the budget stops a sheet before it is sent', async () => {
    const provider = new Recording();
    const g = gateway(provider);
    session.dispatch([
      cmd('settings.set', { key: 'images', value: { budget: { sessionUsd: 0, monthUsd: 10 } } }),
    ]);
    const r = await g.sheetRun({ batchId: 's4', items: items(['spore-lantern']) });
    expect(r.sheets[0]).toMatchObject({ ok: false, error: { code: 'budget' } });
    expect(provider.seen).toHaveLength(0);
  });
});
