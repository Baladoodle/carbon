import type { Moment } from '../ai/moments';
import { packContext, type PackOptions, type PackedContext } from '../context/packer';
import type { Focus } from '../context/relevance';
import { clipToTokens, estimateBlocks, estimateTokens } from '../context/tokens';
import type { EntityId } from '../model/ids';
import type { World } from '../model/world';
import type { BuildOptions, BuiltPrompt, Effort, JsonSchema, PromptBlock } from './types';

/**
 * Shared prompt text and the one function every builder uses to assemble a
 * prompt, so that every moment has the same cache-friendly layout:
 *
 *   system[0] role                (static, shared by every moment)
 *   system[1] world digest        (slow-changing)       ← cache breakpoint
 *   system[2] taste               (slow-changing)       ← cache breakpoint
 *   system[3] moment instructions (static per moment)   ← cache breakpoint
 *   user[0]   focus + neighbours  (per request)
 *   user[1]   the ask             (per request)
 *
 * The role, digest and taste come before the moment's instructions so the
 * cached prefix is shared across moments: a critique right after a suggestion
 * on the same world reads the digest and taste from the cache.
 */

export const ROLE = `You are the design partner built into carbon, a design studio for Infinite.

Infinite is a game set in an endless vertical world. Everything has a place on its Y axis: the world is divided into horizontal bands, from endless depths below to endless sky above, and each band holds biomes placed on a temperature × moisture plane. Bands and biomes hold materials, creatures and structures. The player's power grows through capabilities (what they can now do), items (armor, accessories, tools, weapons, consumables) and feats (deeds that reveal and unlock things). Numbers (variables, formulas, curves) hold it together.

The designer is building this world from scratch in carbon. You work at moments they choose: suggesting a field, filling an entity, critiquing one, generating candidates, drafting a spec. Whatever you produce arrives as a proposal; nothing changes without their keypress.

How to work:
- Ground everything in THIS world: its bands, biomes, entities and the designer's taste below. Never import generic fantasy or other games' content, names or mechanics.
- Respect the designer's rules absolutely. Patterns and kill reasons show what they keep and what they reject; lean toward the first and away from the second.
- Identity over numbers. Something that is "just a number" (+10% damage, a stat bump) is the most common reason ideas get killed. Every proposal should change what the player does, feels or decides.
- Use the world's own voice: short, concrete, evocative names; one-line identities that say what a thing is and why it matters.
- Refer to entities only by the ids that appear in the context, exactly as written. Never invent ids. Never reuse the name of an existing entity for something new.
- Be brief. Every word you write is read by someone deciding quickly.
- Answer only with JSON matching the required schema.`;

/** Turns a structured value into a compact prompt string. */
export const quote = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

export interface AssembleInput {
  moment: Moment;
  world: World;
  focus: Focus;
  instructions: string;
  ask: string;
  schema: JsonSchema;
  defaults: { effort: Effort; maxTokens: number; stream: boolean };
  options?: BuildOptions;
  entity?: EntityId;
  /** Extra packer options from the builder (e.g. taste switches). */
  pack?: PackOptions;
}

/**
 * The most the ask (the per-request text a builder writes: current values,
 * values already shown, a spread's spot, judgements) may take. Builders keep
 * it small; this is the cap that keeps a request under 100k tokens whatever
 * the world holds.
 */
export const ASK_LIMIT = 15_000;

/**
 * Clips an ask to `max` tokens, keeping its last paragraph (the instruction
 * that ends every ask) and cutting the middle.
 */
export function clipAsk(ask: string, max = ASK_LIMIT): string {
  if (estimateTokens(ask) <= max) return ask;
  const split = ask.lastIndexOf('\n\n');
  const tail = split >= 0 ? clipToTokens(ask.slice(split + 2), Math.floor(max / 4)) : '';
  const head = split >= 0 ? ask.slice(0, split) : ask;
  const body = clipToTokens(head, max - estimateTokens(tail) - 2);
  return tail === '' ? body : `${body}\n\n${tail}`;
}

/** The estimate of the output schema, which counts as input tokens. */
export const schemaTokens = (schema: JsonSchema): number => estimateTokens(JSON.stringify(schema));

/** Packs the context and assembles the prompt. */
export function assemble(input: AssembleInput): BuiltPrompt {
  const { world, focus, instructions } = input;
  const ask = clipAsk(input.ask);
  const schemaCost = schemaTokens(input.schema);
  const reserved = estimateBlocks([ROLE, instructions, ask]) + schemaCost + 64;
  const packOptions: PackOptions = { ...input.pack, ...input.options?.pack, reserved };
  const packed: PackedContext = packContext(world, focus, packOptions);
  const focusText = [
    packed.focus === '' ? '' : `# In focus\n\n${packed.focus}`,
    packed.neighbours === '' ? '' : `# Related and nearby\n\n${packed.neighbours}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  const system: PromptBlock[] = [
    { label: 'role', text: ROLE },
    { label: 'digest', text: packed.digest, cache: true },
    { label: 'taste', text: packed.taste, cache: true },
    { label: 'instructions', text: instructions, cache: true },
  ];
  const user: PromptBlock[] = [
    ...(focusText === '' ? [] : [{ label: 'focus', text: focusText }]),
    { label: 'ask', text: ask },
  ];
  return {
    moment: input.moment,
    system,
    user,
    schema: input.schema,
    effort: input.options?.effort ?? input.defaults.effort,
    maxTokens: input.options?.maxTokens ?? input.defaults.maxTokens,
    stream: input.defaults.stream,
    ...(input.entity ? { entity: input.entity } : {}),
    estimate: [...system, ...user].reduce((n, b) => n + estimateTokens(b.text), 0) + schemaCost,
    pack: {
      included: packed.included,
      omitted: packed.omitted,
      digestLevel: packed.digestLevel,
      tokens: packed.tokens,
    },
  };
}

/** The whole prompt as one text, for the AI log ("open the request it sent"). */
export function promptText(p: Pick<BuiltPrompt, 'system' | 'user'>): string {
  return [
    ...p.system.map((b) => `<<system: ${b.label}${b.cache ? ' · cached' : ''}>>\n${b.text}`),
    ...p.user.map((b) => `<<user: ${b.label}>>\n${b.text}`),
  ].join('\n\n');
}
