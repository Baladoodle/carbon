import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  exportCommands,
  exportPath,
  isExportable,
  readExportHeader,
  withExportHeader,
} from '@core/export/spec';
import { getEntity } from '@core/model/world';
import type { ExportRecord, InvokeResponse } from '@shared/ipc';
import { removeFileDurable, writeFileAtomic } from './atomic';
import type { StepEffect, WorldSession } from '../world-session';

/**
 * Writing an export (docs/EXPERIENCE.md §7) as one transaction: the spec file
 * is written atomically, then the entities are marked exported in one command
 * transaction (one undo step). If marking fails, the file is removed again, so
 * there is never a spec on disk for entities that weren't marked.
 */
export const localDate = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function existingExports(dir: string): Promise<string[]> {
  try {
    return (await readdir(path.join(dir, 'exports')))
      .filter((n) => n.endsWith('.md'))
      .map((n) => `exports/${n}`);
  } catch {
    return [];
  }
}

/** One export at a time per directory: two at once must not pick the same file name. */
const queues = new Map<string, Promise<unknown>>();

export function writeExport(
  session: Pick<WorldSession, 'dir' | 'world' | 'dispatch' | 'flush'>,
  req: { name: string; markdown: string; entityIds: string[] },
  date = localDate(),
): Promise<InvokeResponse<'export:write'>> {
  const prev = queues.get(session.dir) ?? Promise.resolve();
  const run = prev.then(() => writeOne(session, req, date));
  queues.set(
    session.dir,
    run.catch(() => undefined),
  );
  return run;
}

/**
 * Undo removes the spec file and redo writes it back, unless you edited the
 * file since: then it's yours and stays as it is (the states still revert).
 */
function specEffect(file: string, written: string): StepEffect {
  const current = (): Promise<string | null> => readFile(file, 'utf8').catch(() => null);
  return {
    async undo() {
      if ((await current()) === written) await removeFileDurable(file);
    },
    async redo() {
      if ((await current()) === null) await writeFileAtomic(file, written);
    },
  };
}

async function writeOne(
  session: Pick<WorldSession, 'dir' | 'world' | 'dispatch' | 'flush'>,
  req: { name: string; markdown: string; entityIds: string[] },
  date: string,
): Promise<InvokeResponse<'export:write'>> {
  const fail = (code: string, message: string): InvokeResponse<'export:write'> => ({
    ok: false,
    error: { code, message },
  });
  const ids = [...new Set(req.entityIds)];
  for (const id of ids) {
    const e = getEntity(session.world, id);
    if (!e) return fail('export.missing', `"${id}" doesn't exist`);
    if (!isExportable(e)) return fail('export.state', `${e.name} isn't decided`);
  }
  const rel = exportPath(date, req.name, new Set(await existingExports(session.dir)));
  const file = path.join(session.dir, rel);
  const text = withExportHeader(req.markdown, { name: req.name, date, entities: ids });
  await writeFileAtomic(file, text);
  const cmds = exportCommands(session.world, ids);
  if (cmds.length > 0) {
    const r = session.dispatch(cmds, `Export ${req.name}`, specEffect(file, text));
    if (!r.ok) {
      await removeFileDurable(file);
      return { ok: false, error: r.error };
    }
  }
  await session.flush();
  return { ok: true, path: rel, marked: cmds.length };
}

/** Every export carbon wrote, newest first. */
export async function listExports(dir: string): Promise<ExportRecord[]> {
  const out: ExportRecord[] = [];
  for (const rel of await existingExports(dir)) {
    try {
      const h = readExportHeader(await readFile(path.join(dir, rel), 'utf8'));
      if (h) out.push({ path: rel, ...h });
    } catch {
      // unreadable: not ours to report
    }
  }
  return out.sort((a, b) => b.path.localeCompare(a.path));
}
