import type { AiGateway, AiLogEntry, AiOutcome, AiStatus } from './gateway';
import type { Moment } from './moments';

/** An `AiGateway` that is always off (no key, or AI not configured). Surfaces say why. */
export class OffAiGateway implements AiGateway {
  constructor(private readonly reason: string) {}

  status(): AiStatus {
    return {
      mode: 'off',
      enabled: false,
      reason: this.reason,
      model: 'none',
      spend: { sessionUsd: 0, monthUsd: 0 },
      budget: { sessionUsd: 0, monthUsd: 0 },
      paused: false,
      pending: 0,
    };
  }

  onStatus(): () => void {
    return () => undefined;
  }

  setEnabled(): void {
    // Always off.
  }

  log(): Promise<AiLogEntry[]> {
    return Promise.resolve([]);
  }

  run<M extends Moment>(): Promise<AiOutcome<M>> {
    return Promise.resolve({
      ok: false,
      error: { code: 'disabled', message: this.reason, retryable: false },
    });
  }
}
