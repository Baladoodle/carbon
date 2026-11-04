import { CRITIQUE_KINDS, type CritiqueNote } from '../ai/moments';
import { getEntity, schemaOf } from '../model/world';
import { err, ok } from '../util/result';
import { assemble } from './common';
import { arr, enumOf, nullable, obj, str } from './schema';
import type { PromptBuilder } from './types';

/** Critique: notes on one entity, on finishing an edit, a state change, or `?`. */

export const CRITIQUE_INSTRUCTIONS = `# Moment: critique

Review the entity in focus and return notes ONLY for real problems of these kinds:
- just_a_number: its effect is only a stat change (+N, ×N, a percentage, a faster/stronger version) with no new behaviour, choice, verb or feeling. Numbers attached to a distinct identity are fine.
- rule_clash: it breaks one of the designer's rules. Set ruleId to that rule's id in brackets, e.g. "r1".
- duplicate: it is the same thing as another existing entity: the same or nearly the same name, or the same role and identity under a different name. Put the other entity's id in entities.
- contradicts_relation: one of its relations, or one pointing at it, is wrong or impossible: a target id that doesn't exist in the world, a target of the wrong kind, or a relation that contradicts the entity's own fields or place (a lava creature living in a frozen biome). Put the relation's target id in entities only if that entity exists.
- weak_identity: its one-line identity is missing, generic, or doesn't say what makes it distinct.

Precision matters more than coverage: the designer reads every note. If the entity is sound, return an empty list. Never raise a note on taste alone, never pad, never repeat one problem as two notes. At most one note per kind.
text: one precise sentence naming the problem, addressed to the designer. No hedging.
field: the field the note is about, or null.
entities: other existing entity ids the note is about (never the entity itself), or [].`;

const TRIGGER: Record<string, string> = {
  finish_edit: 'The designer just finished editing it.',
  state_change: 'The designer just changed its state.',
  on_demand: 'The designer asked for a critique.',
};

export const critiqueBuilder: PromptBuilder<'critique'> = {
  moment: 'critique',
  defaults: { effort: 'low', maxTokens: 6000, stream: false },
  build(world, req, options) {
    const e = getEntity(world, req.entityId);
    if (!e) return err('not_found', `no entity "${req.entityId}"`);
    const dangling = e.relations
      .filter((r) => !getEntity(world, r.target))
      .map((r) => `${r.type} → ${r.target}`);
    const ask = [
      `Entity: ${e.id} (${schemaOf(world).kinds[e.kind].label}). ${TRIGGER[req.trigger] ?? ''}`,
      ...(dangling.length > 0
        ? [`Relation targets that are not in the world: ${dangling.join('; ')}`]
        : []),
      '',
      'Critique it.',
    ].join('\n');
    return ok(
      assemble({
        moment: 'critique',
        world,
        focus: { entities: [e.id] },
        instructions: CRITIQUE_INSTRUCTIONS,
        ask,
        schema: obj({
          notes: arr(
            obj({
              kind: enumOf(CRITIQUE_KINDS),
              text: str(),
              entities: arr(str('an existing entity id')),
              field: nullable(str()),
              ruleId: nullable(str()),
            }),
          ),
        }),
        defaults: this.defaults,
        ...(options ? { options } : {}),
        entity: e.id,
      }),
    );
  },
  parse(raw, world, req) {
    const list = raw && typeof raw === 'object' ? (raw as { notes?: unknown }).notes : undefined;
    if (!Array.isArray(list)) return err('invalid_output', 'no notes list');
    const notes: CritiqueNote[] = [];
    const kinds = new Set<string>();
    let dropped = 0;
    for (const n of list) {
      const x = n && typeof n === 'object' ? (n as Record<string, unknown>) : {};
      const kind = x.kind as CritiqueNote['kind'];
      const text = typeof x.text === 'string' ? x.text.trim() : '';
      const entities = Array.isArray(x.entities)
        ? x.entities.filter((id): id is string => typeof id === 'string')
        : [];
      const others = entities.filter((id) => id !== req.entityId);
      const ruleId =
        typeof x.ruleId === 'string' && x.ruleId !== ''
          ? x.ruleId.replace(/^\[|\]$/g, '')
          : undefined;
      const valid =
        (CRITIQUE_KINDS as readonly string[]).includes(kind) &&
        text !== '' &&
        !kinds.has(kind) &&
        others.every((id) => getEntity(world, id)) &&
        (ruleId === undefined || world.taste.rules.some((r) => r.id === ruleId)) &&
        (kind !== 'rule_clash' || ruleId !== undefined) &&
        (kind !== 'duplicate' || others.length > 0);
      if (!valid) {
        dropped++;
        continue;
      }
      kinds.add(kind);
      notes.push({
        kind,
        text,
        entities: [...new Set(others)],
        ...(typeof x.field === 'string' && x.field !== '' ? { field: x.field } : {}),
        ...(ruleId ? { ruleId } : {}),
      });
    }
    return ok({ result: { notes }, dropped });
  },
};
