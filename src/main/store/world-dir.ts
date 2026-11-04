import { readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { emptyWorld, type World } from '@core/model/world';
import {
  PATHS,
  WORLD_DIRS,
  worldFromFiles,
  worldToFiles,
  type FileChanges,
  type FileMap,
  type LoadIssue,
} from '@core/files/world-files';
import { mkdir } from 'node:fs/promises';
import { writeFileAtomic } from './atomic';

/**
 * The world directory on disk (basic version; package W6 hardens it with
 * quarantine, migrations, git snapshots and external-edit detection).
 */

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

async function listFiles(dir: string, rel: string, ext: string): Promise<string[]> {
  try {
    const names = await readdir(path.join(dir, rel));
    return names.filter((n) => n.endsWith(ext) && !n.startsWith('.')).map((n) => `${rel}/${n}`);
  } catch {
    return [];
  }
}

/** Reads every file carbon knows about into a path → content map. */
export async function readWorldFiles(dir: string): Promise<FileMap> {
  const rels: string[] = [
    PATHS.settings,
    PATHS.schema,
    PATHS.variables,
    PATHS.formulas,
    PATHS.rules,
    PATHS.reasons,
    PATHS.patterns,
  ];
  const kinds = await readdir(path.join(dir, 'entities'), { withFileTypes: true }).then(
    (ds) => ds.filter((d) => d.isDirectory()).map((d) => d.name),
    () => [] as string[],
  );
  for (const k of kinds) rels.push(...(await listFiles(dir, `entities/${k}`, '.md')));
  rels.push(...(await listFiles(dir, 'spreads', '.json')));
  const files: FileMap = new Map();
  await Promise.all(
    rels.map(async (rel) => {
      try {
        files.set(rel, await readFile(path.join(dir, rel), 'utf8'));
      } catch {
        // missing optional file
      }
    }),
  );
  return files;
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

/** Loads (and if needed initialises) a world directory. */
export async function loadWorldDir(dir: string): Promise<{ world: World; issues: LoadIssue[] }> {
  await initWorldDir(dir);
  return worldFromFiles(await readWorldFiles(dir));
}

/** Applies file changes: atomic writes, then removals. */
export async function writeChanges(dir: string, changes: FileChanges): Promise<void> {
  for (const [rel, content] of changes.write) await writeFileAtomic(path.join(dir, rel), content);
  for (const rel of changes.remove) await rm(path.join(dir, rel), { force: true });
}

/** Writes every file of a world (e.g. to create a fixture). */
export async function writeWorldDir(dir: string, world: World): Promise<void> {
  await initWorldDir(dir);
  await writeChanges(dir, { write: worldToFiles(world), remove: [] });
}
