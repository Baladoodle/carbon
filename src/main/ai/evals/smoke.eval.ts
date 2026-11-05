import { expect, it } from 'vitest';
import type { AiCallMeta, AiOutcome } from '@core/ai/gateway';
import type { Moment } from '@core/ai/moments';
import { sampleWorld } from '@core/testing/sample';
import { createClaudeClient } from '../index';
import { ClaudeAiGateway } from '../gateway';

/**
 * `npm run smoke:ai` (scripts/smoke-ai.mjs): three small real requests through
 * the real gateway (packer, request shape, SDK, validation, cost):
 *
 *  1. a critique of Glide        (writes the shared cached prefix)
 *  2. a critique of Cinder Wasp  (should read that prefix from the cache)
 *  3. a streamed Fill spread of 3 candidates (streaming + partial JSON)
 *
 * Prints one line per call and a verdict; never the key. Capped at $0.05.
 */
const HINTS: Record<string, string> = {
  no_key: 'The key was rejected. Check it in the Console, and that it may use claude-haiku-5-5.',
  bad_request: 'The API rejected the request shape. Copy this line into a bug report.',
  rate_limited: 'Rate limited. Wait a minute and run it again.',
  server: 'The API is overloaded or failing. Run it again later.',
  network: 'Could not reach api.anthropic.com. Check the network or proxy.',
  budget: 'The smoke budget was reached.',
  refused: 'The model declined the request (stop_reason "refusal").',
  truncated: 'The answer hit max_tokens.',
  invalid_output: 'The answer did not match the schema.',
};

const fmt = (n: number): string => n.toLocaleString('en-US');

function line(label: string, out: AiOutcome<Moment>, detail: string): string {
  const m: AiCallMeta | undefined = out.meta;
  const usage = m
    ? `in ${fmt(m.usage.input)} · cache read ${fmt(m.usage.cacheRead)} · cache write ${fmt(m.usage.cacheWrite)} · out ${fmt(m.usage.output)} · $${m.costUsd.toFixed(5)} · ${(m.latencyMs / 1000).toFixed(1)} s`
    : 'no usage';
  if (out.ok) return `  ok    ${label}: ${detail} · ${usage}`;
  return `  FAIL  ${label}: ${out.error.code}: ${out.error.message} · ${usage}\n        ${HINTS[out.error.code] ?? ''}`;
}

it('smoke: the real gateway against the Claude API', async () => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('no API key (run it with npm run smoke:ai)');
  const world = sampleWorld();
  world.settings.ai = { budget: { sessionUsd: 0.05, monthUsd: 20 } };
  const g = new ClaudeAiGateway({ getWorld: () => world, client: createClaudeClient() });
  const lines: string[] = ['', 'carbon AI smoke test (claude-haiku-5-5)'];
  const outs: AiOutcome<Moment>[] = [];

  for (const entityId of ['glide', 'cinder-wasp']) {
    const out = await g.run('critique', { entityId, trigger: 'on_demand' });
    outs.push(out);
    lines.push(line(`critique ${entityId}`, out, out.ok ? `${out.result.notes.length} notes` : ''));
  }
  let streamed = 0;
  const spread = await g.run(
    'spread',
    { spot: { type: 'cell', band: 'low-sky', lane: 'items' }, move: 'fill', count: 3 },
    { onPartial: () => streamed++ },
  );
  outs.push(spread);
  lines.push(
    line(
      'spread (fill, 3)',
      spread,
      spread.ok ? `${spread.result.candidates.length} candidates, ${streamed} streamed` : '',
    ),
  );

  const cacheRead = outs[1]?.meta?.usage.cacheRead ?? 0;
  const failed = outs.filter((o) => !o.ok).length;
  lines.push(
    '',
    `  spend: $${g.status().spend.sessionUsd.toFixed(5)}`,
    cacheRead > 0
      ? `  caching: the second critique read ${fmt(cacheRead)} tokens from the cache`
      : '  caching: the second critique read nothing from the cache (see docs/AI-FIRST-RUN.md)',
    failed === 0 ? '  verdict: OK' : `  verdict: ${failed} of ${outs.length} failed`,
    '',
  );
  console.log(lines.join('\n'));
  for (const o of outs) expect(o.ok, o.ok ? '' : `${o.error.code}: ${o.error.message}`).toBe(true);
  expect(streamed).toBeGreaterThan(0);
});
