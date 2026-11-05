import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAiGateway } from '@core/ai/fake';
import { cmd } from '@core/commands/registry';
import { ImageLogEntrySchema } from '@core/images/gateway';
import { ImageMetaSchema, imagePaths } from '@core/images/model';
import { sampleWorld } from '@core/testing/sample';
import { resetDiskState } from '../store/disk-state';
import { loadWorldDir, writeWorldDir } from '../store/world-dir';
import { WorldSession } from '../world-session';
import { MainImageGateway } from './gateway';
import { decodePng } from './png';
import {
  FakeImageProvider,
  ProviderError,
  type ImageProvider,
  type ProviderRequest,
} from './provider';

let dir: string;
let session: WorldSession;
const clock = (): string => '2026-11-05T10:00:00.000Z';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-images-'));
  await writeWorldDir(dir, sampleWorld());
  resetDiskState(dir);
  session = await WorldSession.open(dir, clock);
});
afterEach(async () => {
  await session.flush();
  resetDiskState(dir);
  await rm(dir, { recursive: true, force: true });
});

const ai = (): FakeAiGateway => new FakeAiGateway({ getWorld: () => session.world });

function gateway(
  provider: ImageProvider | null = new FakeImageProvider(),
  extra = {},
): MainImageGateway {
  return new MainImageGateway({
    session,
    ai: ai(),
    provider,
    mode: 'fake',
    now: () => new Date('2026-11-05T10:00:00.000Z'),
    sleep: () => Promise.resolve(),
    ...extra,
  });
}

/** A provider that answers from a script, recording each request. */
class Scripted implements ImageProvider {
  readonly name = 'openai' as const;
  readonly seen: ProviderRequest[] = [];
  constructor(private readonly script: (n: number, req: ProviderRequest) => Promise<unknown>) {}
  async generate(req: ProviderRequest) {
    this.seen.push(req);
    return (await this.script(this.seen.length, req)) as Awaited<
      ReturnType<ImageProvider['generate']>
    >;
  }
}
const fakePng = async (req: ProviderRequest) => new FakeImageProvider().generate(req);
const err = (code: string, unknownOutcome = false, httpStatus?: number, retryAfter?: number) =>
  new ProviderError(
    { code: code as 'server', message: code, unknownOutcome },
    httpStatus,
    'req_x',
    retryAfter,
  );

