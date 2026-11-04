import { z } from 'zod';
import { defineCommand } from '../commands/define';
import type { Patch } from '../commands/patch';
import { CurveSchema, IntentPointSchema, type Curve } from '../model/curves';
import { EntityKindSchema } from '../model/kinds';
import { err, ok } from '../util/result';
import { nameProblem } from './check';
import { renameCaptures, renameVariableIn } from './rename';
import { defsOf } from './ast';
import { parseProgram } from './parser';
import { schemaOf } from '../model/world';

/**
 * The Numbers view's own commands (the foundation has `numbers.setVariable`,
 * `numbers.setFormulas` and `schema.setAttributeDef`). All pure; all undo
 * through the usual inverse patches.
 */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

const curvesPatch = (curves: Curve[]): Patch => [
  { op: 'set', path: ['numbers', 'curves'], value: curves },
];

/** Adds a curve, or replaces the one with the same id. */
export const putCurve = defineCommand({
  payload: z.object({ curve: CurveSchema }),
  label: (p, w) =>
    w.numbers.curves?.some((c) => c.id === p.curve.id) ? 'Edit curve' : 'Add curve',
  plan(world, p) {
    const o = p.curve.over;
    if (o.axis === 'attribute' && !(o.max > o.min))
      return err('curve.range', `the range ${o.min}…${o.max} is empty`);
    const curves = [...(world.numbers.curves ?? [])];
    const i = curves.findIndex((c) => c.id === p.curve.id);
    if (i >= 0) curves[i] = p.curve;
    else curves.push(p.curve);
    return ok(curvesPatch(curves));
  },
});

export const removeCurve = defineCommand({
  payload: z.object({ id: z.string() }),
  label: () => 'Remove curve',
  plan(world, p) {
    const curves = world.numbers.curves ?? [];
    if (!curves.some((c) => c.id === p.id)) return err('curve.not_found', `no curve "${p.id}"`);
    return ok(curvesPatch(curves.filter((c) => c.id !== p.id)));
  },
});

/** Replaces a curve's intent points (`null` removes the intent curve). */
export const setIntent = defineCommand({
  payload: z.object({ id: z.string(), points: z.array(IntentPointSchema).nullable() }),
  label: (p) => (p.points ? 'Move intent' : 'Remove intent'),
  plan(world, p) {
    const curves = world.numbers.curves ?? [];
    const i = curves.findIndex((c) => c.id === p.id);
    const cur = curves[i];
    if (!cur) return err('curve.not_found', `no curve "${p.id}"`);
    const next: Curve = { ...cur };
    if (p.points) next.intent = p.points;
    else delete next.intent;
    const out = [...curves];
    out[i] = next;
    return ok(curvesPatch(out));
  },
});

/** Removes an attribute definition from `schema.json` (a built-in one reverts to its default). */
export const removeAttributeDef = defineCommand({
  payload: z.object({ kind: EntityKindSchema, key: z.string() }),
  label: (p) => `Remove ${p.kind}.${p.key}`,
  plan(world, p) {
    const current = world.schema.kinds[p.kind];
    const attrs = current?.attributes ?? [];
    if (!current || !attrs.some((a) => a.key === p.key))
      return err('attribute.not_found', `${p.kind}.${p.key} is not defined in schema.json`);
    const rest = attrs.filter((a) => a.key !== p.key);
    const { attributes: _drop, ...others } = current;
    const override = rest.length > 0 ? { ...others, attributes: rest } : others;
    const kinds = { ...world.schema.kinds };
    if (Object.keys(override).length === 0) delete kinds[p.kind];
    else kinds[p.kind] = override;
    return ok([{ op: 'set', path: ['schema', 'kinds'], value: kinds }]);
  },
});

/** Renames a variable, and every formula and curve reference that resolves to it. */
export const renameVariable = defineCommand({
  payload: z.object({ from: z.string(), to: z.string().regex(IDENT) }),
  label: (p) => `Rename ${p.from} to ${p.to}`,
  plan(world, p) {
    const vars = world.numbers.variables;
    if (!Object.prototype.hasOwnProperty.call(vars, p.from))
      return err('variable.not_found', `no variable "${p.from}"`);
    if (p.from === p.to) return ok([]);
    if (Object.prototype.hasOwnProperty.call(vars, p.to))
      return err('variable.exists', `${p.to} is already a variable`);
    const bad = nameProblem(p.to, { schema: schemaOf(world), variables: {} });
    if (bad) return err('variable.name', bad.message);
    if (defsOf(parseProgram(world.numbers.formulas).program).some((d) => d.name === p.to))
      return err('variable.exists', `${p.to} is already a formula`);
    const r = renameVariableIn(world, p.from, p.to);
    if (renameCaptures(world, p.from, p.to, r))
      return err(
        'variable.capture',
        `a parameter or property named ${p.to} would change what a formula means`,
      );
    const variables: Record<string, number | string | boolean> = {};
    // Keep the order, with the new name in the old one's place.
    for (const [k, v] of Object.entries(vars)) variables[k === p.from ? p.to : k] = v;
    const patch: Patch = [{ op: 'set', path: ['numbers', 'variables'], value: variables }];
    if (r.formulas !== world.numbers.formulas)
      patch.push({ op: 'set', path: ['numbers', 'formulas'], value: r.formulas });
    if (r.curves && JSON.stringify(r.curves) !== JSON.stringify(world.numbers.curves))
      patch.push({ op: 'set', path: ['numbers', 'curves'], value: r.curves });
    return ok(patch);
  },
});

export const numbersCommands = {
  'numbers.putCurve': putCurve,
  'numbers.removeCurve': removeCurve,
  'numbers.setIntent': setIntent,
  'numbers.removeAttributeDef': removeAttributeDef,
  'numbers.renameVariable': renameVariable,
} as const;
