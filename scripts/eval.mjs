// `npm run eval`: prompt evals against the real API (docs/SYSTEM.md §8).
// Package W4 (ai) implements them in evals/; until then this is a no-op.
import { existsSync } from 'node:fs';

if (!existsSync('evals/run.mjs') && !existsSync('evals/run.ts')) {
  console.log('No evals yet: package W4 adds them in evals/.');
  process.exit(0);
}
console.log('evals/ exists: W4 should point this script at its runner.');
