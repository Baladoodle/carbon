import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { FakeAiGateway } from '@core/ai/fake';
import { cmd } from '@core/commands/registry';
import type { ImageKind, ImageModel, ImageSize } from '@core/images/model';
import { imagePaths } from '@core/images/model';
import { fakeImagePrompt } from '@core/images/prompt';
import { sampleWorld } from '@core/testing/sample';
import { resetDiskState } from '../store/disk-state';
import { writeWorldDir } from '../store/world-dir';
import { WorldSession } from '../world-session';
import { MainImageGateway } from './gateway';
import { resolveOpenAiKey } from './key';
import { decodePng } from './png';
import { OpenAiImageProvider } from './provider';

/**
 * `npm run smoke:images` (scripts/smoke-images.mjs): real, low-quality calls
 * through the real gateway, recorded as fixtures. Never part of `npm test`.
 */
const ROOT = path.resolve(import.meta.dirname, '../../..');
const OUT = path.join(ROOT, 'fixtures/images');
const LEDGER = path.join(OUT, 'ledger.json');
const MAX = Number(process.env.CARBON_IMAGES_MAX_CALLS ?? '12');

interface Plan {
  name: string;
  entity: string;
  kind: ImageKind;
  model: ImageModel;
  size?: ImageSize;
  /** The name of an earlier plan whose concept is the reference (an edit). */
  reference?: string;
}

const PLANS: Plan[] = [
  {
    name: 'cloud-reef-concept-flare',
    entity: 'cloud-reef',
    kind: 'concept',
    model: 'gpt-image-2.6-flare',
    size: '1536x1024',
  },
  {
    name: 'spore-lantern-icon-flare',
    entity: 'spore-lantern',
    kind: 'icon',
    model: 'gpt-image-2.6-flare',
  },
  {
    name: 'spore-lantern-concept-flare',
    entity: 'spore-lantern',
    kind: 'concept',
    model: 'gpt-image-2.6-flare',
    size: '1024x1024',
  },
  {
    name: 'spore-lantern-icon-edit-flare',
    entity: 'spore-lantern',
    kind: 'icon',
    model: 'gpt-image-2.6-flare',
    reference: 'spore-lantern-concept-flare',
  },
  {
    name: 'glowmoss-caverns-concept-sunburst',
    entity: 'glowmoss-caverns',
    kind: 'concept',
    model: 'gpt-image-2.6-sunburst',
    size: '1536x1024',
  },
  {
    name: 'cinder-sting-icon-sunburst',
    entity: 'cinder-sting',
    kind: 'icon',
    model: 'gpt-image-2.6-sunburst',
  },
  {
    name: 'cloud-anklet-icon-flare',
    entity: 'cloud-anklet',
    kind: 'icon',
    model: 'gpt-image-2.6-flare',
  },
];

interface Ledger {
  calls: { at: string; name: string; outcome: string; costUsd: number; requestId?: string }[];
}

const enabled = process.env.CARBON_IMAGES_SMOKE === '1';

