import { useEffect, useState, type ReactNode } from 'react';
import { createNumbersAdapter } from '@core/checks/numbers';
import { resolvedPlaces } from '@core/checks/placement';
import { createCheckRunner, type CheckAdapters } from '@core/checks/runner';
import type { Note } from '@core/model/notes';
import { stableStringify } from '@core/util/json';
import { CheckFeed, checkWorker, type FromWorker, type ToWorker } from './check-feed';
import type { StoreConflict } from '@shared/ipc';
import { useActions } from '../actions';
import { invoke, on } from '../bridge';
import { notesStore, publishNotes } from '../state/notes';
import { worldStore, useWorldMeta } from '../state/world';
import { Button, Dialog, toast } from '../ui';
import './platform.css';

/**
 * The platform's always-on part of the renderer (package W6), mounted once by
 * the shell:
 *
 * - runs the mechanical checks on every world change, incrementally, and
 *   publishes them as `checks` notes
 * - keeps note dismissals: persisted per world with the inputs hash they were
 *   dismissed for, so a dismissed note stays dismissed until its inputs change
 * - shows the conflict dialog when an external edit collides with carbon's
 *   unsaved edit, and the store's one-time notices as toasts
 * - registers the store's actions (open the quarantine folder, snapshot now,
 *   restore dismissed notes)
 */

/**
 * The adapters the checks run with: placement from `resolvePlacement` and
 * numbers from one incremental numbers engine (the export shares them).
 */
export const CHECK_ADAPTERS: Required<CheckAdapters> = {
  placement: resolvedPlaces,
  numbers: createNumbersAdapter(),
};

