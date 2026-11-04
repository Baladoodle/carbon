import { useMemo } from 'react';
import { NumbersEngine, type NumbersAnalysis } from '@core/numbers';
import type { World } from '@core/model/world';
import { createStore, useStore } from '../../state/store';
import { useWorld } from '../../state/world';

/**
 * The Numbers view's local state: the formula draft being typed (committed to
 * the world after a pause or on blur) and one incremental engine over the
 * world mirror, so values, errors and curves follow every keystroke without
 * waiting for the main process.
 */
export interface NumbersUi {
  /** The editor's text while it differs from the world's; null when in sync. */
  draft: string | null;
}

export const numbersUi = createStore<NumbersUi>({ draft: null });

const engine = new NumbersEngine();
const drafted = new WeakMap<World, { draft: string; world: World }>();

/** The world as the view sees it: the mirror with the draft formulas, if any. */
function viewWorld(world: World, draft: string | null): World {
  if (draft === null || draft === world.numbers.formulas) return world;
  const hit = drafted.get(world);
  if (hit?.draft === draft) return hit.world;
  const w: World = { ...world, numbers: { ...world.numbers, formulas: draft } };
  drafted.set(world, { draft, world: w });
  return w;
}

export interface Numbers {
  /** The mirror, with the draft formulas if there is a draft. */
  world: World;
  analysis: NumbersAnalysis;
  /** The formulas as committed to the world. */
  committed: string;
}

/** The analysis for the current world and draft (undefined while the world loads). */
export function useNumbers(): Numbers | undefined {
  const world = useWorld((w) => w, Object.is);
  const draft = useStore(numbersUi, (s) => s.draft);
  return useMemo(() => {
    if (!world) return undefined;
    const w = viewWorld(world, draft);
    return { world: w, analysis: engine.update(w), committed: world.numbers.formulas };
  }, [world, draft]);
}