describe.skipIf(!enabled)('real OpenAI image calls (low quality)', () => {
  it('generates, edits and records fixtures', async () => {
    const found = resolveOpenAiKey();
    const apiKey =
      found?.key ?? (process.env.CARBON_IMAGES_SMOKE_PROXY === '1' ? 'sk-proxy' : undefined);
    if (!apiKey) {
      console.log(
        'Image smoke test skipped: no OpenAI key (keyring or OPENAI_API_KEY), and --proxy not given.',
      );
      return;
    }
    console.log(
      `Image smoke test: key from ${found?.source ?? 'the network proxy (placeholder sent)'}.`,
    );
    const ledger: Ledger = JSON.parse(
      await readFile(LEDGER, 'utf8').catch(() => '{"calls":[]}'),
    ) as Ledger;
    const only = process.env.CARBON_IMAGES_SMOKE_ONLY;
    const plans = PLANS.filter((p) => !only || only.split(',').includes(p.name));
    if (ledger.calls.length + plans.length > MAX)
      throw new Error(
        `refusing: ${ledger.calls.length} real calls recorded, ${plans.length} more would pass the cap of ${MAX}`,
      );

    const dir = await mkdtemp(path.join(os.tmpdir(), 'carbon-image-smoke-'));
    await writeWorldDir(dir, sampleWorld());
    resetDiskState(dir);
    const session = await WorldSession.open(dir);
    session.dispatch([
      cmd('art.set', {
        direction: 'painterly, muted earth tones, soft rim light, readable silhouettes',
      }),
      cmd('settings.set', { key: 'images', value: { budget: { sessionUsd: 0.5, monthUsd: 10 } } }),
    ]);
    const client = new OpenAI({
      apiKey,
      baseURL: 'https://api.openai.com/v1',
      maxRetries: 0,
      timeout: 180_000,
    });
    const g = new MainImageGateway({
      session,
      ai: new FakeAiGateway({ getWorld: () => session.world }),
      provider: new OpenAiImageProvider(client),
      mode: 'real',
      rateLimitRetries: 0,
    });
    const ids = new Map<string, string>();
    const records: unknown[] = [];
    await mkdir(OUT, { recursive: true });
    try {
      for (const p of plans) {
        const prompt = fakeImagePrompt(session.world, p.entity, p.kind);
        const reference = p.reference ? ids.get(p.reference) : undefined;
        if (p.reference && !reference) {
          console.log(`${p.name}: skipped (its reference ${p.reference} wasn't made)`);
          continue;
        }
        const t0 = Date.now();
        const r = await g.generate({
          requestId: p.name,
          entityId: p.entity,
          kind: p.kind,
          prompt,
          model: p.model,
          quality: 'low',
          ...(p.size ? { size: p.size } : {}),
          ...(reference ? { reference } : {}),
        });
        const ms = Date.now() - t0;
        const receipt = r.receipt;
        for (const a of receipt?.attempts ?? [])
          ledger.calls.push({
            at: a.at,
            name: p.name,
            outcome: a.status,
            costUsd: a.costUsd,
            ...(a.requestId ? { requestId: a.requestId } : {}),
          });
        await writeFile(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
        const a = receipt?.attempts.at(-1);
        console.log(
          `${p.name}: ${r.ok ? 'ok' : `${r.error.code}: ${r.error.message}`} · ${a?.model} ${a?.quality} ${a?.size} ${a?.endpoint} · usage ${JSON.stringify(a?.usage ?? null)} · $${(receipt?.costUsd ?? 0).toFixed(5)} (${a?.costFrom}) · ${ms} ms`,
        );
        records.push({
          name: p.name,
          entity: p.entity,
          kind: p.kind,
          prompt,
          ok: r.ok,
          ...(r.ok ? {} : { error: r.error }),
          attempts: receipt?.attempts ?? [],
          costUsd: receipt?.costUsd ?? 0,
          ...(r.ok
            ? { image: { id: r.image.id, width: r.image.width, height: r.image.height } }
            : {}),
        });
        if (!r.ok) continue;
        ids.set(p.name, r.image.id);
        const files = imagePaths(p.entity, r.image.id);
        // The provider's image (icons: the source before the filter), and the icon itself.
        if (p.kind === 'icon') {
          await copyFile(path.join(dir, files.src), path.join(OUT, `${p.name}.src.png`));
          await copyFile(path.join(dir, files.png), path.join(OUT, `${p.name}.png`));
        } else await copyFile(path.join(dir, files.png), path.join(OUT, `${p.name}.png`));
        const src = decodePng(
          await readFile(path.join(OUT, p.kind === 'icon' ? `${p.name}.src.png` : `${p.name}.png`)),
        );
        console.log(`  provider image ${src.width}×${src.height}`);
      }
      const prev = JSON.parse(
        await readFile(path.join(OUT, 'calls.json'), 'utf8').catch(() => '[]'),
      ) as unknown[];
      await writeFile(
        path.join(OUT, 'calls.json'),
        `${JSON.stringify([...prev, ...records], null, 2)}\n`,
      );
      const total = ledger.calls.reduce((n, c) => n + c.costUsd, 0);
      console.log(
        `Real calls so far: ${ledger.calls.length} of ${MAX}; spend $${total.toFixed(4)}.`,
      );
      // Nothing here may contain the key.
      for (const f of ['calls.json', 'ledger.json']) {
        const text = await readFile(path.join(OUT, f), 'utf8');
        expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{16,}/);
        if (found) expect(text.includes(found.key)).toBe(false);
      }
      expect(records.some((x) => (x as { ok: boolean }).ok)).toBe(true);
    } finally {
      await session.flush();
      await g.flush();
      resetDiskState(dir);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
