import { useEffect, type ReactNode } from 'react';
import { installKeymap, useActions, type Action } from '../actions';
import { AiLog } from '../ai/AiLog';
import { ai, startAiSync } from '../ai/client';
import { Bench } from '../bench/Bench';
import { Palette } from '../palette/Palette';
import { flash, setUi, uiStore, useUi } from '../state/ui';
import { redo, startWorldSync, undo, useWorldMeta } from '../state/world';
import { startTheme } from '../theme/theme';
import { VIEWS, viewById } from '../views/registry';
import { Rail } from './Rail';
import { StatusLine } from './StatusLine';

/** The shell's own actions: views, Bench, palette, undo/redo, AI log, AI off. */
function useShellActions(): void {
  const meta = useWorldMeta();
  const toggleOverlay = (name: string) => (): void =>
    setUi({ overlay: uiStore.get().overlay === name ? null : name });
  const actions: Action[] = [
    ...VIEWS.map((v) => ({
      id: `view.${v.id}`,
      label: `Go to ${v.label}`,
      group: 'Views',
      keys: [v.key],
      run: () => setUi({ view: v.id }),
    })),
    {
      id: 'bench.toggle',
      label: 'Toggle the Bench',
      group: 'Window',
      keys: ['b'],
      run: () => setUi({ benchOpen: !uiStore.get().benchOpen }),
    },
    {
      id: 'palette.open',
      label: 'Command palette',
      group: 'Window',
      keys: ['ctrl+k'],
      run: toggleOverlay('palette'),
      inInputs: true,
    },
    {
      id: 'ai-log.open',
      label: 'AI log',
      group: 'AI',
      keys: ['ctrl+l'],
      run: toggleOverlay('ai-log'),
      inInputs: true,
    },
    {
      id: 'ai.toggle',
      label: 'Turn AI off / on for the session',
      group: 'AI',
      keys: ['ctrl+shift+a'],
      run: () => {
        const on = !ai.status().enabled;
        ai.setEnabled(on);
        flash(on ? 'AI on' : 'AI off for this session');
      },
    },
    {
      id: 'world.undo',
      label: meta.history.undoLabel ? `Undo ${meta.history.undoLabel}` : 'Undo',
      group: 'Edit',
      keys: ['ctrl+z'],
      enabled: () => meta.history.canUndo,
      run: () =>
        void undo().then((r) =>
          flash(r.ok ? `Undid ${r.label ?? ''}` : r.error.message, r.ok ? 'info' : 'error'),
        ),
    },
    {
      id: 'world.redo',
      label: meta.history.redoLabel ? `Redo ${meta.history.redoLabel}` : 'Redo',
      group: 'Edit',
      keys: ['ctrl+shift+z', 'ctrl+y'],
      enabled: () => meta.history.canRedo,
      run: () =>
        void redo().then((r) =>
          flash(r.ok ? `Redid ${r.label ?? ''}` : r.error.message, r.ok ? 'info' : 'error'),
        ),
    },
    {
      id: 'overlay.close',
      label: 'Close',
      keys: ['escape'],
      hidden: true,
      enabled: () => uiStore.get().overlay !== null,
      run: () => setUi({ overlay: null }),
    },
  ];
  useActions(actions);
}

export function App(): ReactNode {
  useEffect(() => {
    startTheme();
    startAiSync();
    void startWorldSync();
    return installKeymap();
  }, []);
  useShellActions();
  const viewId = useUi((s) => s.view);
  const benchOpen = useUi((s) => s.benchOpen);
  const overlay = useUi((s) => s.overlay);
  const meta = useWorldMeta();
  const view = viewById(viewId) ?? VIEWS[0];
  const View = view?.component;

  return (
    <div
      className={benchOpen ? 'shell with-bench' : 'shell'}
      data-testid="shell"
      data-view={view?.id}
    >
      <Rail />
      <main className="main" data-testid={`view-${view?.id ?? 'none'}`}>
        {meta.status === 'loading' ? (
          <div className="placeholder dim">Loading the world…</div>
        ) : View ? (
          <View />
        ) : null}
      </main>
      {benchOpen && (
        <aside className="bench" data-testid="bench" aria-label="Bench">
          <Bench />
        </aside>
      )}
      <StatusLine />
      {overlay === 'palette' && <Palette />}
      {overlay === 'ai-log' && <AiLog />}
    </div>
  );
}
