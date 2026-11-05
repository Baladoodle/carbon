import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { imagePaths } from '@core/images/model';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * images-core: the image gateway over IPC in the real app, on the fake
 * provider (the harness sets CARBON_IMAGES=fake; tests never call OpenAI).
 */
let carbon: CarbonApp;
test.beforeAll(async () => {
  carbon = await launchCarbon();
});
test.afterAll(async () => {
  await carbon.close();
});

test('images: prompt, estimate, generate, icon from concept, files and undo over IPC @smoke', async () => {
  const status = await carbon.invoke('images:status', null);
  expect(status).toMatchObject({
    mode: 'fake',
    enabled: true,
    model: 'gpt-image-2.6-flare',
    quality: 'low',
  });

  const p = await carbon.invoke('images:prompt', { entityId: 'glide', kind: 'concept' });
  expect(p.ok).toBe(true);
  if (!p.ok) return;
  const est = await carbon.invoke('images:estimate', {
    kind: 'concept',
    promptChars: p.prompt.length,
  });
  expect(est.perCallUsd).toBeGreaterThan(0);

  const g = await carbon.invoke('images:generate', {
    requestId: 'e2e-1',
    entityId: 'glide',
    kind: 'concept',
    prompt: p.prompt,
  });
  expect(g.ok).toBe(true);
  if (!g.ok) return;
  const png = path.join(carbon.worldDir, imagePaths('glide', g.image.id).png);
  expect((await stat(png)).size).toBeGreaterThan(0);
  // The store writes the metadata from the command's patch.
  await expect
    .poll(async () =>
      readFile(path.join(carbon.worldDir, imagePaths('glide', g.image.id).json), 'utf8').catch(
        () => '',
      ),
    )
    .toContain(g.image.id);

  const icon = await carbon.invoke('images:iconFromConcept', { entityId: 'glide' });
  expect(icon.ok).toBe(true);
  const f = await carbon.invoke('images:file', {
    entityId: 'glide',
    imageId: g.image.id,
    variant: 'thumb',
  });
  expect(f?.dataUrl.startsWith('data:image/png;base64,')).toBe(true);

  const log = await carbon.invoke('images:log', {});
  expect(log.map((l) => l.outcome)).toEqual(['ok']);
  const after = await carbon.invoke('images:status', null);
  expect(after.spend.sessionUsd).toBeCloseTo(g.receipt.costUsd, 9);

  // Undo the icon: the world forgets it; its pixels stay until "Delete image files".
  await carbon.invoke('world:undo', null);
  const snap = await carbon.invoke('world:snapshot', null);
  expect(snap.world.images?.glide?.icon).toBeUndefined();
  expect(snap.world.images?.glide?.concept).toBe(g.image.id);
});

test('images: a batch runs with progress events', async () => {
  const plan = await carbon.invoke('images:batchPlan', {
    kind: 'icon',
    entityIds: ['cinder-sting', 'spore-lantern'],
  });
  expect(plan.calls).toBe(2);
  const items = plan.items.flatMap((i) =>
    i.prompt ? [{ entityId: i.entityId, prompt: i.prompt }] : [],
  );
  const r = await carbon.invoke('images:batchRun', { batchId: 'e2e-b', kind: 'icon', items });
  expect(r.items.every((i) => i.result.ok)).toBe(true);
  const snap = await carbon.invoke('world:snapshot', null);
  expect(snap.world.images?.['cinder-sting']?.icon).toBeDefined();
});
