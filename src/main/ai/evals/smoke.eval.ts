import { expect, it } from 'vitest';
import { sampleWorld } from '@core/testing/sample';
import { createClaudeClient } from '../index';
import { ClaudeAiGateway } from '../gateway';

/**
 * `npm run smoke:ai`: two real critiques through the real gateway (packer,
 * request shape, SDK, validation, cost), the second one reading the first's
 * cached prefix. Prints only outcomes, usage and cost, never the key.
 */
it('smoke: the real gateway against the Claude API', async () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const world = sampleWorld();
  world.settings.ai = { budget: { sessionUsd: 0.05, monthUsd: 20 } };
  const g = new ClaudeAiGateway({ getWorld: () => world, client: createClaudeClient() });
  const results = [];
  for (const entityId of ['glide', 'cinder-wasp']) {
    const out = await g.run('critique', { entityId, trigger: 'on_demand' });
    const line = {
      entityId,
      ok: out.ok,
      ...(out.ok
        ? { notes: out.result.notes.length }
        : { error: out.error.code, message: out.error.message }),
      usage: out.meta?.usage,
      costUsd: out.meta?.costUsd,
      latencyMs: out.meta?.latencyMs,
    };
    console.log(JSON.stringify(line));
    results.push(out);
  }
  console.log(JSON.stringify({ spendUsd: g.status().spend.sessionUsd }));
  for (const r of results) expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
  const second = results[1];
  if (second?.ok) console.log(JSON.stringify({ cacheReadOnSecond: second.meta.usage.cacheRead }));
});
