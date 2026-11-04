import type { Candidate, Moment, MomentPartial, MomentResult, MOMENT_SCHEMAS } from '../ai/moments';
import type { PackedContext, PackOptions } from '../context/packer';
import type { EntityId } from '../model/ids';
import type { World } from '../model/world';
import type { Result } from '../util/result';
import type { z } from 'zod';

/**
 * The prompt-builder contract (docs/SYSTEM.md §8 steps 2, 3 and 6). A builder
 * turns a moment's request plus the world into a provider-neutral prompt, and
 * turns the model's raw JSON back into the moment's validated result. It is
 * pure: no SDK, no I/O, no clock. The gateway in `src/main/ai` maps a
 * `BuiltPrompt` onto the Anthropic Messages API.
 *
 * Packages register builders through `src/core/prompts/registry.ts`
 * (see docs/build-notes/ai.md §1).
 */

/** `output_config.effort` levels. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** A JSON Schema object for structured outputs (`output_config.format`). */
export type JsonSchema = { [key: string]: unknown };

/**
 * One block of prompt text. `cache: true` puts a cache breakpoint after it:
 * everything up to and including it is the cached prefix. At most 4 per prompt.
 */
export interface PromptBlock {
  /** What the block holds, for the AI log ("instructions", "digest", "taste", "focus" …). */
  label: string;
  text: string;
  cache?: boolean;
}

export interface BuiltPrompt {
  moment: Moment;
  /**
   * The system prompt, stable parts first: the role and the moment's
   * instructions, then the world digest, then taste. Each usually ends in a
   * cache breakpoint.
   */
  system: PromptBlock[];
  /** The user turn: the focus and the ask. Changes per request; after the breakpoints. */
  user: PromptBlock[];
  /** Structured output schema. */
  schema: JsonSchema;
  effort: Effort;
  maxTokens: number;
  /** Stream the response (spreads). */
  stream: boolean;
  /** The entity the request is about: one request per entity at a time. */
  entity?: EntityId;
  /** Local token estimate for the whole request. */
  estimate: number;
  /** What the packer included, for the AI log. */
  pack?: Pick<PackedContext, 'included' | 'omitted' | 'digestLevel' | 'tokens'>;
}

/** Per-request options a gateway passes to a builder (from settings). */
export interface BuildOptions {
  effort?: Effort;
  maxTokens?: number;
  pack?: PackOptions;
}

export type ParsedRequest<M extends Moment> = z.output<(typeof MOMENT_SCHEMAS)[M]['request']>;

/** The outcome of parsing a model's output: the result plus how many items were dropped as invalid. */
export type ParseOutcome<M extends Moment> = Result<{ result: MomentResult<M>; dropped: number }>;

/** Incremental parsing for streamed moments: an array in the output whose items arrive one by one. */
export interface StreamSpec<M extends Moment> {
  /** The top-level key of the streamed array, e.g. `candidates`. */
  arrayKey: string;
  /** Validates one raw item; `null` drops it (counted as dropped). */
  item: (
    raw: unknown,
    index: number,
    world: World,
    request: ParsedRequest<M>,
  ) => MomentPartial<M> | null;
}

export interface PromptBuilder<M extends Moment = Moment> {
  moment: M;
  /** Defaults the gateway uses unless settings override them. */
  defaults: { effort: Effort; maxTokens: number; stream: boolean };
  /** Builds the prompt. Errors use codes `not_found` (missing entity) or `bad_request`. */
  build: (world: World, request: ParsedRequest<M>, options?: BuildOptions) => Result<BuiltPrompt>;
  /** Validates the model's parsed JSON against the world: drops what's invalid, counts it. */
  parse: (raw: unknown, world: World, request: ParsedRequest<M>) => ParseOutcome<M>;
  stream?: StreamSpec<M>;
}

/** A builder for any one moment (what the registry holds). */
export type AnyPromptBuilder = { [K in Moment]: PromptBuilder<K> }[Moment];

/** Shorthand for spread partials. */
export type CandidatePartial = Candidate;
