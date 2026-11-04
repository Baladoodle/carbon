import type { MomentRequest } from '../ai/moments';
import { PatternsRequestSchema } from '../ai/moments';
import type { World } from '../model/world';
import { worldDigest, type PromptOptions, type PromptParts } from '../spreads/prompt';
import { renderTaste, tasteContext } from './context';

/**
 * The `patterns` prompt builder (docs/SYSTEM.md §8), the same five parts as a
 * spread. The focus is the judgements; the task asks for patterns that would
 * predict them, and to update existing patterns by id rather than restate them.
 */

export const PATTERNS_SYSTEM = [
  'You are the design partner inside carbon, a studio for designing the world and progression of Infinite.',
  'The designer judges AI candidates by keeping or killing them, often with a reason. Your job now is to learn their taste: find the patterns that explain the judgements, so future candidates fit better.',
  'A good pattern is specific, testable against a new candidate, and supported by several judgements. "Prefers things that change how you move over things that add damage" is a pattern; "likes good ideas" is not.',
].join('\n\n');

const MAX_PATTERNS = 5;

export function patternsFocus(world: World, req: MomentRequest<'patterns'>): string {
  const r = PatternsRequestSchema.parse(req);
  const lines = ['<focus>'];
  const existing = world.taste.patterns.filter((p) => p.status !== 'dismissed');
  if (existing.length > 0) {
    lines.push('Existing patterns (update one by id instead of restating it):');
    for (const p of existing) lines.push(`- [${p.id}] (${p.status}) ${p.text}`);
  }
  const dismissed = world.taste.patterns.filter((p) => p.status === 'dismissed');
  if (dismissed.length > 0) {
    lines.push('Dismissed by the designer (do not propose again):');
    for (const p of dismissed) lines.push(`- ${p.text}`);
  }
  lines.push(`Judgements, oldest first (${r.judgements.length}):`);
  for (const j of r.judgements)
    lines.push(
      `- ${j.verdict.toUpperCase()} ${j.candidate.name} (${j.candidate.kind ?? 'finding'}): ${j.candidate.identity}${j.reason ? ` — reason: ${j.reason}` : ''}`,
    );
  lines.push('</focus>');
  return lines.join('\n');
}

export const PATTERNS_TASK = [
  '<task>',
  `Return at most ${MAX_PATTERNS} patterns, strongest first. For each: "text" (one sentence, in the second person: "You keep…", "You kill…"), "examples" (2–4 candidate names from the judgements that show it), "strength" (0..1: the share of relevant judgements it predicts), and "updates" (the id of the existing pattern it refines, if any).`,
  'Only patterns supported by at least two judgements. No pattern that restates a rule already in the taste block. Fewer, sharper patterns beat more.',
  '</task>',
].join('\n');

export function buildPatternsPrompt(
  world: World,
  req: MomentRequest<'patterns'>,
  opts: PromptOptions = {},
): PromptParts {
  return {
    system: PATTERNS_SYSTEM,
    digest: opts.digest ?? worldDigest(world),
    taste: renderTaste(tasteContext(world)),
    focus: patternsFocus(world, req),
    task: PATTERNS_TASK,
  };
}
