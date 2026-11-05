import { useEffect, useState, type ReactNode } from 'react';
import { installKeymap, useActions, type Action, RANK } from '../actions';
import { AiLog } from '../ai/AiLog';
import { ai, startAiSync } from '../ai/client';
import { Bench } from '../bench/Bench';
import { Palette } from '../palette/Palette';
import { PlatformRuntime } from '../palette/Platform';
import { flash, setUi, uiStore, useUi } from '../state/ui';
import { redo, startWorldSync, undo, useWorldMeta } from '../state/world';
import {
  ResizablePane,
  Toaster,
  TooltipProvider,
  anyPane,
  canToggleFocused,
  nearestPane,
  toggleFocused,
} from '../ui';
import { Gallery } from '../ui/Gallery';
import { invoke } from '../bridge';
import { VIEWS, viewById } from '../views/registry';
import { Rail } from './Rail';
import { StatusLine } from './StatusLine';

/** The Bench's width until it's resized (min 300px, max 60% of the window). */
const BENCH_W = 360;

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
      id: 'field.expand',
      label: 'Expand the field',
      group: 'Edit',
      keys: ['ctrl+shift+e'],
      inInputs: true,
      enabled: canToggleFocused,
      run: () => void toggleFocused(),
    },
    {
      id: 'pane.widen',
      label: 'Widen panel',
      group: 'Window',
      enabled: anyPane,
      run: () => nearestPane()?.step(1),
    },
    {
      id: 'pane.narrow',
      label: 'Narrow panel',
      group: 'Window',
      enabled: anyPane,
      run: () => nearestPane()?.step(-1),
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
  // The floor: a view or the Bench binding the same key wins over the shell.
  useActions(actions, true, { rank: RANK.shell });
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
    { rank: RANK.shell },
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
          <ResizablePane
            id="bench"
            edge="start"
            defaultSize={BENCH_W}
            min={300}
            max={({ window }) => window * 0.6}
            onCollapse={() => setUi({ benchOpen: false })}
            label="Bench width"
            className="shell-bench"
          >
            <aside className="bench" data-testid="bench" aria-label="Bench">
              <Bench />
            </aside>
          </ResizablePane>
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
