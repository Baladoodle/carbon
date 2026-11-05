import OpenAI from 'openai';
import type { AiGateway } from '@core/ai/gateway';
import { IMAGE_ERROR_CODES, type ImageErrorCode } from '@core/images/gateway';
import { MainImageGateway, type ImageSession } from './gateway';
import { NO_OPENAI_KEY_REASON, resolveOpenAiKey } from './key';
import { FakeImageProvider, OpenAiImageProvider } from './provider';

/**
 * Chooses the image gateway for this run.
 *
 *  - `CARBON_IMAGES=fake`  the whole pipeline over a deterministic provider (tests, e2e, UI work;
 *                          `CARBON_IMAGES_DELAY_MS` adds latency, `CARBON_IMAGES_FAIL=<code>` fails every call)
 *  - `CARBON_IMAGES=off`   off
 *  - otherwise             OpenAI if there's a key (keyring, then OPENAI_API_KEY; see key.ts), else off
 */
export function createImageGateway(session: ImageSession, ai: AiGateway): MainImageGateway {
  const mode = process.env.CARBON_IMAGES;
  if (mode === 'fake') {
    const delay = Number(process.env.CARBON_IMAGES_DELAY_MS ?? '0');
    const failWith = process.env.CARBON_IMAGES_FAIL as ImageErrorCode | undefined;
    return new MainImageGateway({
      session,
      ai,
      mode: 'fake',
      provider: new FakeImageProvider({
        delayMs: Number.isFinite(delay) ? delay : 0,
        ...(failWith && (IMAGE_ERROR_CODES as readonly string[]).includes(failWith)
          ? { failWith }
          : {}),
      }),
    });
  }
  if (mode === 'off')
    return new MainImageGateway({
      session,
      ai,
      provider: null,
      offReason: 'Images are off (CARBON_IMAGES=off)',
    });
  const key = resolveOpenAiKey();
  if (!key)
    return new MainImageGateway({ session, ai, provider: null, offReason: NO_OPENAI_KEY_REASON });
  return new MainImageGateway({
    session,
    ai,
    mode: 'real',
    provider: new OpenAiImageProvider(createOpenAiClient(key.key)),
  });
}

/**
 * The SDK client, on the official endpoint (`OPENAI_BASE_URL` may point
 * elsewhere in tooling environments). Retries are off: the gateway decides,
 * and never retries a call whose outcome is unknown.
 */
export function createOpenAiClient(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: 'https://api.openai.com/v1',
    maxRetries: 0,
    timeout: 180_000,
  });
}

export { MainImageGateway } from './gateway';
