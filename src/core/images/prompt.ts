import { getEntity, type World } from '../model/world';
import type { Entity } from '../model/entity';
import { err, ok } from '../util/result';
import { assemble } from '../prompts/common';
import { qualityConstraints } from '../prompts/quality';
import { obj, str } from '../prompts/schema';
import type { PromptBuilder } from '../prompts/types';
import { iconPrompt } from '../pixel';
import { ArtDirectionSchema, EMPTY_ART, type ArtDirection, type ImageKind } from './model';
import { iconArt } from './sheet';

/**
 * The `image_prompt` moment (docs/IMAGES.md §4–§5): Claude (Haiku) writes the
 * prompt for an image model from the entity, its relations and place (the
 * packed context), and the world's art direction. The designer sees and can
 * edit it before anything is spent.
 *
 * Icons start from pixel's `iconPrompt` (Genforge's item house style: the
 * opening, the pose by object type, the materials, and the fixed closing),
 * which Claude adapts to the entity without changing its structure or closing.
 */

export const CONCEPT_CONVENTIONS = [
  'Concept art for a game: one clear subject or place, readable at thumbnail size.',
  'No text, no letters, no logos, no UI, no border, no watermark.',
];

export function artOf(world: World): ArtDirection {
  const r = ArtDirectionSchema.safeParse(world.settings.art ?? EMPTY_ART);
  return r.success ? r.data : EMPTY_ART;
}

const INSTRUCTIONS = `# Moment: image prompt

Write the prompt an image model will paint from, for the entity in focus. The designer reads and may edit it before anything is spent.

Use what the world says about the entity: its identity and description, its kind's fields, its place (band, biome, height), and the entities it relates to. Show what makes it this entity and no other. Never invent lore that contradicts the context; when something isn't said, choose what fits the world's art direction.

Write one paragraph of plain visual description, at most 120 words: the subject, its setting or presentation, composition, palette and light. No names in quotes, no text to render, no camera jargon lists, no negative-prompt syntax. Follow the conventions given for the image kind exactly.

${qualityConstraints(
  'The image the prompt describes',
  "For an image prompt only rule_clash and contradicts_relation really apply: never depict what a taste rule forbids, and never show the entity in a way its relations contradict (its place, what it's made of, what it lives in). The others concern the entity's written fields, which this prompt doesn't change.",
)}`;

function focusLine(e: Entity): string {
  return `The entity: ${e.name} (${e.kind}).`;
}

export function imagePromptAsk(world: World, entity: Entity, kind: ImageKind): string {
  const art = artOf(world);
  const kindNote = art.kinds[entity.kind];
  const lines = [focusLine(entity), ''];
  if (kind === 'icon') {
    lines.push(
      'Image kind: an item icon. Start from this house-style prompt (Genforge item conventions). Keep its structure, its pose and its closing sentences verbatim; only sharpen the subject and detail from the context:',
      '',
      iconPrompt(entity, world, iconArt(world)),
    );
  } else {
    lines.push('Image kind: concept art. Conventions:');
    lines.push(...CONCEPT_CONVENTIONS.map((c) => `- ${c}`));
    if (entity.kind === 'biome' || entity.kind === 'band')
      lines.push('- A wide establishing view of the place, no characters in the foreground.');
    if (art.direction) lines.push(`- Art direction: ${art.direction}`);
  }
  if (kindNote && kind !== 'icon') lines.push(`- For every ${entity.kind}: ${kindNote}`);
  lines.push('', 'Write the prompt.');
  return lines.join('\n');
}

export const imagePromptBuilder: PromptBuilder<'image_prompt'> = {
  moment: 'image_prompt',
  defaults: { effort: 'low', maxTokens: 4000, stream: false },
  build(world, req, options) {
    const e = getEntity(world, req.entityId);
    if (!e) return err('not_found', `no entity "${req.entityId}"`);
    return ok(
      assemble({
        moment: 'image_prompt',
        world,
        focus: { entities: [e.id] },
        instructions: INSTRUCTIONS,
        ask: imagePromptAsk(world, e, req.kind),
        schema: obj({ prompt: str() }),
        defaults: this.defaults,
        ...(options ? { options } : {}),
        entity: e.id,
      }),
    );
  },
  parse(raw) {
    const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const prompt = typeof x.prompt === 'string' ? x.prompt.replace(/\s+/g, ' ').trim() : '';
    if (prompt.length < 20) return err('invalid_output', 'the image prompt was empty');
    return ok({ result: { prompt: prompt.slice(0, 4000) }, dropped: 0 });
  },
};

/**
 * The fake's prompt (CARBON_AI=fake): deterministic, built from the entity and
 * the conventions, so the e2e and screenshots have a believable prompt.
 */
export function fakeImagePrompt(world: World, entityId: string, kind: ImageKind): string {
  const e = getEntity(world, entityId);
  const name = e?.name ?? entityId;
  const what = e?.identity ? ` ${e.identity}` : '';
  const art = artOf(world);
  if (kind === 'icon')
    return e ? iconPrompt(e, world, iconArt(world)) : `A single ${name} inventory icon.`;
  return `Concept art of ${name}.${what} ${CONCEPT_CONVENTIONS.join(' ')}${art.direction ? ` ${art.direction}` : ''}`;
}
