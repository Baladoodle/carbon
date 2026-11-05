import type { Entity } from '../model/entity';
import { isEmptyValue } from '../model/fields';
import { fieldValue } from '../model/lifecycle';
import { edgesFit } from '../model/validate';
import { getEntity, schemaOf, type World } from '../model/world';
import { err, ok } from '../util/result';
import { assemble } from './common';
import {
  duplicatesName,
  nullable,
  obj,
  str,
  validFieldValue,
  writableField,
  writableJsonSchema,
  type WritableField,
} from './schema';
import type { PromptBuilder } from './types';

/** Fill entity (`ctrl+enter`): one proposal for every empty field. */

const INSTRUCTIONS = `# Moment: fill entity

The designer pressed ctrl+enter on the entity in focus and wants a proposal for each of its empty fields. They'll accept or reject each one on its own.
- Every proposal must fit the entity's filled fields, its relations, its place on Y and the world around it. The fields you write must agree with each other.
- Keep what the designer already wrote as the source of truth; build out from it.
- Return null for a field you can't fill well. A weak proposal is worse than none.
- note: at most 12 words on why, or null.`;

/** The empty fields of an entity that the AI may fill, in schema order. */
export function emptyFields(world: World, e: Entity): WritableField[] {
  const keys = [
    'identity',
    'description',
    ...schemaOf(world).kinds[e.kind].fields.map((f) => f.key),
  ];
  return keys
    .filter((k) => isEmptyValue(fieldValue(e, k)))
    .map((k) => writableField(world, e.kind, k))
    .filter((f): f is WritableField => f !== null);
}

export const fillBuilder: PromptBuilder<'fill_entity'> = {
  moment: 'fill_entity',
  defaults: { effort: 'low', maxTokens: 12000, stream: false },
  build(world, req, options) {
    const e = getEntity(world, req.entityId);
    if (!e) return err('not_found', `no entity "${req.entityId}"`);
    const fields = emptyFields(world, e);
    if (fields.length === 0) return err('bad_request', `${e.name} has no empty fields to fill`);
    const props: Record<string, ReturnType<typeof obj>> = {};
    for (const f of fields)
      props[f.key] = nullable(obj({ value: writableJsonSchema(world, f), note: nullable(str()) }));
    const ask = [
      `Entity: ${e.id} (${schemaOf(world).kinds[e.kind].label})`,
      'Empty fields:',
      ...fields.map(
        (f) =>
          `- ${f.key}${f.label !== f.key ? ` ("${f.label}")` : ''}: ${f.type === 'common' ? 'text' : f.type}${f.def?.options ? ` (one of ${f.def.options.join(', ')})` : ''}${f.help ? `. ${f.help}` : ''}`,
      ),
      '',
      'Propose a value for each.',
    ].join('\n');
    return ok(
      assemble({
        moment: 'fill_entity',
        world,
        focus: { entities: [e.id] },
        instructions: INSTRUCTIONS,
        ask,
        schema: obj({ proposals: obj(props) }),
        defaults: this.defaults,
        ...(options ? { options } : {}),
        entity: e.id,
      }),
    );
  },
  parse(raw, world, req) {
    const e = getEntity(world, req.entityId);
    if (!e) return err('not_found', `no entity "${req.entityId}"`);
    const map =
      raw && typeof raw === 'object' ? (raw as { proposals?: unknown }).proposals : undefined;
    if (!map || typeof map !== 'object' || Array.isArray(map))
      return err('invalid_output', 'no proposals object');
    const fields = emptyFields(world, e);
    const proposals: { field: string; value: unknown; note?: string }[] = [];
    let dropped = 0;
    let withProposals = e;
    for (const [key, p] of Object.entries(map as Record<string, unknown>)) {
      if (p === null) continue;
      const f = fields.find((x) => x.key === key);
      const item = p && typeof p === 'object' ? (p as { value?: unknown; note?: unknown }) : {};
      const value = f ? validFieldValue(world, f, item.value) : undefined;
      if (
        !f ||
        value === undefined ||
        (key === 'name' && typeof value === 'string' && duplicatesName(world, value, e.id)) ||
        // Each proposal is accepted on its own, so it must fit the entity alone and
        // with the proposals before it: of a bottom and a top that cross, the top goes.
        !edgesFit(e, key, value) ||
        !edgesFit(withProposals, key, value)
      ) {
        dropped++;
        continue;
      }
      if (f.def)
        withProposals = { ...withProposals, fields: { ...withProposals.fields, [key]: value } };
      proposals.push({
        field: key,
        value,
        ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim() } : {}),
      });
    }
    proposals.sort(
      (a, b) =>
        fields.findIndex((f) => f.key === a.field) - fields.findIndex((f) => f.key === b.field),
    );
    return ok({ result: { proposals }, dropped });
  },
};
