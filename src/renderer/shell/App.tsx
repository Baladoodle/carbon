import { useEffect, useState, type ReactNode } from 'react';
import { installKeymap, useActions, type Action } from '../actions';
import { AiLog } from '../ai/AiLog';
import { ai, startAiSync } from '../ai/client';
import { Bench } from '../bench/Bench';
import { Palette } from '../palette/Palette';
import { PlatformRuntime } from '../palette/Platform';
import { flash, setUi, uiStore, useUi } from '../state/ui';
import { redo, startWorldSync, undo, useWorldMeta } from '../state/world';
import { Toaster, TooltipProvider } from '../ui';
import { Gallery } from '../ui/Gallery';
import { invoke } from '../bridge';
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
      // The status line shows the result, so no toast.
      run: () => ai.setEnabled(!ai.status().enabled),
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
    startAiSync();
    void startWorldSync();
    return installKeymap();
  }, []);
  useShellActions();
  // The UI kit gallery: development and e2e builds only.
  const [devTools, setDevTools] = useState(import.meta.env.DEV);
  useEffect(() => {
    void invoke('app:info', null).then((i) => {
      if (i.e2e) setDevTools(true);
    });
  }, []);
  useActions(
    [
      {
        id: 'dev.ui-kit',
        label: 'UI kit',
        group: 'Development',
        run: () => setUi({ overlay: 'ui-kit' }),
      },
    ],
    devTools,
  );
  const viewId = useUi((s) => s.view);
  const benchOpen = useUi((s) => s.benchOpen);
  const overlay = useUi((s) => s.overlay);
  const meta = useWorldMeta();
  const view = viewById(viewId) ?? VIEWS[0];
  const View = view?.component;

  return (
    <TooltipProvider>
      <div
        className={benchOpen ? 'shell with-bench' : 'shell'}
        data-testid="shell"
        data-view={view?.id}
      >
        <Rail />
        <main className="main" data-testid={`view-${view?.id ?? 'none'}`}>
          {meta.status !== 'loading' && View ? <View /> : null}
        </main>
        {benchOpen && (
          <aside className="bench" data-testid="bench" aria-label="Bench">
            <Bench />
          </aside>
        )}
        <StatusLine />
        {overlay === 'palette' && <Palette />}
        {overlay === 'ai-log' && <AiLog />}
        {overlay === 'ui-kit' && <Gallery />}
        <PlatformRuntime />
        <Toaster />
      </div>
    </TooltipProvider>
  );
}
