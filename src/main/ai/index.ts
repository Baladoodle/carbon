import Anthropic from '@anthropic-ai/sdk';
import type { AiGateway } from '@core/ai/gateway';
import { FakeAiGateway } from '@core/ai/fake';
import { OffAiGateway } from '@core/ai/off';
import type { World } from '@core/model/world';
import { ClaudeAiGateway } from './gateway';

/**
 * Chooses the AI gateway for this run.
 *
 *  - `CARBON_AI=fake`  FakeAiGateway (tests, e2e, UI work; `CARBON_AI_DELAY_MS` adds latency)
 *  - `CARBON_AI=off`   always off
 *  - otherwise         the Claude API gateway if `ANTHROPIC_API_KEY` is set, else off ("no API key")
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
  if (!process.env.ANTHROPIC_API_KEY)
    return new OffAiGateway('No API key: set ANTHROPIC_API_KEY to turn the AI on');
  return new ClaudeAiGateway({ getWorld, client: createClaudeClient() });
}

/**
 * The SDK client. The official endpoint explicitly: `ANTHROPIC_BASE_URL` may
 * point elsewhere in tooling environments, and carbon only talks to the public
 * API. The SDK reads the key from `ANTHROPIC_API_KEY`; carbon never stores,
 * logs or prints it. Retries are the gateway's own (typed, abortable), so the
 * SDK's are off.
 */
export function createClaudeClient(): Anthropic {
  return new Anthropic({ baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 120_000 });
}

export { ClaudeAiGateway } from './gateway';
