import { z } from 'zod';
import type { Patch } from '../commands/patch';
import { ENTITY_KINDS, type EntityKind } from '../model/kinds';
import { CurveSchema } from '../model/curves';
import { SchemaFileSchema } from '../model/schema';
import { entityProblems } from '../model/validate';
import {
  emptyWorld,
  KillReasonSchema,
  PatternSchema,
  schemaOf,
  SettingsSchema,
  SpreadRecordSchema,
  TasteRuleSchema,
  WORLD_FORMAT,
  type World,
} from '../model/world';
import type { Entity } from '../model/entity';
import { entityFromMarkdown, entityToMarkdown } from './entity-file';

/**
 * The world directory layout (docs/SYSTEM.md §4), as pure functions between a
 * `World` and a map of relative path → file content. `src/main/store` does the
 * actual reading and (atomic) writing.
 */
export const PATHS = {
  settings: 'carbon.json',
  schema: 'schema.json',
  variables: 'numbers/variables.json',
  formulas: 'numbers/formulas.carbon',
  curves: 'numbers/curves.json',
  rules: 'taste/rules.json',
  reasons: 'taste/reasons.json',
  patterns: 'taste/patterns.json',
  entity: (kind: EntityKind, id: string) => `entities/${kind}/${id}.md`,
  spread: (id: string) => `spreads/${id}.json`,
} as const;

/** Directories the store reads (and creates). */
export const WORLD_DIRS = [
  'entities',
  ...ENTITY_KINDS.map((k) => `entities/${k}`),
  'numbers',
  'taste',
  'spreads',
  'exports',
  'ai-log',
];

export type FileMap = Map<string, string>;

/** A file that could not be loaded; the store reports (and W6 quarantines) it. */
export interface LoadIssue {
  path: string;
  code: string;
  message: string;
}

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function parseJson<T extends z.ZodType>(
  files: FileMap,
  path: string,
  schema: T,
  issues: LoadIssue[],
): z.infer<T> | undefined {
  const text = files.get(path);
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    issues.push({
      path,
      code: 'file.json',
      message: e instanceof Error ? e.message : 'invalid JSON',
    });
    return undefined;
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    issues.push({
      path,
      code: 'file.invalid',
      message: r.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
    });
    return undefined;
  }
  return r.data;
}

/** Builds a world from its files. Invalid files are left out and reported, never silently dropped. */
export function worldFromFiles(files: FileMap): { world: World; issues: LoadIssue[] } {
  const issues: LoadIssue[] = [];
  const world = emptyWorld();
  world.settings = parseJson(files, PATHS.settings, SettingsSchema, issues) ?? world.settings;
  if (world.settings.format > WORLD_FORMAT)
    issues.push({
      path: PATHS.settings,
      code: 'format.newer',
      message: `format ${world.settings.format} is newer than this carbon (${WORLD_FORMAT})`,
    });
  world.schema = parseJson(files, PATHS.schema, SchemaFileSchema, issues) ?? world.schema;
  world.numbers.variables =
    parseJson(
      files,
      PATHS.variables,
      z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
      issues,
    ) ?? {};
  world.numbers.formulas = files.get(PATHS.formulas) ?? '';
  const curves = parseJson(files, PATHS.curves, z.array(CurveSchema), issues);
  if (curves) world.numbers.curves = curves;
  world.taste.rules =
    parseJson(files, PATHS.rules, z.array(TasteRuleSchema), issues) ?? world.taste.rules;
  world.taste.reasons =
    parseJson(files, PATHS.reasons, z.array(KillReasonSchema), issues) ?? world.taste.reasons;
  world.taste.patterns =
    parseJson(files, PATHS.patterns, z.array(PatternSchema), issues) ?? world.taste.patterns;

  const schema = schemaOf(world);
  const paths = [...files.keys()].sort();
  for (const path of paths) {
    const em = /^entities\/([a-z]+)\/([^/]+)\.md$/.exec(path);
    if (em) {
      const r = entityFromMarkdown(files.get(path) ?? '');
      if (!r.ok) {
        issues.push({ path, code: r.error.code, message: r.error.message });
        continue;
      }
      const e = r.value;
      if (e.kind !== em[1] || e.id !== em[2]) {
        issues.push({
          path,
          code: 'file.location',
          message: `a ${e.kind} "${e.id}" must live at ${PATHS.entity(e.kind, e.id)}`,
        });
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(world.entities, e.id)) {
        issues.push({
          path,
          code: 'file.duplicate_id',
          message: `id "${e.id}" is used by another file`,
        });
        continue;
      }
      const errors = entityProblems(schema, e).filter((p) => p.severity === 'error');
      if (errors.length > 0) {
        issues.push({
          path,
          code: 'file.invalid',
          message: errors.map((p) => p.message).join('; '),
        });
        continue;
      }
      world.entities[e.id] = e;
      continue;
    }
    const sm = /^spreads\/([^/]+)\.json$/.exec(path);
    if (sm) {
      const rec = parseJson(files, path, SpreadRecordSchema, issues);
      if (rec && rec.id !== sm[1])
        issues.push({
          path,
          code: 'file.location',
          message: `spread "${rec.id}" must live at ${PATHS.spread(rec.id)}`,
        });
      else if (rec) world.spreads[rec.id] = rec;
    }
  }
  return { world, issues };
}

