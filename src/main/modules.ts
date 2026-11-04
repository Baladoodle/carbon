import { type MainContext, type MainModule, type Stop } from './module-def';

export { defineMainModule, type MainContext, type MainModule, type Stop } from './module-def';

/** Every `src/main/<package>/module.ts`, found at build time (see module-def.ts). */
const found = import.meta.glob<{ default: MainModule }>('./*/module.ts', { eager: true });

export const MAIN_MODULES: MainModule[] = Object.values(found)
  .map((m) => m.default)
  .sort((a, b) => a.name.localeCompare(b.name));

/** Starts every module; returns one function that stops them all (in reverse). */
export async function startModules(
  ctx: MainContext,
  modules: MainModule[] = MAIN_MODULES,
): Promise<() => Promise<void>> {
  const stops: Stop[] = [];
  for (const m of modules) {
    try {
      const stop = await m.start(ctx);
      if (stop) stops.push(stop);
    } catch (e) {
      console.error(`carbon: module ${m.name} failed to start`, e);
    }
  }
  return async () => {
    for (const stop of stops.reverse()) {
      try {
        await stop();
      } catch (e) {
        console.error('carbon: a module failed to stop', e);
      }
    }
  };
}
