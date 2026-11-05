import { mkdir, readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { emptyWorld, WORLD_FORMAT, type World } from '@core/model/world';
import {
  PATHS,
  WORLD_DIRS,
  worldFromFiles,
  worldToFiles,
  type FileChanges,
  type FileMap,
  type LoadIssue,
} from '@core/files/world-files';
import { cleanTempFiles, removeFileDurable, writeBatchAtomic, writeFileAtomic } from './atomic';
import { diskState, noteRead, noteWrite } from './disk-state';
import { ensureMetaDir, exists, META, stamp } from './meta';
import { formatOf, MIGRATIONS, type Migration } from './migrations';
import { migrateWorldDir, recoverMigration, type MigrationReport } from './migrate';

/**
 * The world directory on disk (docs/SYSTEM.md §4), hardened:
 *
 * - atomic writes (temporary file, fsync, rename, directory fsync), with stray
 *   temporary files from a crash removed on open
 * - versioned migrations on open, with a backup first and crash recovery
 * - invalid files moved to `.carbon/quarantine/` and reported, never dropped
 * - a world written by a newer carbon opens read-only
 * - every read and write recorded for the file watcher (disk-state.ts)
 */

async function listFiles(dir: string, rel: string, ext: string): Promise<string[]> {
  try {
    const names = await readdir(path.join(dir, rel));
    return names.filter((n) => n.endsWith(ext) && !n.startsWith('.')).map((n) => `${rel}/${n}`);
  } catch {
    return [];
  }
}

/** A directory, or a symlink to one (a kind folder kept elsewhere and linked in). */
async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Text as carbon reads it: without a byte-order mark and with LF line ends,
 * so a file saved by an editor on another OS loads exactly like its LF twin
 * instead of failing to parse (and being quarantined). carbon writes LF.
 */
export const normaliseText = (s: string): string =>
  (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).replace(/\r\n?/g, '\n');

/**
 * Reads every file carbon knows about into a path → content map. A listed
 * file that exists but can't be read (a directory named like an entity file,
 * no permission) is reported in `unreadable`, never dropped silently.
 */
export async function readWorldFiles(dir: string, unreadable?: LoadIssue[]): Promise<FileMap> {
  const rels: string[] = [
    PATHS.settings,
    PATHS.schema,
    PATHS.variables,
    PATHS.formulas,
    PATHS.curves,
    PATHS.rules,
    PATHS.reasons,
    PATHS.patterns,
  ];
  const names = await readdir(path.join(dir, 'entities')).catch(() => [] as string[]);
  const kinds: string[] = [];
  for (const n of names) if (await isDir(path.join(dir, 'entities', n))) kinds.push(n);
  for (const k of kinds) rels.push(...(await listFiles(dir, `entities/${k}`, '.md')));
  rels.push(...(await listFiles(dir, 'spreads', '.json')));
  const files: FileMap = new Map();
  const problems: LoadIssue[] = [];
  await Promise.all(
    rels.map(async (rel) => {
      try {
        files.set(rel, normaliseText(await readFile(path.join(dir, rel), 'utf8')));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return; // a missing optional file
        problems.push({
          path: rel,
          code: 'file.unreadable',
          message: `can't be read (${code ?? (e instanceof Error ? e.message : String(e))})`,
        });
      }
    }),
  );
  unreadable?.push(...problems.sort((a, b) => a.path.localeCompare(b.path)));
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/** Creates the directory layout and default files if the world is new. */
export async function initWorldDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const d of WORLD_DIRS) await mkdir(path.join(dir, d), { recursive: true });
  if (!(await exists(path.join(dir, PATHS.settings)))) {
    for (const [rel, content] of worldToFiles(emptyWorld())) {
      if (!(await exists(path.join(dir, rel)))) await writeFileAtomic(path.join(dir, rel), content);
    }
  }
}

/** Load issues that mean "this file is bad": the file is moved to quarantine. */
const QUARANTINE_CODES = new Set([
  'file.json',
  'file.invalid',
  'file.yaml',
  'file.frontmatter',
  'file.location',
  'file.duplicate_id',
]);

/** Error codes that mean the world directory can't be written. */
const UNWRITABLE = new Set(['EROFS', 'EACCES', 'EPERM', 'ENOSPC', 'EDQUOT']);

