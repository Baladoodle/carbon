import { PATHS, worldFromFiles, type FileMap, type LoadIssue } from '@core/files/world-files';
import { entityFromMarkdown } from '@core/files/entity-file';
import { entityProblems } from '@core/model/validate';
import { schemaOf, SpreadRecordSchema, type World } from '@core/model/world';
import type { Entity } from '@core/model/entity';

/**
 * Applies changed files to a world without re-reading the rest (pure). Gives
 * the same world as `worldFromFiles` over all files with the changes applied
 * (a property test proves it), but costs only the changed files, so an
 * external edit of one entity in a world of thousands stays instant.
 *
 * Invalid changed files are not applied: the world keeps its version of that
 * file and the problem comes back as an issue.
 */
export const ROOT_PATHS = [
  PATHS.settings,
  PATHS.schema,
  PATHS.variables,
  PATHS.formulas,
  PATHS.curves,
  PATHS.rules,
  PATHS.reasons,
  PATHS.patterns,
] as const;

const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

/** The root files of a world (no entities or spreads): cheap. */
export function rootFiles(world: World): FileMap {
  return new Map<string, string>([
    [PATHS.settings, json(world.settings)],
    [PATHS.schema, json(world.schema)],
    [PATHS.variables, json(world.numbers.variables)],
    [PATHS.formulas, world.numbers.formulas],
    ...(world.numbers.curves
      ? [[PATHS.curves, json(world.numbers.curves)] as [string, string]]
      : []),
    [PATHS.rules, json(world.taste.rules)],
    [PATHS.reasons, json(world.taste.reasons)],
    [PATHS.patterns, json(world.taste.patterns)],
  ]);
}

const ENTITY = /^entities\/([a-z]+)\/([^/]+)\.md$/;
const SPREAD = /^spreads\/([^/]+)\.json$/;

export function applyFileChanges(
  world: World,
  changes: ReadonlyMap<string, string | null>,
): { world: World; issues: LoadIssue[] } {
  const issues: LoadIssue[] = [];
  let next: World = world;

  // Root files first: the schema they carry validates the entities below.
  const roots = [...changes].filter(([p]) => (ROOT_PATHS as readonly string[]).includes(p));
  if (roots.length > 0) {
    const files = rootFiles(world);
    for (const [p, c] of roots) {
      if (c === null) files.delete(p);
      else files.set(p, c);
    }
    const r = worldFromFiles(files);
    const bad = new Set(r.issues.filter((i) => i.code !== 'format.newer').map((i) => i.path));
    issues.push(...r.issues.filter((i) => i.code !== 'format.newer'));
    next = {
      ...next,
      settings: bad.has(PATHS.settings) ? world.settings : r.world.settings,
      schema: bad.has(PATHS.schema) ? world.schema : r.world.schema,
      numbers: {
        variables: bad.has(PATHS.variables) ? world.numbers.variables : r.world.numbers.variables,
        formulas: r.world.numbers.formulas,
        ...(bad.has(PATHS.curves)
          ? world.numbers.curves
            ? { curves: world.numbers.curves }
            : {}
          : r.world.numbers.curves
            ? { curves: r.world.numbers.curves }
            : {}),
      },
      taste: {
        rules: bad.has(PATHS.rules) ? world.taste.rules : r.world.taste.rules,
        reasons: bad.has(PATHS.reasons) ? world.taste.reasons : r.world.taste.reasons,
        patterns: bad.has(PATHS.patterns) ? world.taste.patterns : r.world.taste.patterns,
      },
    };
  }

  const schema = schemaOf(next);
  let entities: Record<string, Entity> | null = null;
  let spreads: World['spreads'] | null = null;
  const sorted = [...changes].sort(([a], [b]) => a.localeCompare(b));
  // Removals before additions, so a file moved between kinds isn't a duplicate.
  const ordered = [
    ...sorted.filter(([, c]) => c === null),
    ...sorted.filter(([, c]) => c !== null),
  ];
  for (const [path, content] of ordered) {
    const em = ENTITY.exec(path);
    if (em) {
      entities ??= { ...next.entities };
      const [, kind, id] = em as unknown as [string, string, string];
      if (content === null) {
        if (entities[id]?.kind === kind) delete entities[id];
        continue;
      }
      const r = entityFromMarkdown(content);
      if (!r.ok) {
        issues.push({ path, code: r.error.code, message: r.error.message });
        continue;
      }
      const e = r.value;
      if (e.kind !== kind || e.id !== id) {
        issues.push({
          path,
          code: 'file.location',
          message: `a ${e.kind} "${e.id}" must live at ${PATHS.entity(e.kind, e.id)}`,
        });
        continue;
      }
      const other = entities[id];
      if (other && other.kind !== kind) {
        issues.push({
          path,
          code: 'file.duplicate_id',
          message: `id "${id}" is used by another file`,
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
      entities[id] = e;
      continue;
    }
    const sm = SPREAD.exec(path);
    if (sm) {
      spreads ??= { ...next.spreads };
      const id = sm[1] ?? '';
      if (content === null) {
        delete spreads[id];
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch (e) {
        issues.push({
          path,
          code: 'file.json',
          message: e instanceof Error ? e.message : 'invalid JSON',
        });
        continue;
      }
      const r = SpreadRecordSchema.safeParse(raw);
      if (!r.success) {
        issues.push({
          path,
          code: 'file.invalid',
          message: r.error.issues.map((i) => i.message).join('; '),
        });
        continue;
      }
      if (r.data.id !== id) {
        issues.push({
          path,
          code: 'file.location',
          message: `spread "${r.data.id}" must live at ${PATHS.spread(r.data.id)}`,
        });
        continue;
      }
      spreads[id] = r.data;
    }
  }
  if (entities) next = { ...next, entities };
  if (spreads) next = { ...next, spreads };
  return { world: next, issues };
}
