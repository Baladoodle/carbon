import type { World } from '../model/world';
import {
  formulaErrors,
  intentDeviations,
  NumbersEngine,
  relevantFormulas,
  type NumbersAnalysis,
} from '../numbers';

/**
 * The checks' (and the export's) view of the numbers engine
 * (`src/core/numbers`): formula errors, attributes far off their intent
 * curve, and the formulas a set of entities depends on.
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

/** No numbers at all (for tests that check something else). */
export const noNumbers: NumbersAdapter = {
  formulaProblems: () => [],
  curveDeviations: () => [],
};

/**
 * The adapter over W3's engine. It keeps one incremental `NumbersEngine`, so
 * asking for the same world twice (problems, then deviations) analyses once,
 * and an edit re-evaluates only what it touched.
 */
export function createNumbersAdapter(engine = new NumbersEngine()): NumbersAdapter {
  let lastWorld: World | null = null;
  let last: NumbersAnalysis | null = null;
  const analysis = (world: World): NumbersAnalysis => {
    if (world !== lastWorld || !last) {
      last = engine.update(world);
      lastWorld = world;
    }
    return last;
  };
  return {
    // Errors only; warnings (a property hiding a name) show inline in Numbers.
    // The id is the definition and message, not the line, so a dismissal
    // survives inserting a line above it.
    formulaProblems: (world) =>
      formulaErrors(analysis(world))
        .filter((e) => e.severity === 'error')
        .map((e) => ({ message: e.message, ...(e.def ? { name: e.def } : {}) })),
    curveDeviations: (world) =>
      intentDeviations(analysis(world), world).map((d) => ({
        entity: d.entity,
        attribute: d.curve,
        value: d.value,
        expected: d.intent,
        // W3's tolerance is relative to the intent; the checks want units.
        tolerance: Math.abs(d.tolerance * d.intent),
      })),
    dependencies: (world, ids) => {
      const a = analysis(world);
      const seen = new Set<string>();
      const out: { line: number; text: string }[] = [];
      for (const id of ids)
        for (const f of relevantFormulas(a, world, id))
          if (!seen.has(f.name)) {
            seen.add(f.name);
            out.push({ line: f.line, text: f.text });
          }
      return out.sort((x, y) => x.line - y.line).map((f) => f.text);
    },
  };
}