describe('the image gateway over the fake provider', () => {
  it('writes a prompt with Claude (the image_prompt moment)', async () => {
    const g = gateway();
    const r = await g.prompt({ entityId: 'cinder-sting', kind: 'icon' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.prompt).toMatch(/Cinder Sting/);
    expect((await g.prompt({ entityId: 'nope', kind: 'icon' })).ok).toBe(false);
  });

  it('generates a concept: files written, image.add as one undo step, selected, logged and costed', async () => {
    const g = gateway();
    const r = await g.generate({
      requestId: 'r1',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const imgs = session.world.images?.glide;
    expect(imgs?.concept).toBe(r.image.id);
    expect(imgs?.all).toEqual([r.image]);
    expect(r.image.origin).toEqual({
      by: 'fake',
      prompt: 'A glider over clouds',
      size: '1536x1024',
    });
    // Pixels on disk match the recorded hash; the concept has no separate source file.
    const p = imagePaths('glide', r.image.id);
    const png = await readFile(path.join(dir, p.png));
    expect(decodePng(png).width).toBeGreaterThan(0);
    await expect(stat(path.join(dir, p.src))).rejects.toThrow();
    // Cost from the reported usage: 158 output (2.5-flare, low, 1536×1024) × $30/M + ceil(20/4)=5 text × $5/M.
    expect(r.receipt.costUsd).toBe(0.004765);
    expect(g.status().spend.sessionUsd).toBeCloseTo(r.receipt.costUsd, 12);
    const log = await g.log();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      outcome: 'ok',
      image: r.image.id,
      costFrom: 'usage',
      kind: 'concept',
    });
    // The store wrote the metadata; reopening gives the same world.
    await session.flush();
    resetDiskState(dir);
    expect((await loadWorldDir(dir)).world).toEqual(session.world);
    // Undo removes the metadata but keeps the pixels.
    session.undo();
    expect(session.world.images).toBeUndefined();
    await session.flush();
    await expect(stat(path.join(dir, p.png))).resolves.toBeTruthy();
    await expect(stat(path.join(dir, p.json))).rejects.toThrow();
  });

  it('generates an icon: transparent background asked, 16×16 output, source kept', async () => {
    const provider = new Scripted((_n, req) => fakePng(req));
    const g = gateway(provider);
    const r = await g.generate({
      requestId: 'r',
      entityId: 'cinder-sting',
      kind: 'icon',
      prompt: 'A stinger icon',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(provider.seen[0]).toMatchObject({
      background: 'transparent',
      size: '1024x1024',
      quality: 'low',
      model: 'gpt-image-2.5-flare',
    });
    const p = imagePaths('cinder-sting', r.image.id);
    const icon = decodePng(await readFile(path.join(dir, p.png)));
    expect([icon.width, icon.height]).toEqual([16, 16]);
    // Hard alpha only.
    for (let i = 3; i < icon.data.length; i += 4) expect([0, 255]).toContain(icon.data[i]);
    expect(r.image.hashes.source).toMatch(/^[0-9a-f]{64}$/);
    await expect(stat(path.join(dir, p.src))).resolves.toBeTruthy();
  });

  it('makes an icon from the concept for free (the pixel filter, no provider call)', async () => {
    const provider = new FakeImageProvider();
    const g = gateway(provider);
    const c = await g.generate({
      requestId: 'c',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    expect(c.ok).toBe(true);
    const before = provider.calls;
    const spend = g.status().spend.sessionUsd;
    const r = await g.iconFromConcept({ entityId: 'glide' });
    expect(r.ok).toBe(true);
    if (!r.ok || !c.ok) return;
    expect(provider.calls).toBe(before);
    expect(g.status().spend.sessionUsd).toBe(spend);
    expect(r.image.origin).toMatchObject({ by: 'filter', from: c.image.id, preset: 'item' });
    expect(session.world.images?.glide?.icon).toBe(r.image.id);
    expect((await g.iconFromConcept({ entityId: 'cinder-sting' })).ok).toBe(false);
  });

  it('an edit sends the reference image', async () => {
    const provider = new Scripted((_n, req) => fakePng(req));
    const g = gateway(provider);
    const c = await g.generate({
      requestId: 'c',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    if (!c.ok) throw new Error('concept failed');
    const r = await g.generate({
      requestId: 'i',
      entityId: 'glide',
      kind: 'icon',
      prompt: 'Icon of the glider',
      reference: c.image.id,
    });
    expect(r.ok).toBe(true);
    expect(provider.seen[1]?.reference?.length).toBeGreaterThan(8);
    if (r.ok) expect(r.image.origin).toMatchObject({ by: 'openai', reference: c.image.id });
    expect(r.receipt?.attempts[0]?.endpoint).toBe('edit');
  });

  it('serves files as data URLs, thumbnails at most 256px, null when missing', async () => {
    const g = gateway();
    const r = await g.generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    if (!r.ok) throw new Error('failed');
    const f = await g.file('glide', r.image.id, 'png');
    expect(f?.dataUrl).toMatch(/^data:image\/png;base64,/);
    const t = await g.file('glide', r.image.id, 'thumb');
    expect(Math.max(t?.width ?? 999, t?.height ?? 999)).toBeLessThanOrEqual(256);
    expect(await g.file('glide', '01JC0000000000000000000009', 'png')).toBeNull();
  });
});

describe('errors, receipts and the no-retry rule', () => {
  it('a timeout is never retried; it counts at its estimate because it may be charged', async () => {
    const provider = new Scripted(() => Promise.reject(err('timeout', true)));
    const g = gateway(provider);
    const r = await g.generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(provider.seen).toHaveLength(1);
    expect(r.error).toMatchObject({ code: 'timeout', unknownOutcome: true });
    expect(r.receipt?.attempts).toHaveLength(1);
    expect(r.receipt?.attempts[0]).toMatchObject({ status: 'unknown', costFrom: 'estimate' });
    expect(r.receipt?.costUsd).toBeGreaterThan(0);
    expect(g.status().spend.sessionUsd).toBe(r.receipt?.costUsd);
    expect(session.world.images).toBeUndefined();
    expect((await g.log())[0]).toMatchObject({ outcome: 'unknown' });
  });

  it.each([
    ['server', 500],
    ['refused', 400],
    ['bad_request', 400],
    ['no_key', 401],
  ])('%s is not retried and costs nothing', async (code, status) => {
    const provider = new Scripted(() => Promise.reject(err(code, false, status)));
    const g = gateway(provider);
    const r = await g.generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    expect(provider.seen).toHaveLength(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(code);
      expect(r.receipt?.costUsd).toBe(0);
    }
    expect(g.status().spend.sessionUsd).toBe(0);
  });

  it('a rate limit waits (retry-after) and tries again, at most twice; each attempt is in the receipt', async () => {
    const waits: number[] = [];
    const provider = new Scripted((n, req) =>
      n < 3 ? Promise.reject(err('rate_limited', false, 429, 3)) : fakePng(req),
    );
    const g = gateway(provider, { sleep: (ms: number) => (waits.push(ms), Promise.resolve()) });
    const r = await g.generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    expect(r.ok).toBe(true);
    expect(waits).toEqual([3000, 3000]);
    expect(r.receipt?.attempts.map((a) => a.status)).toEqual(['error', 'error', 'ok']);
    const always = new Scripted(() => Promise.reject(err('rate_limited', false, 429)));
    const r2 = await gateway(always).generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'p'.repeat(30),
    });
    expect(always.seen).toHaveLength(3);
    expect(r2.ok).toBe(false);
  });

  it('output that is not a PNG is invalid_output, and nothing is added', async () => {
    const provider = new Scripted(() =>
      Promise.resolve({ png: new Uint8Array([1, 2, 3]), usage: { outputTokens: 272 } }),
    );
    const g = gateway(provider);
    const r = await g.generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid_output');
    expect(session.world.images).toBeUndefined();
    // It was charged (usage reported), so it's counted.
    expect(g.status().spend.sessionUsd).toBeGreaterThan(0);
  });

  it('refuses a prompt with a key in it before anything is sent', async () => {
    const provider = new Scripted((_n, req) => fakePng(req));
    const r = await gateway(provider).generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'a picture of sk-proj-abcdefghijklmnopqrstuvwx',
    });
    expect(r.ok).toBe(false);
    expect(provider.seen).toHaveLength(0);
  });

  it('off: every call is disabled', async () => {
    const g = gateway(null, { offReason: 'No OpenAI key' });
    expect(g.status()).toMatchObject({ mode: 'off', enabled: false, reason: 'No OpenAI key' });
    const r = await g.generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('disabled');
  });

  it('cancel before the provider answers: cancelled, nothing added', async () => {
    const g = gateway(new FakeImageProvider({ delayMs: 200 }));
    const p = g.generate({
      requestId: 'r9',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    await new Promise((r) => setTimeout(r, 20));
    g.cancel('r9');
    const r = await p;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('cancelled');
    expect(session.world.images).toBeUndefined();
  });
});

describe('the budget', () => {
  it('pauses exactly at the session budget and resumes when it is raised', async () => {
    const g = gateway();
    // One fake low concept with a 20-char prompt costs exactly 0.004765.
    expect(
      session.dispatch([
        cmd('settings.set', {
          key: 'images',
          value: { budget: { sessionUsd: 0.00953, monthUsd: 10 } },
        }),
      ]).ok,
    ).toBe(true);
    for (let i = 0; i < 2; i++)
      expect(
        (
          await g.generate({
            requestId: `r${i}`,
            entityId: 'glide',
            kind: 'concept',
            prompt: `A glider over cloud${i}`,
          })
        ).ok,
      ).toBe(true);
    expect(g.status().paused).toBe(true);
    const r = await g.generate({
      requestId: 'r3',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('budget');
    session.dispatch([
      cmd('settings.set', { key: 'images', value: { budget: { sessionUsd: 1, monthUsd: 10 } } }),
    ]);
    expect(g.status().paused).toBe(false);
  });

  it('the month spend is read back from the log files', async () => {
    const g = gateway();
    await g.attach();
    await g.generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    await g.flush();
    const files = await readdir(path.join(dir, 'ai-log'));
    expect(files).toContain('images-2026-11-05.jsonl');
    const line = (
      await readFile(path.join(dir, 'ai-log', 'images-2026-11-05.jsonl'), 'utf8')
    ).trim();
    expect(ImageLogEntrySchema.safeParse(JSON.parse(line)).success).toBe(true);
    const again = gateway();
    await again.attach();
    expect(again.status().spend.monthUsd).toBeCloseTo(g.status().spend.sessionUsd, 12);
    expect(again.status().spend.sessionUsd).toBe(0);
    expect(await again.log()).toHaveLength(1);
  });
});

describe('batches', () => {
  it('plans prompts, skipping entities that have an image unless replace', async () => {
    const g = gateway();
    await g.generate({
      requestId: 'r',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    const plan = await g.batchPlan({
      kind: 'concept',
      entityIds: ['glide', 'cinder-sting', 'nope'],
    });
    expect(plan.items.map((i) => [i.entityId, i.skip ?? 'ok'])).toEqual([
      ['glide', 'has_image'],
      ['cinder-sting', 'ok'],
      ['nope', 'not_found'],
    ]);
    expect(plan.calls).toBe(1);
    expect(plan.estimate.totalUsd).toBeCloseTo(plan.estimate.perCallUsd, 12);
    const all = await g.batchPlan({
      kind: 'concept',
      entityIds: ['glide', 'cinder-sting'],
      replace: true,
    });
    expect(all.calls).toBe(2);
  });

  it('runs with concurrency 2, reports progress, and gives a result per item in order', async () => {
    let inFlight = 0;
    let most = 0;
    const provider = new Scripted(async (_n, req) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return fakePng(req);
    });
    const g = gateway(provider);
    const ids = ['glide', 'cinder-sting', 'spore-lantern', 'high-drift', 'hollows'];
    const progress: number[] = [];
    const r = await g.batchRun(
      {
        batchId: 'b1',
        kind: 'concept',
        items: ids.map((entityId) => ({ entityId, prompt: `Concept art of ${entityId}` })),
      },
      (p) => progress.push(p.done),
    );
    expect(most).toBe(2);
    expect(r.items.map((i) => i.entityId)).toEqual(ids);
    expect(r.items.every((i) => i.result.ok)).toBe(true);
    expect(progress.at(-1)).toBe(5);
    for (const id of ids) expect(session.world.images?.[id]?.concept).toBeDefined();
    expect(r.costUsd).toBeCloseTo(g.status().spend.sessionUsd, 12);
  });

  it('cancel stops starting new items; started ones finish or cancel', async () => {
    const g = gateway(new FakeImageProvider({ delayMs: 40 }));
    const ids = ['glide', 'cinder-sting', 'spore-lantern', 'high-drift', 'hollows'];
    const run = g.batchRun({
      batchId: 'b2',
      kind: 'concept',
      items: ids.map((entityId) => ({ entityId, prompt: `Concept art of ${entityId}` })),
    });
    await new Promise((r) => setTimeout(r, 10));
    g.cancel('b2');
    const r = await run;
    expect(r.cancelled).toBe(true);
    expect(r.items).toHaveLength(5);
    expect(
      r.items.filter((i) => !i.result.ok && i.result.error.code === 'cancelled').length,
    ).toBeGreaterThanOrEqual(3);
  });

  it('the budget stops a batch part way', async () => {
    const g = gateway();
    session.dispatch([
      cmd('settings.set', {
        key: 'images',
        value: { budget: { sessionUsd: 0.004, monthUsd: 10 } },
      }),
    ]);
    const ids = ['glide', 'cinder-sting', 'spore-lantern', 'high-drift'];
    const r = await g.batchRun({
      batchId: 'b3',
      kind: 'concept',
      items: ids.map((entityId) => ({ entityId, prompt: `Concept art of ${entityId}` })),
    });
    const codes = r.items.map((i) => (i.result.ok ? 'ok' : i.result.error.code));
    expect(codes.filter((c) => c === 'ok').length).toBeLessThanOrEqual(2);
    expect(codes).toContain('budget');
  });
});

describe('Delete image files', () => {
  it('purges only pixels of images no longer in the world, and images of deleted entities', async () => {
    const g = gateway();
    const a = await g.generate({
      requestId: 'a',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    const b = await g.generate({
      requestId: 'b',
      entityId: 'glide',
      kind: 'icon',
      prompt: 'A glider icon here',
    });
    const c = await g.generate({
      requestId: 'c',
      entityId: 'cinder-sting',
      kind: 'concept',
      prompt: 'A sting in cinders',
    });
    if (!a.ok || !b.ok || !c.ok) throw new Error('setup');
    session.dispatch([cmd('image.remove', { entity: 'glide', image: b.image.id })]);
    session.dispatch([cmd('entity.delete', { id: 'cinder-sting' })]);
    // Images of a deleted entity stay in the world until purged (undoing the delete keeps them).
    expect(session.world.images?.['cinder-sting']).toBeDefined();
    await session.flush();
    const r = await g.deleteFiles();
    expect(r.removed).toBe(3); // b's png and src, c's png
    expect(session.world.images?.['cinder-sting']).toBeUndefined();
    await session.flush();
    await expect(stat(path.join(dir, imagePaths('glide', a.image.id).png))).resolves.toBeTruthy();
    await expect(stat(path.join(dir, 'images', 'cinder-sting'))).rejects.toThrow();
    const meta: unknown = JSON.parse(
      await readFile(path.join(dir, imagePaths('glide', a.image.id).json), 'utf8'),
    );
    expect(ImageMetaSchema.parse(meta)).toEqual(a.image);
  });
});

describe('.gitattributes', () => {
  it('the first image marks PNGs binary in the world, once, keeping existing lines', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dir, '.gitattributes'), '*.md text eol=lf');
    const g = gateway();
    await g.generate({
      requestId: 'a',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds',
    });
    await g.generate({
      requestId: 'b',
      entityId: 'glide',
      kind: 'concept',
      prompt: 'A glider over clouds 2',
    });
    expect(await readFile(path.join(dir, '.gitattributes'), 'utf8')).toBe(
      '*.md text eol=lf\n*.png binary\n',
    );
  });
});

describe('icons always ask for a transparent background', () => {
  // gpt-image-2.5-flare paints a fake checkerboard into the pixels unless asked explicitly.
  it.each(['gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-flare'] as const)(
    '%s: generated icons, icons edited from a concept, and sheets',
    async (model) => {
      const provider = new Scripted((_n, req) => fakePng(req));
      const g = gateway(provider);
      const c = await g.generate({
        requestId: 'c',
        entityId: 'glide',
        kind: 'concept',
        prompt: 'A glider over clouds',
        model,
      });
      if (!c.ok) throw new Error('concept failed');
      await g.generate({
        requestId: 'i',
        entityId: 'glide',
        kind: 'icon',
        prompt: 'A glider icon here',
        model,
      });
      await g.generate({
        requestId: 'e',
        entityId: 'glide',
        kind: 'icon',
        prompt: 'A glider icon here',
        model,
        reference: c.image.id,
      });
      await g.sheetRun({
        batchId: 's',
        model,
        items: [{ entityId: 'glide', line: 'Glide, a capability' }],
      });
      expect(
        provider.seen.map((r) => [r.model, r.background, r.reference ? 'edit' : 'generate']),
      ).toEqual([
        [model, 'auto', 'generate'],
        [model, 'transparent', 'generate'],
        [model, 'transparent', 'edit'],
        [model, 'transparent', 'edit'],
      ]);
    },
  );
});
