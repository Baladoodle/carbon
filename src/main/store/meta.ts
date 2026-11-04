import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from './atomic';

/**
 * `.carbon/` inside the world directory: carbon's own bookkeeping, never part
 * of the world. Created lazily, the first time something needs it.
 *
 * ```
 * .carbon/
 *   .gitignore           keeps backups and quarantine out of git snapshots
 *   quarantine/<stamp>/  files that failed to load, moved aside with their paths
 *   backups/<stamp>-format-<n>/   the world before a migration
 *   migration.json       present only while a migration runs (crash recovery)
 *   dismissals.json      dismissed notes and the inputs they were dismissed for
 * ```
 */
export const META_DIR = '.carbon';
export const META = {
  dir: META_DIR,
  gitignore: `${META_DIR}/.gitignore`,
  quarantine: `${META_DIR}/quarantine`,
  backups: `${META_DIR}/backups`,
  migration: `${META_DIR}/migration.json`,
  dismissals: `${META_DIR}/dismissals.json`,
} as const;

const GITIGNORE = `# carbon: backups and quarantined files stay out of the world's history
quarantine/
backups/
migration.json
`;

/** A filesystem-safe timestamp, e.g. `2026-11-04T21-30-00-000Z`. */
export const stamp = (iso: string): string => iso.replace(/[:.]/g, '-');

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Makes sure `.carbon/.gitignore` exists (idempotent). */
export async function ensureMetaDir(dir: string): Promise<void> {
  const gi = path.join(dir, META.gitignore);
  if (!(await exists(gi))) await writeFileAtomic(gi, GITIGNORE);
}

/** Reads a JSON file under the world directory; undefined when missing or unreadable. */
export async function readJson(dir: string, rel: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path.join(dir, rel), 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

export async function writeJson(dir: string, rel: string, value: unknown): Promise<void> {
  await ensureMetaDir(dir);
  await writeFileAtomic(path.join(dir, rel), `${JSON.stringify(value, null, 2)}\n`);
}

export async function removeMeta(dir: string, rel: string): Promise<void> {
  await rm(path.join(dir, rel), { force: true, recursive: true });
}
