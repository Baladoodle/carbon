import type { AiGateway } from '@core/ai/gateway';
import { FakeAiGateway } from '@core/ai/fake';
import { OffAiGateway } from '@core/ai/off';
import type { World } from '@core/model/world';

/**
 * Chooses the AI gateway for this run. Package W4 replaces the real branch with
 * its Claude API gateway; keep the `CARBON_AI=fake` and `off` branches.
 *
 *  - `CARBON_AI=fake`  FakeAiGateway (tests, e2e, UI work; `CARBON_AI_DELAY_MS` adds latency)
 *  - `CARBON_AI=off`   always off
 *  - otherwise         real if `ANTHROPIC_API_KEY` is set (W4), else off ("no API key")
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
  return new OffAiGateway('The Claude API gateway is not built yet (package W4)');
}