/** Root files that always exist: a quarantined one is replaced by its default. */
const ROOT_FILES = new Set<string>([
  PATHS.settings,
  PATHS.schema,
  PATHS.variables,
  PATHS.formulas,
  PATHS.rules,
  PATHS.reasons,
  PATHS.patterns,
]);

export const quarantineDir = (dir: string): string => path.join(dir, META.quarantine);

/**
 * Moves a file into `.carbon/quarantine/<stamp>/<its path>`: written there
 * atomically first, then removed from the world, so a crash between the two
 * steps leaves a copy in both places, never in neither.
 */
export async function quarantineFile(
  dir: string,
  rel: string,
  content: string,
  at: string,
): Promise<string> {
  await ensureMetaDir(dir);
  const dest = `${META.quarantine}/${stamp(at)}/${rel}`;
  await writeFileAtomic(path.join(dir, dest), content);
  await removeFileDurable(path.join(dir, rel));
  return dest;
}

export interface LoadOptions {
  /** ISO clock for quarantine and backup folder names. */
  now?: () => string;
  /** The migrations to use (tests inject their own). */
  migrations?: readonly Migration[];
  /** The format this carbon writes (tests use a higher one with their migrations). */
  format?: number;
  /** Testing only: throw after this many file writes during a migration (a simulated crash). */
  crashAfterWrites?: number;
}

export interface LoadResult {
  world: World;
  issues: LoadIssue[];
  /** Set when the world was migrated on this open. */
  migrated?: MigrationReport;
  /** Files moved to quarantine on this open (relative destination paths). */
  quarantined: string[];
  /** Stray temporary files removed on this open (left by a crash). */
  cleaned: string[];
}

/** Loads (and if needed initialises, recovers, migrates and cleans) a world directory. */
export async function loadWorldDir(dir: string, opts: LoadOptions = {}): Promise<LoadResult> {
  const now = opts.now ?? (() => new Date().toISOString());
  const target = opts.format ?? WORLD_FORMAT;
  const migrations = opts.migrations ?? MIGRATIONS;
  const disk = diskState(dir);
  disk.readOnly = null;

  // A filesystem carbon can't write to (mounted read-only, no permission, full)
  // still opens: read-only, with the reason, and nothing is moved.
  let cleaned: string[] = [];
  try {
    await initWorldDir(dir);
    cleaned = await cleanTempFiles(dir);
    await recoverMigration(dir, readWorldFiles);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (!code || !UNWRITABLE.has(code)) throw e;
    disk.readOnly = `the world directory can't be written (${code}); opened read-only`;
  }

  const unreadable: LoadIssue[] = [];
  let files = await readWorldFiles(dir, unreadable);
  const issues: LoadIssue[] = [...unreadable];
  let migrated: MigrationReport | undefined;
  const format = formatOf(files);
  const status = format === target ? 'current' : format < target ? 'older' : 'newer';
  if (disk.readOnly) {
    // Neither migrated nor quarantined: the reason is already set.
  } else if (status === 'older') {
    const r = await migrateWorldDir(dir, files, format, target, {
      migrations,
      at: now(),
      read: readWorldFiles,
      ...(opts.crashAfterWrites !== undefined ? { crashAfterWrites: opts.crashAfterWrites } : {}),
    });
    if (r.ok) {
      migrated = r.report;
      files = await readWorldFiles(dir);
    } else {
      disk.readOnly = r.message;
      issues.push({ path: PATHS.settings, code: 'format.migration', message: r.message });
    }
  } else if (status === 'newer') {
    disk.readOnly = `format ${format} is newer than this carbon (${target}); open it read-only`;
  }

  const loaded = worldFromFiles(files);
  // The format check is ours (against `target`), not worldFromFiles' (against the shipped format).
  const fileIssues = loaded.issues.filter((i) => i.code !== 'format.newer');
  if (status === 'newer')
    fileIssues.unshift({
      path: PATHS.settings,
      code: 'format.newer',
      message: disk.readOnly ?? '',
    });

  // carbon.json and schema.json carry what every other file is read with (the
  // format, the kinds and their fields). Quarantining a broken one would put
  // the defaults in its place and then quarantine every entity they reject:
  // open read-only instead, move nothing, and say which file to fix.
  const foundation = fileIssues.find(
    (i) => (i.path === PATHS.settings || i.path === PATHS.schema) && QUARANTINE_CODES.has(i.code),
  );
  if (foundation && !disk.readOnly)
    disk.readOnly = `${foundation.path} is invalid; fix it and reopen carbon (nothing was moved)`;

  const quarantined: string[] = [];
  const kept = new Map(files);
  // A newer world's files may be valid for the carbon that wrote them: never move them.
  if (!disk.readOnly) {
    const at = now();
    for (const issue of fileIssues) {
      const content = files.get(issue.path);
      if (!QUARANTINE_CODES.has(issue.code) || content === undefined) {
        issues.push(issue);
        continue;
      }
      const dest = await quarantineFile(dir, issue.path, content, at);
      quarantined.push(dest);
      kept.delete(issue.path);
      issues.push({ ...issue, message: `${issue.message} (moved to ${dest})` });
      if (ROOT_FILES.has(issue.path)) {
        const fresh = worldToFiles(loaded.world).get(issue.path) ?? '';
        await writeFileAtomic(path.join(dir, issue.path), fresh);
        kept.set(issue.path, fresh);
      }
    }
  } else issues.push(...fileIssues);

  noteRead(disk, kept);
  disk.lastLoad = { ...(migrated ? { migrated } : {}), quarantined, cleaned };
  return {
    world: loaded.world,
    issues,
    ...(migrated ? { migrated } : {}),
    quarantined,
    cleaned,
  };
}

