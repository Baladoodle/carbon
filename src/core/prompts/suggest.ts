import { fieldValue } from '../model/lifecycle';
import { edgesFit } from '../model/validate';
import { getEntity, schemaOf, type World } from '../model/world';
import { deepEqual } from '../util/json';
import { err, ok } from '../util/result';
import { assemble, quote } from './common';
import {
  arr,
  duplicatesName,
  normName,
  obj,
  str,
  validFieldValue,
  writableField,
  writableJsonSchema,
  type WritableField,
} from './schema';
import type { ParsedRequest, PromptBuilder } from './types';

/** Suggest one (`tab`) and suggest three (`shift+tab`): values for one field. */

const INSTRUCTIONS_ONE = `# Moment: suggest one

The designer pressed tab on one field of the entity in focus and wants a single value for it.
- Fit the entity: its kind, its other fields, its relations, its place on Y, and the world around it.
- Make the value specific to this entity. A value that could belong to any entity is wrong.
- If the field already has a value, propose a better one in the same spirit, not a paraphrase.
- Never repeat a value listed under "Already shown".
- For a name: unlike every existing name, short, in the world's voice.
- note: at most 12 words on why it fits. It's shown dimmed next to the suggestion.`;

const INSTRUCTIONS_THREE = `# Moment: suggest three

The designer pressed shift+tab on one field of the entity in focus and wants three alternatives to choose from.
- Each must fit the entity: its kind, its other fields, its relations, its place on Y, and the world around it.
- The three must be genuinely different directions, not variations of one idea. Make them span a range the designer would want to choose across.
- Never repeat a value listed under "Already shown" or the field's current value.
- For a name: unlike every existing name, short, in the world's voice.
- note: at most 12 words each, saying what distinguishes that option.`;

function fieldAsk(
  world: World,
  req: ParsedRequest<'suggest_one'>,
  f: WritableField,
  n: 1 | 3,
): string {
  const e = getEntity(world, req.entityId);
  const current = e ? fieldValue(e, f.key) : undefined;
  const kind = e ? schemaOf(world).kinds[e.kind] : undefined;
  const lines = [
    `Entity: ${req.entityId}${kind ? ` (${kind.label}: ${kind.help})` : ''}`,
    `Field: ${f.key}${f.label !== f.key ? ` ("${f.label}")` : ''}, type ${f.type === 'common' ? (f.key === 'tags' ? 'list of strings' : 'text') : f.type}${f.help ? `: ${f.help}` : ''}`,
  ];
  if (f.def?.options) lines.push(`Options: ${f.def.options.join(', ')}`);
  if (current !== undefined && current !== '' && !(Array.isArray(current) && current.length === 0))
    lines.push(`Current value: ${quote(current)}`);
  if (req.avoid.length > 0) lines.push(`Already shown: ${req.avoid.map(quote).join(' | ')}`);
  lines.push(
    '',
    n === 1
      ? 'Suggest one value for this field.'
      : 'Suggest three different values for this field.',
  );
  return lines.join('\n');
}

const resolveField = (world: World, req: ParsedRequest<'suggest_one'>) => {
  const e = getEntity(world, req.entityId);
  if (!e) return err('not_found', `no entity "${req.entityId}"`);
  const f = writableField(world, e.kind, req.field);
  if (!f)
    return err('bad_request', `"${req.field}" is not a field the AI can suggest on a ${e.kind}`);
  return ok({ e, f });
};

/** Validates a list of raw suggestions; returns the valid, new, distinct ones. */
function validSuggestions(world: World, req: ParsedRequest<'suggest_one'>, raw: unknown[]) {
  const r = resolveField(world, req);
  if (!r.ok) return { valid: [], dropped: raw.length };
  const { e, f } = r.value;
  const current = fieldValue(e, f.key);
  const seen: unknown[] = [...req.avoid, current];
  const valid: { value: unknown; note?: string }[] = [];
  let dropped = 0;
  for (const s of raw) {
    const item = s && typeof s === 'object' ? (s as { value?: unknown; note?: unknown }) : {};
    const value = validFieldValue(world, f, item.value);
    const dup =
      value === undefined ||
      // A value the command would refuse (a band's bottom above its top) is invalid too.
      !edgesFit(e, f.key, value) ||
      seen.some(
        (x) =>
          deepEqual(x, value) ||
          (typeof x === 'string' && typeof value === 'string' && normName(x) === normName(value)),
      ) ||
      (f.key === 'name' && typeof value === 'string' && duplicatesName(world, value, e.id));
    if (dup) {
      dropped++;
      continue;
    }
    seen.push(value);
    valid.push({
      value,
      ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim() } : {}),
    });
  }
  return { valid, dropped };
}

export const suggestOneBuilder: PromptBuilder<'suggest_one'> = {
  moment: 'suggest_one',
  defaults: { effort: 'low', maxTokens: 4000, stream: false },
  build(world, req, options) {
    const r = resolveField(world, req);
    if (!r.ok) return r;
    const { e, f } = r.value;
    return ok(
      assemble({
        moment: 'suggest_one',
        world,
        focus: { entities: [e.id] },
        instructions: INSTRUCTIONS_ONE,
        ask: fieldAsk(world, req, f, 1),
        schema: obj({ suggestion: obj({ value: writableJsonSchema(world, f), note: str() }) }),
        defaults: this.defaults,
        ...(options ? { options } : {}),
        entity: e.id,
      }),
    );
  },
  parse(raw, world, req) {
    const s =
      raw && typeof raw === 'object' ? (raw as { suggestion?: unknown }).suggestion : undefined;
    const { valid, dropped } = validSuggestions(world, req, [s]);
    const first = valid[0];
    if (!first)
      return err('invalid_output', 'the suggestion was invalid or repeated an earlier one');
    return ok({ result: { suggestion: first }, dropped });
  },
};

export const suggestThreeBuilder: PromptBuilder<'suggest_three'> = {
  moment: 'suggest_three',
  defaults: { effort: 'low', maxTokens: 6000, stream: false },
  build(world, req, options) {
    const r = resolveField(world, req);
    if (!r.ok) return r;
    const { e, f } = r.value;
    return ok(
      assemble({
        moment: 'suggest_three',
        world,
        focus: { entities: [e.id] },
        instructions: INSTRUCTIONS_THREE,
        ask: fieldAsk(world, req, f, 3),
        schema: obj({
          suggestions: arr(
            obj({ value: writableJsonSchema(world, f), note: str() }),
            'exactly three',
          ),
        }),
        defaults: this.defaults,
        ...(options ? { options } : {}),
        entity: e.id,
      }),
    );
  },
  parse(raw, world, req) {
    const list =
      raw && typeof raw === 'object' ? (raw as { suggestions?: unknown }).suggestions : undefined;
    const items = Array.isArray(list) ? list : [];
    const { valid, dropped } = validSuggestions(world, req, items);
    if (valid.length < 3)
      return err('invalid_output', `only ${valid.length} of 3 suggestions were valid and distinct`);
    return ok({ result: { suggestions: valid.slice(0, 3) }, dropped: dropped + valid.length - 3 });
  },
};
