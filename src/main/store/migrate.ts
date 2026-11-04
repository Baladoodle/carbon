import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { PATHS, type FileMap } from '@core/files/world-files';
import { removeFileDurable, writeFileAtomic } from './atomic';
import { ensureMetaDir, exists, META, readJson, removeMeta, stamp, writeJson } from './meta';
import { migrateFiles, MIGRATIONS, type Migration } from './migrations';

/**
 * Running a migration on disk, safely:
 *
 * 1. back up every file carbon reads to `.carbon/backups/<stamp>-format-<from>/`,
 *    with a `manifest.json`
 * 2. write the marker `.carbon/migration.json` (only once the backup is complete)
 * 3. write the migrated files atomically, removals next, `carbon.json` last
 * 4. remove the marker
 *
 * If carbon dies anywhere in 3, the marker is still there on the next open:
 * `recoverMigration` puts the backup back exactly, and the migration runs again.
 */
export interface MigrationReport {
  from: number;
  to: number;
  /** The backup folder, relative to the world directory. */
  backup: string;
}

interface Manifest {
  from: number;
  to: number;
  at: string;
  files: string[];
  migrations: string[];
}

interface Marker {
  from: number;
  to: number;
  backup: string;
}

export interface MigrateOptions {
  migrations?: readonly Migration[];
  at: string;
  read: (dir: string) => Promise<FileMap>;
  /** Testing only: throw after this many writes of migrated files (a simulated crash). */
  crashAfterWrites?: number;
}

export async function migrateWorldDir(
  dir: string,
  files: FileMap,
  from: number,
  to: number,
  opts: MigrateOptions,
): Promise<{ ok: true; report: MigrationReport } | { ok: false; message: string }> {
  const list = opts.migrations ?? MIGRATIONS;
  const r = migrateFiles(files, from, to, list);
  if (!r.ok) return r;
  const next = r.files;

  // 1. The backup, complete before anything else changes.
  await ensureMetaDir(dir);
  const backup = `${META.backups}/${stamp(opts.at)}-format-${from}`;
  for (const [rel, content] of files) await writeFileAtomic(path.join(dir, backup, rel), content);
  const manifest: Manifest = {
    from,
    to,
    at: opts.at,
    files: [...files.keys()],
    migrations: list.filter((m) => m.from >= from && m.to <= to).map((m) => m.describe),
  };
  await writeJson(dir, `${backup}/manifest.json`, manifest);

  // 2. The marker.
  const marker: Marker = { from, to, backup };
  await writeJson(dir, META.migration, marker);

  // 3. The migrated files; carbon.json last, so its format only changes once the rest is done.
  let writes = 0;
  const step = (): void => {
    writes++;
    if (opts.crashAfterWrites !== undefined && writes > opts.crashAfterWrites)
      throw new Error('simulated crash during migration');
  };
  const order = [...next.keys()].filter((p) => p !== PATHS.settings);
  for (const rel of order) {
    const content = next.get(rel) as string;
    if (files.get(rel) === content) continue;
    step();
    await writeFileAtomic(path.join(dir, rel), content);
  }
  for (const rel of files.keys()) {
    if (next.has(rel)) continue;
    step();
    await removeFileDurable(path.join(dir, rel));
  }
  step();
  await writeFileAtomic(path.join(dir, PATHS.settings), next.get(PATHS.settings) ?? '');

  // 4. Done.
  await removeMeta(dir, META.migration);
  return { ok: true, report: { from, to, backup } };
}

const isMarker = (v: unknown): v is Marker =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as Marker).backup === 'string' &&
  (v as Marker).backup.startsWith(`${META.backups}/`) &&
  !(v as Marker).backup.includes('..');

/**
 * Undoes a migration that was interrupted: restores the backup exactly (files
 * the migration created are removed) and clears the marker. Returns whether a
 * recovery happened.
 */
export async function recoverMigration(
  dir: string,
  read: (dir: string) => Promise<FileMap>,
): Promise<boolean> {
  if (!(await exists(path.join(dir, META.migration)))) return false;
  const marker = await readJson(dir, META.migration);
  const manifest = isMarker(marker)
    ? ((await readJson(dir, `${marker.backup}/manifest.json`)) as Manifest | undefined)
    : undefined;
  if (!isMarker(marker) || !manifest || !Array.isArray(manifest.files)) {
    // The marker is written after the backup is complete, so this can only be a
    // hand-made or damaged marker: leave the files alone.
    await removeMeta(dir, META.migration);
    return false;
  }
  const safe = (rel: string): boolean =>
    typeof rel === 'string' && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
  const files = manifest.files.filter(safe);
  const current = await read(dir);
  const backedUp = new Set(files);
  for (const rel of current.keys())
    if (!backedUp.has(rel)) await removeFileDurable(path.join(dir, rel));
  for (const rel of files) {
    const content = await readFile(path.join(dir, marker.backup, rel), 'utf8');
    await writeFileAtomic(path.join(dir, rel), content);
  }
  await removeMeta(dir, META.migration);
  return true;
}