/** The check runner: in a worker when one can start, else on this thread. */
function checkTarget(onResult: (r: FromWorker) => void): {
  post: (m: ToWorker) => void;
  stop: () => void;
} {
  try {
    const worker = new Worker(new URL('./checks.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<FromWorker>) => onResult(e.data);
    worker.onerror = (e) => console.warn('carbon: checks worker', e.message);
    return { post: (m) => worker.postMessage(m), stop: () => worker.terminate() };
  } catch {
    const handle = checkWorker(createCheckRunner(CHECK_ADAPTERS));
    return {
      post: (m) => {
        const r = handle(m);
        if (r) onResult(r);
      },
      stop: () => undefined,
    };
  }
}

function useChecks(): void {
  useEffect(() => {
    const feed = new CheckFeed();
    let latest = -1;
    const target = checkTarget((r) => {
      // Only the newest run counts: an older one may finish late.
      if (r.rev !== latest) return;
      publishNotes('checks', r.notes);
    });
    let timer: ReturnType<typeof setTimeout> | null = null;
    let first: number | null = null;
    const run = (): void => {
      timer = null;
      first = null;
      const { world: w, rev } = worldStore.get();
      if (!w) return;
      const msg = feed.next(rev, w);
      if (!msg) return;
      latest = rev;
      target.post(msg);
    };
    // Coalesce bursts of patches (typing commits, drags, a run of commands)
    // into one run after the burst: QUIET ms after the last patch, and never
    // more than MAX_WAIT ms after the first. The run itself is in a worker, so
    // it never delays a frame or a command's round trip.
    const QUIET = 120;
    const MAX_WAIT = 500;
    const schedule = (): void => {
      const now = performance.now();
      first ??= now;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, Math.max(0, Math.min(QUIET, first + MAX_WAIT - now)));
    };
    const offPatch = on('world:patch', (e) => feed.onPatch(e.rev, e.patch));
    run();
    const off = worldStore.subscribe(schedule);
    return () => {
      off();
      offPatch();
      target.stop();
      if (timer) clearTimeout(timer);
    };
  }, []);
}

const hashOf = (n: Note): string => n.inputsHash ?? '';

/** Persisted dismissals (note id → inputs hash), once loaded from the world. */
let persisted: Record<string, string> | null = null;

/** Clears every dismissal, in memory and on disk. */
export function restoreDismissed(): void {
  const ids = new Set([
    ...Object.keys(notesStore.get().dismissed),
    ...Object.keys(persisted ?? {}),
  ]);
  persisted = persisted ? {} : null;
  notesStore.set((s) => ({ ...s, dismissed: {} }));
  for (const id of ids) void invoke('notes:setDismissal', { id, hash: null });
}

/** Reconciles the in-memory dismissals with the persisted ones (see the header). */
function useDismissals(): void {
  useEffect(() => {
    let busy = false;
    const reconcile = (): void => {
      if (!persisted || busy) return;
      const p = persisted;
      const s = notesStore.get();
      const byId = new Map<string, Note>();
      for (const list of Object.values(s.bySource)) for (const n of list) byId.set(n.id, n);
      const dismissed: Record<string, true> = { ...s.dismissed };
      let changed = false;
      for (const [id, n] of byId) {
        const saved = p[id];
        if (dismissed[id]) {
          if (saved === undefined) {
            // Dismissed just now: remember what it was dismissed for.
            p[id] = hashOf(n);
            void invoke('notes:setDismissal', { id, hash: hashOf(n) });
          } else if (saved !== hashOf(n)) {
            // Its inputs changed: it comes back.
            delete dismissed[id];
            delete p[id];
            changed = true;
            void invoke('notes:setDismissal', { id, hash: null });
          }
        } else if (saved !== undefined && saved === hashOf(n)) {
          dismissed[id] = true;
          changed = true;
        }
      }
      if (changed) {
        busy = true;
        try {
          notesStore.set({ ...notesStore.get(), dismissed });
        } finally {
          busy = false;
        }
      }
    };
    const off = notesStore.subscribe(reconcile);
    void invoke('notes:dismissals', null).then((d) => {
      persisted = { ...d };
      reconcile();
    });
    return off;
  }, []);
}

function useNotices(): void {
  useEffect(() => {
    const seen = new Set<string>();
    const show = (n: { id: string; tone: 'info' | 'error'; text: string }): void => {
      if (seen.has(n.id)) return;
      seen.add(n.id);
      toast(n.text, { tone: n.tone });
    };
    const off = on('store:notice', show);
    void invoke('store:notices', null).then((ns) => ns.forEach(show));
    return off;
  }, []);
}

const short = (v: unknown): string => {
  if (v === undefined || v === null || v === '') return '—';
  const s = typeof v === 'string' ? v : stableStringify(v);
  return s.length > 140 ? `${s.slice(0, 139)}…` : s;
};

const fieldName = (key: string): string =>
  key === '(file)' ? 'the whole file' : key.replace(/^(fields|attributes)\./, '');

/** The conflict dialog: one row per file, carbon's value against the file's, keep one. */
function Conflicts(): ReactNode {
  const [list, setList] = useState<StoreConflict[]>([]);
  useEffect(() => {
    const off = on('store:conflicts', setList);
    void invoke('store:conflicts', null).then(setList);
    return off;
  }, []);
  const resolve = async (id: string, keep: 'ours' | 'theirs'): Promise<void> => {
    await invoke('store:resolveConflict', { id, keep });
    setList(await invoke('store:conflicts', null));
  };
  const resolveAll = async (keep: 'ours' | 'theirs'): Promise<void> => {
    for (const c of list) await invoke('store:resolveConflict', { id: c.id, keep });
    setList(await invoke('store:conflicts', null));
  };
  const one = list.length === 1 ? list[0] : undefined;
  return (
    <Dialog
      open={list.length > 0}
      // Choosing is required: escape and outside clicks don't dismiss it.
      onOpenChange={() => undefined}
      title="Changed outside carbon"
      showTitle
      className="platform-conflicts"
      footer={
        <>
          <Button onClick={() => void resolveAll('theirs')} data-testid="conflict-theirs">
            {one ? 'Keep the file’s' : 'Keep every file’s'}
          </Button>
          <Button
            variant="primary"
            onClick={() => void resolveAll('ours')}
            data-testid="conflict-ours"
          >
            {one ? 'Keep carbon’s' : 'Keep all of carbon’s'}
          </Button>
        </>
      }
    >
      <div className="platform-conflict-list" data-testid="conflicts">
        {list.map((c) => (
          <section key={c.id} className="platform-conflict">
            <div className="platform-conflict-head">
              <span className="platform-conflict-name">{c.entity?.name ?? c.path}</span>
              {!one && (
                <span className="platform-conflict-actions">
                  <Button size="sm" variant="ghost" onClick={() => void resolve(c.id, 'theirs')}>
                    File’s
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void resolve(c.id, 'ours')}>
                    Carbon’s
                  </Button>
                </span>
              )}
            </div>
            <table className="platform-conflict-fields">
              <thead>
                <tr>
                  <th />
                  <th>carbon</th>
                  <th>file</th>
                </tr>
              </thead>
              <tbody>
                {c.fields.map((f) => (
                  <tr key={f.key}>
                    <th scope="row">{fieldName(f.key)}</th>
                    <td>{short(f.ours)}</td>
                    <td>{short(f.theirs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function useStoreActions(): void {
  const meta = useWorldMeta();
  const quarantined = meta.issues.some((i) => i.message.includes('.carbon/quarantine/'));
  useActions([
    {
      id: 'store.quarantine',
      label: 'Open the quarantine folder',
      group: 'World',
      enabled: () => quarantined,
      run: () =>
        void invoke('store:openQuarantine', null).then((r) => {
          if (!r.ok) toast('Couldn’t open the quarantine folder', { tone: 'error' });
        }),
    },
    {
      id: 'store.snapshot',
      label: 'Snapshot the world to git now',
      group: 'World',
      run: () =>
        void invoke('store:snapshotNow', null).then((r) => {
          if (r.status === 'committed') toast(`Snapshot: ${r.message.split('\n')[0] ?? ''}`);
          else if (r.status === 'clean') toast('Nothing to snapshot');
          // unavailable and failed arrive as notices
        }),
    },
    {
      id: 'notes.restore',
      label: 'Show dismissed notes again',
      group: 'Notes',
      enabled: () =>
        Object.keys(notesStore.get().dismissed).length > 0 ||
        Object.keys(persisted ?? {}).length > 0,
      run: restoreDismissed,
    },
  ]);
}

/** Mounted once by the shell; renders only the conflict dialog when there is one. */
export function PlatformRuntime(): ReactNode {
  useChecks();
  useDismissals();
  useNotices();
  useStoreActions();
  return <Conflicts />;
}
