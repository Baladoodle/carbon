import type Anthropic from '@anthropic-ai/sdk';
import type { BuiltPrompt } from '@core/prompts/types';
import { hashValue } from '@core/util/hash';

/**
 * Maps a provider-neutral `BuiltPrompt` onto the Messages API. The return
 * types are the SDK's own param types, so `tsc` checks the request shape
 * against the SDK (and request.test.ts checks every moment's shape).
 *
 * Shape rules this follows (Haiku 5.5):
 *  - no `temperature`, `top_p` or `top_k`, and no assistant prefill (both 400)
 *  - adaptive thinking is the default, so `thinking` is omitted; depth is
 *    `output_config.effort`
 *  - structured output through `output_config.format` (`json_schema`)
 *  - cache breakpoints (`cache_control: ephemeral`) after the stable system
 *    blocks, at most 4; the per-request user turn comes after all of them
 */
export const MAX_BREAKPOINTS = 4;

export type MessageParams = Anthropic.MessageCreateParamsNonStreaming;

export function toMessageParams(p: BuiltPrompt, model: string): MessageParams {
  let breakpoints = 0;
  const system: Anthropic.TextBlockParam[] = p.system
    .filter((b) => b.text !== '')
    .map((b) => {
      const block: Anthropic.TextBlockParam = { type: 'text', text: b.text };
      if (b.cache && breakpoints < MAX_BREAKPOINTS) {
        breakpoints++;
        block.cache_control = { type: 'ephemeral' };
      }
      return block;
    });
  const user: Anthropic.TextBlockParam[] = p.user
    .filter((b) => b.text !== '')
    .map((b) => ({ type: 'text', text: b.text }));
  return {
    model,
    max_tokens: p.maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
    output_config: { effort: p.effort, format: { type: 'json_schema', schema: p.schema } },
  };
}

/** The params for `count_tokens` (same prompt, no output settings). */
export function toCountParams(params: MessageParams): Anthropic.MessageCountTokensParams {
  return {
    model: params.model,
    messages: params.messages,
    ...(params.system ? { system: params.system } : {}),
    ...(params.output_config ? { output_config: params.output_config } : {}),
  };
}

/**
 * The content-hash cache key (SYSTEM §8 step 4): the canonical request plus the
 * moment. Key order doesn't matter (`hashValue` canonicalises).
 */
export function cacheKey(moment: string, params: MessageParams): string {
  return hashValue({ moment, params });
}
