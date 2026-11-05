import Anthropic from '@anthropic-ai/sdk';
import type { AiGateway } from '@core/ai/gateway';
import { FakeAiGateway } from '@core/ai/fake';
import { OffAiGateway } from '@core/ai/off';
import type { World } from '@core/model/world';
import { ClaudeAiGateway } from './gateway';
import { NO_KEY_REASON, resolveApiKey } from './key';
import { loadRecorded, replayFetch } from './replay';

/**
 * Chooses the AI gateway for this run.
 *
 *  - `CARBON_AI=fake`  FakeAiGateway (tests, e2e, UI work; `CARBON_AI_DELAY_MS` adds latency)
 *  - `CARBON_AI=off`   always off
 *  - `CARBON_AI=replay` the real gateway over an offline API (recorded fixtures in
 *                     `CARBON_AI_FIXTURES`, else answers generated from each request's schema)
 *  - otherwise         the Claude API gateway if there's a key (the system keyring, then
 *                     `ANTHROPIC_API_KEY`; see key.ts), else off ("no API key")
 */
export function createAiGateway(getWorld: () => World): AiGateway {
  const mode = process.env.CARBON_AI;
  if (mode === 'fake') {
    const delay = Number(process.env.CARBON_AI_DELAY_MS ?? '0');
    return new FakeAiGateway({
      getWorld,
      delayMs: Number.isFinite(delay) ? delay : 0,
      now: () => new Date().toISOString(),
    });
  }
  if (mode === 'off') return new OffAiGateway('AI is turned off (CARBON_AI=off)');
  if (mode === 'replay') {
    // The real gateway over an offline Claude API (src/main/ai/replay.ts): e2e and demos.
    const delay = Number(process.env.CARBON_AI_DELAY_MS ?? '0');
    const dir = process.env.CARBON_AI_FIXTURES;
    const fetch = replayFetch({
      ...(dir ? { recorded: loadRecorded(dir) } : {}),
      delayMs: Number.isFinite(delay) ? delay : 0,
    });
    return new ClaudeAiGateway({
      getWorld,
      client: new Anthropic({
        apiKey: 'replay',
        baseURL: 'https://api.anthropic.com',
        fetch,
        maxRetries: 0,
      }),
    });
  }
  const key = resolveApiKey();
  if (!key) return new OffAiGateway(NO_KEY_REASON);
  return new ClaudeAiGateway({ getWorld, client: createClaudeClient(key.key) });
}

/**
 * The SDK client. The official endpoint explicitly: `ANTHROPIC_BASE_URL` may
 * point elsewhere in tooling environments, and carbon only talks to the public
 * API. The key comes from `resolveApiKey()` (keyring, then environment); carbon
 * never stores, logs or prints it. Retries are the gateway's own (typed,
 * abortable), so the SDK's are off.
 */
export function createClaudeClient(apiKey = resolveApiKey()?.key): Anthropic {
  return new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    baseURL: 'https://api.anthropic.com',
    maxRetries: 0,
    timeout: 120_000,
  });
}

export { ClaudeAiGateway } from './gateway';