/**
 * Applies file changes: atomic writes, then durable removals. Refused for
 * read-only worlds.
 *
 * A file whose write fails (a full disk, a filesystem gone read-only) is kept
 * in `unsaved` with carbon's content and retried by every later call; the
 * other files are still written. The call throws while anything is unsaved,
 * so the save status never says "saved" while the disk lags the world.
 */
export async function writeChanges(dir: string, changes: FileChanges): Promise<void> {
  const disk = diskState(dir);
  if (disk.readOnly) throw new Error(disk.readOnly);
  const write = new Map<string, string>();
  const remove = new Set<string>();
  for (const [rel, content] of disk.unsaved) {
    if (content === null) remove.add(rel);
    else write.set(rel, content);
  }
  for (const [rel, content] of changes.write) {
    remove.delete(rel);
    write.set(rel, content);
  }
  for (const rel of changes.remove) {
    write.delete(rel);
    remove.add(rel);
  }
  // One batch for the whole call (a transaction's files): carbon records each
  // write first, so the watcher knows the content is its own.
  const ops: { rel: string; content: string | null; prior: string | undefined }[] = [
    ...[...write].map(([rel, content]) => ({ rel, content, prior: disk.known.get(rel) })),
    ...[...remove].map((rel) => ({ rel, content: null, prior: disk.known.get(rel) })),
  ];
  for (const op of ops) noteWrite(disk, op.rel, op.content);
  const errors = await writeBatchAtomic(
    ops.map((op) => ({ file: path.join(dir, op.rel), content: op.content })),
  );
  const failed: unknown[] = [];
  for (const op of ops) {
    const file = path.join(dir, op.rel);
    if (!errors.has(file)) {
      disk.unsaved.delete(op.rel);
      continue;
    }
    // Each write is atomic: the disk still has the old file, and so does `known`.
    if (op.prior === undefined) disk.known.delete(op.rel);
    else disk.known.set(op.rel, op.prior);
    disk.writes++;
    disk.unsaved.set(op.rel, op.content);
    failed.push(errors.get(file));
  }
  if (failed.length > 0) {
    const first = failed[0] instanceof Error ? failed[0].message : String(failed[0]);
    const n = disk.unsaved.size;
    throw new Error(`${n} file${n === 1 ? '' : 's'} not saved: ${first}`);
  }
}

/** Writes every file of a world (e.g. to create a fixture). */
export async function writeWorldDir(dir: string, world: World): Promise<void> {
  await initWorldDir(dir);
  await writeChanges(dir, { write: worldToFiles(world), remove: [] });
}
