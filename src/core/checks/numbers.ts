import type { World } from '../model/world';

/**
 * The checks' view of the numbers engine (package W3 owns it, in
 * `src/core/numbers`). Two questions only, so the checks can be written and
 * tested now against stubs and wired to W3's API at integration.
 */
export interface FormulaProblem {
  message: string;
  /** The formula or variable name, when known. */
  name?: string;
  /** Character offsets in `numbers/formulas.carbon`. */
  span?: { start: number; end: number };
}

export interface CurveDeviation {
  entity: string;
  attribute: string;
  value: number;
  /** What the intent curve says at this entity's place. */
  expected: number;
  /** How far off counts as "far", in the attribute's units. */
  tolerance: number;
}

export interface NumbersAdapter {
  formulaProblems(world: World): FormulaProblem[];
  curveDeviations(world: World): CurveDeviation[];
  /** Formula source lines an export of these entities depends on (export.ts). */
  dependencies?(world: World, entityIds: readonly string[]): string[];
}

/** No numbers engine yet: no formula problems, no deviations. */
export const noNumbers: NumbersAdapter = {
  formulaProblems: () => [],
  curveDeviations: () => [],
};
