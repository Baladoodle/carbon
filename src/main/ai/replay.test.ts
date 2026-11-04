import Anthropic from '@anthropic-ai/sdk';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Candidate } from '@core/ai/moments';
import { sampleWorld } from '@core/testing/sample';
import { messageBody } from './fixtures';
import { ClaudeAiGateway } from './gateway';
import { toMessageParams } from './request';
import { loadRecorded, replayFetch, requestKey, synthesize } from './replay';
import { createPromptRegistry } from '@core/prompts/registry';
import { seededRandom } from '@core/util/hash';

const world = sampleWorld();
const gateway = (fetch: typeof globalThis.fetch): ClaudeAiGateway =>
  new ClaudeAiGateway({
    getWorld: () => world,
    client: new Anthropic({
      apiKey: 'replay',
      baseURL: 'https://api.anthropic.com',
      fetch,
      maxRetries: 0,
    }),
  });

describe('replay (the real gateway, offline)', () => {
  it('answers every moment with schema-shaped output, streaming spreads', async () => {
    const g = gateway(replayFetch());
    expect((await g.run('critique', { entityId: 'glide', trigger: 'on_demand' })).ok).toBe(true);
    const seen: Candidate[] = [];
    const s = await g.run(
      'spread',
      { spot: { type: 'cell', band: 'hollows', lane: 'creatures' }, move: 'fill', count: 5 },
      { onPartial: (c) => seen.push(c) },
    );
    if (!s.ok) throw new Error(s.error.message);
    expect(seen.length).toBe(s.result.candidates.length);
    expect(seen.length).toBeGreaterThan(0);
    const three = await g.run('suggest_three', { entityId: 'glide', field: 'name' });
    expect(three.ok).toBe(true);
    const spec = await g.run('spec_draft', { entityIds: ['glide'], name: 'Glide' });
    expect(spec.ok).toBe(true);
  });

  it('emulates prompt caching: the second request reads the shared prefix', async () => {
    const g = gateway(replayFetch());
    const a = await g.run('critique', { entityId: 'glide', trigger: 'on_demand' });
    const b = await g.run('critique', { entityId: 'cinder-wasp', trigger: 'on_demand' });
    expect(a.ok && a.meta.usage.cacheWrite).toBeGreaterThan(0);
    expect(b.ok && b.meta.usage.cacheRead).toBeGreaterThan(0);
  });

  it('serves recorded responses by request hash', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'carbon-rec-'));
    try {
      const built = createPromptRegistry()
        .get('critique')!
        .build(world, { entityId: 'glide', trigger: 'on_demand' });
      if (!built.ok) throw new Error('build');
      const params = toMessageParams(built.value, 'claude-haiku-5-5');
      const recorded = {
        key: requestKey(params as unknown as Record<string, unknown>),
        moment: 'critique',
        request: params,
        response: messageBody({
          text: JSON.stringify({
            notes: [
              {
                kind: 'weak_identity',
                text: 'Recorded note.',
                entities: [],
                field: null,
                ruleId: null,
              },
            ],
          }),
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4000 },
        }),
      };
      await writeFile(path.join(dir, 'critique-glide.json'), JSON.stringify(recorded));
      await writeFile(path.join(dir, 'broken.json'), '{');
      const map = loadRecorded(dir);
      expect(map.size).toBe(1);
      const out = await gateway(replayFetch({ recorded: map })).run('critique', {
        entityId: 'glide',
        trigger: 'on_demand',
      });
      if (!out.ok) throw new Error(out.error.message);
      expect(out.result.notes[0]!.text).toBe('Recorded note.');
      expect(out.meta.usage.cacheRead).toBe(4000);
      expect(loadRecorded(path.join(dir, 'missing')).size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('synthesises values for every schema shape deterministically', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        b: { type: 'string', enum: ['x', 'y'] },
        c: { type: 'array', items: { type: 'number' } },
        d: { type: 'boolean' },
        e: { type: 'mystery' },
      },
    };
    expect(synthesize(schema, seededRandom('s'))).toEqual(synthesize(schema, seededRandom('s')));
  });
});