const entityFile = (e: Entity): [string, string] => [
  PATHS.entity(e.kind, e.id),
  entityToMarkdown(e),
];

/** Every file of a world. */
export function worldToFiles(world: World): FileMap {
  const files: FileMap = new Map([
    [PATHS.settings, json(world.settings)],
    [PATHS.schema, json(world.schema)],
    [PATHS.variables, json(world.numbers.variables)],
    [PATHS.formulas, world.numbers.formulas],
    ...(world.numbers.curves ? [[PATHS.curves, json(world.numbers.curves)] as [string, string]] : []),
    [PATHS.rules, json(world.taste.rules)],
    [PATHS.reasons, json(world.taste.reasons)],
    [PATHS.patterns, json(world.taste.patterns)],
  ]);
  for (const e of Object.values(world.entities)) files.set(...entityFile(e));
  for (const s of Object.values(world.spreads)) files.set(PATHS.spread(s.id), json(s));
  return files;
}

export interface FileChanges {
  write: FileMap;
  remove: string[];
}

/** The files a patch changes: only what it touched is rewritten. */
export function filesForPatch(before: World, after: World, patch: Patch): FileChanges {
  const write: FileMap = new Map();
  const remove = new Set<string>();
  for (const op of patch) {
    const [section, key] = op.path;
    switch (section) {
      case 'settings':
        write.set(PATHS.settings, json(after.settings));
        break;
      case 'schema':
        write.set(PATHS.schema, json(after.schema));
        break;
      case 'numbers':
        if (key === undefined || key === 'variables')
          write.set(PATHS.variables, json(after.numbers.variables));
        if (key === undefined || key === 'formulas')
          write.set(PATHS.formulas, after.numbers.formulas);
        if (key === undefined || key === 'curves') {
          if (after.numbers.curves) write.set(PATHS.curves, json(after.numbers.curves));
          else if (before.numbers.curves) remove.add(PATHS.curves);
        }
        break;
      case 'taste':
        if (key === undefined || key === 'rules') write.set(PATHS.rules, json(after.taste.rules));
        if (key === undefined || key === 'reasons')
          write.set(PATHS.reasons, json(after.taste.reasons));
        if (key === undefined || key === 'patterns')
          write.set(PATHS.patterns, json(after.taste.patterns));
        break;
      case 'entities': {
        const ids =
          key === undefined
            ? [...new Set([...Object.keys(before.entities), ...Object.keys(after.entities)])]
            : [key];
        for (const id of ids) {
          const was = before.entities[id];
          const now = after.entities[id];
          if (was && (!now || now.kind !== was.kind)) remove.add(PATHS.entity(was.kind, was.id));
          if (now) {
            const [p, c] = entityFile(now);
            write.set(p, c);
            remove.delete(p);
          }
        }
        break;
      }
      case 'spreads': {
        const ids =
          key === undefined
            ? [...new Set([...Object.keys(before.spreads), ...Object.keys(after.spreads)])]
            : [key];
        for (const id of ids) {
          const now = after.spreads[id];
          if (now) {
            write.set(PATHS.spread(id), json(now));
            remove.delete(PATHS.spread(id));
          } else if (before.spreads[id]) remove.add(PATHS.spread(id));
        }
        break;
      }
      default:
        break;
    }
  }
  for (const p of write.keys()) remove.delete(p);
  return { write, remove: [...remove] };
}
