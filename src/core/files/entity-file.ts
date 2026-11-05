import { parseDocument, stringify } from 'yaml';
import { EntitySchema, type Entity } from '../model/entity';
import { err, ok, type Result } from '../util/result';

/**
 * An entity file: YAML frontmatter (every field but `description`) and the
 * description as the markdown body. Keys are written in a fixed order so diffs
 * in the world's git history stay small.
 */
const ORDER = [
  'id',
  'kind',
  'name',
  'identity',
  'state',
  'why',
  'tags',
  'fields',
  'attributes',
  'relations',
  'origin',
  'ai_fields',
  'agent_fields',
  'killed',
  'created',
  'updated',
] as const;

export function entityToMarkdown(entity: Entity): string {
  const front: Record<string, unknown> = {};
  for (const k of ORDER) if (entity[k] !== undefined) front[k] = entity[k];
  const yaml = stringify(front, { lineWidth: 0, sortMapEntries: false });
  const body =
    entity.description.trim() === '' ? '' : `\n${entity.description.replace(/\s+$/, '')}\n`;
  return `---\n${yaml}---\n${body}`;
}

/**
 * The frontmatter is everything up to the first line that is exactly "---"
 * (trailing spaces allowed): a "---" at the end of another line, which YAML
 * writes for a value such as "Light---", is content, not the end.
 */
const FRONTMATTER = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)([\s\S]*)$/;

/** Parses and validates an entity file. Never throws. */
export function entityFromMarkdown(text: string): Result<Entity> {
  const m = FRONTMATTER.exec(text);
  if (!m) return err('file.frontmatter', 'the file has no YAML frontmatter between --- lines');
  const doc = parseDocument(m[1] ?? '', { uniqueKeys: true });
  if (doc.errors.length > 0) return err('file.yaml', doc.errors.map((e) => e.message).join('; '));
  const front: unknown = doc.toJS();
  if (typeof front !== 'object' || front === null || Array.isArray(front))
    return err('file.yaml', 'the frontmatter is not a mapping');
  const description = (m[2] ?? '').replace(/^\r?\n/, '').replace(/\s+$/, '');
  const parsed = EntitySchema.safeParse({ ...front, description });
  if (!parsed.success)
    return err(
      'file.invalid',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      { issues: parsed.error.issues },
    );
  return ok(parsed.data);
}
