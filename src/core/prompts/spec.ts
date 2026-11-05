import { getEntity, type World } from '../model/world';
import { analyzeNumbers, relevantFormulas, type FormulaSummary } from '../numbers';
import { clipToTokens } from '../context/tokens';
import { err, ok } from '../util/result';
import { assemble } from './common';
import { obj, str } from './schema';
import type { PromptBuilder } from './types';

/** Spec draft (Export): a markdown spec for Claude Code to implement in Infinite. */

const INSTRUCTIONS = `# Moment: spec draft

The designer is exporting decided entities as a spec that Claude Code will implement in Infinite. Draft it in markdown. The designer edits it before it's saved, so be complete and exact rather than polished.

Structure:
1. "# <the spec's name>", then "## Summary": what this set adds to the game and why, in a few sentences.
2. One "## <entity name>" section per entity in focus, in the order given, with: its identity; its fields as a short list; attributes with their values; relations, by entity name; and its Why, quoted.
3. "## Numbers": the variables and formulas these entities depend on, verbatim in a code block. Omit the section if none apply.
4. "## Acceptance questions": concrete yes/no questions Claude Code can test the implementation against, at least one per entity.

Rules: use only facts from the context; never invent numbers or relations. Write entity names as they are, never their ids. Leave out anything about the code itself; Claude Code decides that.`;

/**
 * The numbers a spec depends on, from the numbers engine: every formula that
 * reads these entities' attributes or fields (or queries their kind), what
 * those use and what uses them, with constants' values, plus the variables
 * they read. Nothing else from `formulas.carbon` is sent.
 */
export function specNumbers(world: World, ids: readonly string[]): string {
  const a = analyzeNumbers(world);
  // All the entities at once: summarising per entity repeated the work per formula.
  const defs: FormulaSummary[] = relevantFormulas(a, world, ids);
  const vars = [...new Set(defs.flatMap((d) => a.byName.get(d.name)?.variables ?? []))].sort();
  return [
    ...vars
      .filter((v) => v in world.numbers.variables)
      .map((v) => `${v} = ${JSON.stringify(world.numbers.variables[v])}`),
    ...defs.map((d) => (d.value !== undefined ? `${d.text}    # = ${d.value}` : d.text)),
  ].join('\n');
}

export const specBuilder: PromptBuilder<'spec_draft'> = {
  moment: 'spec_draft',
  defaults: { effort: 'medium', maxTokens: 16000, stream: false },
  build(world, req, options) {
    const missing = req.entityIds.filter((id) => !getEntity(world, id));
    if (missing.length > 0) return err('not_found', `no entity "${missing.join('", "')}"`);
    const numbers = specNumbers(world, req.entityIds);
    const ask = [
      `Spec name: ${req.name}`,
      `Entities, in order: ${req.entityIds.join(', ')}`,
      ...(numbers
        ? ['', 'Numbers these entities depend on:', '```', clipToTokens(numbers, 6000), '```']
        : []),
      '',
      'Draft the spec. title: the spec name as a title.',
    ].join('\n');
    return ok(
      assemble({
        moment: 'spec_draft',
        world,
        focus: { entities: req.entityIds },
        instructions: INSTRUCTIONS,
        ask,
        schema: obj({ title: str(), markdown: str() }),
        defaults: this.defaults,
        ...(options ? { options } : {}),
        ...(req.entityIds.length === 1 && req.entityIds[0] ? { entity: req.entityIds[0] } : {}),
        // Spec entities are all in focus; neighbours only as summaries.
        pack: { fullTiers: [] },
      }),
    );
  },
  parse(raw) {
    const x = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const title = typeof x.title === 'string' ? x.title.trim() : '';
    const markdown = typeof x.markdown === 'string' ? x.markdown.trim() : '';
    if (title === '' || markdown === '') return err('invalid_output', 'the spec draft was empty');
    return ok({ result: { title, markdown: `${markdown}\n` }, dropped: 0 });
  },
};
