import type { MainModule } from '../modules';
import { createImageGateway } from './index';

/**
 * The image gateway's main-process module: creates the gateway (fake, off or
 * OpenAI), serves the `images:*` IPC channels, pushes status, progress and
 * log lines, and re-sends the status when settings change (raising the
 * budget un-pauses images).
 *
 * A plain object with a type-only import (see src/main/module-def.ts).
 */
const imagesModule: MainModule = {
  name: 'images',
  async start({ session, ai, handle, send, window }) {
    const g = createImageGateway(session, ai);
    await g.attach();
    const push = <C extends 'images:status' | 'images:progress' | 'images:logged'>(
      channel: C,
      payload: Parameters<typeof send<C>>[2],
    ): void => {
      const w = window();
      if (w && !w.isDestroyed()) send(w, channel, payload);
    };
    const offStatus = g.onStatus((s) => push('images:status', s));
    g.onLogged = (e) => push('images:logged', e);

    const prompts = new Map<string, AbortController>();
    handle('images:prompt', async (req) => {
      const ac = new AbortController();
      const id = req.requestId;
      if (id) prompts.set(id, ac);
      try {
        return await g.prompt({ entityId: req.entityId, kind: req.kind }, ac.signal);
      } finally {
        if (id && prompts.get(id) === ac) prompts.delete(id);
      }
    });
    handle('images:estimate', (req) => g.estimate(req));
    handle('images:generate', (req) => g.generate(req));
    handle('images:iconFromConcept', (req) => g.iconFromConcept(req));
    handle('images:batchPlan', (req) => g.batchPlan(req));
    handle('images:batchRun', (req) => g.batchRun(req, (p) => push('images:progress', p)));
    handle('images:sheetRun', (req) => g.sheetRun(req, (p) => push('images:progress', p)));
    handle('images:sheetCrop', (req) => g.sheetCrop(req));
    handle('images:sheetAccept', (req) => g.sheetAccept(req));
    handle('images:cancel', (req) => {
      g.cancel(req.id);
      prompts.get(req.id)?.abort();
      return { ok: true as const };
    });
    handle('images:status', () => g.status());
    handle('images:file', (req) => g.file(req.entityId, req.imageId, req.variant));
    handle('images:deleteFiles', (req) => g.deleteFiles(req.entityId));
    handle('images:log', (req) => g.log(req.limit));

    const offPatch = session.onPatch((e) => {
      if (e.patch.some((op) => op.path[0] === 'settings')) g.refresh();
    });
    return async () => {
      offStatus();
      offPatch();
      await g.flush();
    };
  },
};

export default imagesModule;
