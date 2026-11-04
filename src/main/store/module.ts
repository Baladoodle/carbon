import { shell } from 'electron';
import { mkdir } from 'node:fs/promises';
import type { StoreNotice } from '@shared/ipc';
// Type-only: modules.ts imports this file eagerly (import.meta.glob), so a value import
// of `defineMainModule` would be a cycle that runs before modules.ts has defined it.
import type { MainModule } from '../modules';
import { diskState, DEFAULT_SETTLE_MS } from './disk-state';
import { Dismissals } from './dismissals';
import { listExports, writeExport } from './exports';
import { Snapshotter, type SnapshotResult } from './git';
import { WorldWatcher } from './watcher';
import { quarantineDir } from './world-dir';

/**
 * The store in the running app (package W6): the file watcher, git snapshots
 * after idle time and on quit, notices for the status line and toasts, note
 * dismissals, and export. Loading, migrations, quarantine and atomic writes
 * happen in `loadWorldDir`/`writeChanges`, which the session already uses.
 *
 * Settings (`carbon.json`, loose keys): `snapshot.idleMinutes` (default 10),
 * `snapshot.enabled` (default true), `watch.conflictSeconds` (default 15).
 * Environment: `CARBON_WATCH=off` and `CARBON_SNAPSHOTS=off` turn each off.
 */
const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;

const storeModule: MainModule = {
  name: 'store',
  start({ session, handle, send, window }) {
    const dir = session.dir;
    const disk = diskState(dir);
    const loadIssues = session.snapshot().issues;
    const settings = (): Record<string, unknown> => session.world.settings;
    const sub = (key: string): Record<string, unknown> => {
      const v = settings()[key];
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
    };

    // ── Notices: pulled once by the renderer, pushed after that ─────────────
    const notices: StoreNotice[] = [];
    const notify = (n: StoreNotice): void => {
      if (notices.some((x) => x.id === n.id)) return;
      notices.push(n);
      const w = window();
      if (w) send(w, 'store:notice', n);
    };
    const last = disk.lastLoad;
    if (last?.migrated)
      notify({
        id: 'migrated',
        tone: 'info',
        text: `World upgraded from format ${last.migrated.from} to ${last.migrated.to}; backup in ${last.migrated.backup}`,
      });
    if (disk.readOnly)
      notify({ id: 'read-only', tone: 'error', text: `Read-only: ${disk.readOnly}` });

    // ── The watcher ─────────────────────────────────────────────────────────
    disk.settleMs = num(sub('watch').conflictSeconds, DEFAULT_SETTLE_MS / 1000) * 1000;
    const watcher = new WorldWatcher(dir, session, {
      baseIssues: () => loadIssues,
      onConflicts: (c) => {
        const w = window();
        if (w) send(w, 'store:conflicts', c);
      },
      onError: (e) => console.warn('carbon: watcher', e),
    });
    if (process.env.CARBON_WATCH !== 'off') watcher.start();

    // ── Git snapshots: after N idle minutes, and on quit ────────────────────
    const snapshots = new Snapshotter(dir, () => session.world);
    const enabled = (): boolean =>
      process.env.CARBON_SNAPSHOTS !== 'off' && sub('snapshot').enabled !== false;
    const report = (r: SnapshotResult): SnapshotResult => {
      if (r.status === 'unavailable')
        notify({
          id: 'snapshot-unavailable',
          tone: 'error',
          text: `No git snapshots: ${r.reason}`,
        });
      if (r.status === 'failed')
        notify({
          id: `snapshot-failed:${r.message}`,
          tone: 'error',
          text: `Git snapshot failed: ${r.message}`,
        });
      return r;
    };
    let idle: ReturnType<typeof setTimeout> | null = null;
    const armIdle = (): void => {
      if (idle) clearTimeout(idle);
      idle = null;
      if (!enabled()) return;
      const minutes = num(sub('snapshot').idleMinutes, 10);
      idle = setTimeout(() => {
        idle = null;
        void session
          .flush()
          .then(() => snapshots.snapshot('idle'))
          .then(report);
      }, minutes * 60_000);
    };
    const offPatch = session.onPatch(() => armIdle());
    armIdle();
    if (enabled())
      void snapshots
        .prepare()
        .then((r) => (r.ok ? undefined : report({ status: 'unavailable', reason: r.reason })));

    // ── Note dismissals ─────────────────────────────────────────────────────
    const dismissals = new Dismissals(dir);

    // ── IPC ─────────────────────────────────────────────────────────────────
    handle('store:notices', () => [...notices]);
    handle('store:conflicts', () => watcher.conflicts());
    handle('store:resolveConflict', async (req) => ({
      ok: await watcher.resolve(req.id, req.keep),
    }));
    handle('store:openQuarantine', async () => {
      const q = quarantineDir(dir);
      await mkdir(q, { recursive: true });
      const err = await shell.openPath(q);
      return { ok: err === '' };
    });
    handle('store:snapshotNow', async () => {
      await session.flush();
      return report(await snapshots.snapshot('manual'));
    });
    handle('notes:dismissals', () => dismissals.all());
    handle('notes:setDismissal', async (req) => {
      await dismissals.set(req.id, req.hash);
      return { ok: true as const };
    });
    handle('export:write', (req) => writeExport(session, req));
    handle('export:list', () => listExports(dir));

    return async () => {
      offPatch();
      if (idle) clearTimeout(idle);
      watcher.stop();
      await session.flush();
      if (!enabled()) return;
      // On quit: a final snapshot, but never hold the quit hostage (git gets 8 s).
      await Promise.race([
        snapshots.snapshot('quit').then(report),
        new Promise((r) => setTimeout(r, 8000)),
      ]);
    };
  },
};

export default storeModule;
