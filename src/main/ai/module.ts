import type { MainModule } from '../modules';
import { ClaudeAiGateway } from './gateway';

/**
 * The AI's main-process module: starts the JSONL log in the world directory,
 * loads this month's spend, re-checks the budget whenever settings change (so
 * raising the budget un-pauses the AI), and serves `ai:request` for the AI log.
 *
 * A plain object with a type-only import: `modules.ts` loads every module with
 * an eager `import.meta.glob`, which runs before its own `defineMainModule`
 * is defined, so a module that calls it at import time crashes.
 */
const aiModule: MainModule = {
  name: 'ai',
  async start({ ai, session, info, handle }) {
    const real = ai instanceof ClaudeAiGateway ? ai : null;
    handle('ai:request', (req) => real?.request(req.id) ?? null);
    if (!real) return;
    await real.attach(info.worldDir);
    const off = session.onPatch((e) => {
      if (e.patch.some((op) => op.path[0] === 'settings')) real.refresh();
    });
    return async () => {
      off();
      await real.log$.flush();
    };
  },
};

export default aiModule;
