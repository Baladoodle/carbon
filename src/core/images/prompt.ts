import { getEntity, type World } from '../model/world';
import type { Entity } from '../model/entity';
import { err, ok } from '../util/result';
import { assemble } from '../prompts/common';
import { qualityConstraints } from '../prompts/quality';
import { obj, str } from '../prompts/schema';
import type { PromptBuilder } from '../prompts/types';
import { ArtDirectionSchema, EMPTY_ART, type ArtDirection, type ImageKind } from './model';

/**
 * The `image_prompt` moment (docs/IMAGES.md §4–§5): Claude (Haiku) writes the
 * prompt for an image model from the entity, its relations and place (the
 * packed context), and the world's art direction. The designer sees and can
 * edit it before anything is spent.
 *
 * Icons follow Genforge's item prompt conventions (`ICON_CONVENTIONS`):
 * ADAPTER until the pixel package's `iconPrompt` merges; the conventions
 * here are the same house style (subject, presentation, proportions, light,
 * transparent background, no text or border).
 */

export const ICON_CONVENTIONS = [
  'A single game item icon, centred, shown whole, three-quarter view, filling about 80% of a square frame.',
  'Bold readable silhouette, chunky proportions, simple shapes that survive being shrunk to 16×16 pixels.',
  'Flat-shaded with one soft top-left key light and a darker outline; few colours, high contrast.',
  'Fully transparent background. No text, no letters, no border, no frame, no shadow on the ground, no scene.',
];

export const CONCEPT_CONVENTIONS = [
  'Concept art for a game: one clear subject or place, readable at thumbnail size.',
  'No text, no letters, no logos, no UI, no border, no watermark.',
];

/** Palette and material words from the art direction, for icons ("muted earth tones", "brass"). */
export function paletteWords(direction: string): string {
  const parts = direction
    .split(/[,.;\n]/)
    .map((s) => s.trim())
    .filter((s) =>
      /colou?r|tone|palette|hue|warm|cool|muted|saturat|pastel|earth|neon|gold|brass|ink/i.test(s),
    );
  return parts.join(', ');
}

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
    lines.push('Image kind: an item icon. Conventions:');
    lines.push(...ICON_CONVENTIONS.map((c) => `- ${c}`));
    const palette = paletteWords(art.direction);
    if (palette) lines.push(`- Palette, from the art direction: ${palette}.`);
  } else {
    lines.push('Image kind: concept art. Conventions:');
    lines.push(...CONCEPT_CONVENTIONS.map((c) => `- ${c}`));
    if (entity.kind === 'biome' || entity.kind === 'band')
      lines.push('- A wide establishing view of the place, no characters in the foreground.');
    if (art.direction) lines.push(`- Art direction: ${art.direction}`);
  }
  if (kindNote) lines.push(`- For every ${entity.kind}: ${kindNote}`);
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
  if (kind === 'icon') {
    const palette = paletteWords(art.direction);
    return `${name}, as a game item icon.${what} ${ICON_CONVENTIONS.join(' ')}${palette ? ` Palette: ${palette}.` : ''}`;
  }
  return `Concept art of ${name}.${what} ${CONCEPT_CONVENTIONS.join(' ')}${art.direction ? ` ${art.direction}` : ''}`;
}
