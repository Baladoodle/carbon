import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { loadRecorded, replayFetch } from '../replay';
import Anthropic from '@anthropic-ai/sdk';
import type { World } from '@core/model/world';
import { ClaudeAiGateway } from '../gateway';
import { CASES } from './cases';
import {
  CONSISTENCY_CASES,
  consistencyMetric,
  consistencyWorld,
  fixtureAnswerer,
  gatewayAnswerer,
  loadConsistencyFixtures,
  runConsistency,
} from './consistency';
import { buildReport, reportMarkdown, type Report } from './metrics';
import { MODEL, runEvals, writeRecorded } from './runner';
import { evalWorld } from './worlds';

/**
 * `npm run eval` (scripts/eval.mjs sets the environment):
 *   CARBON_EVAL_MODE=live    the real API (needs ANTHROPIC_API_KEY)
 *   CARBON_EVAL_MODE=record  the real API, and every exchange saved to evals/fixtures/recorded/
 *   CARBON_EVAL_MODE=replay  offline, from the recorded fixtures (meaningful metrics, no cost)
 *   CARBON_EVAL_MODE=dry     offline, answers generated from each request's schema (pipeline check)
 *   CARBON_EVAL_MAX_USD      stop starting cases once this much is spent (default 1)
 *   CARBON_EVAL_ONLY         only cases whose id contains this
 */
const ROOT = path.resolve(import.meta.dirname, '../../../..');
const RECORDED = path.join(ROOT, 'evals/fixtures/recorded');
const REPORTS = path.join(ROOT, 'evals/reports');
const CONSISTENCY = path.join(ROOT, 'evals/fixtures/consistency');

it('prompt evals', async () => {
  const mode = (process.env.CARBON_EVAL_MODE ?? 'dry') as Report['mode'];
  const key = process.env.ANTHROPIC_API_KEY;
  const live = mode === 'live' || mode === 'record';
  if (live && !key) throw new Error('ANTHROPIC_API_KEY is not set');
  const only = process.env.CARBON_EVAL_ONLY;
  const cases = only ? CASES.filter((c) => c.id.includes(only)) : CASES;
  const fetchFn: typeof fetch = live
    ? globalThis.fetch
    : replayFetch(mode === 'replay' ? { recorded: loadRecorded(RECORDED) } : {});
  const world = evalWorld();
  const out = await runEvals({
    world,
    cases,
    fetch: fetchFn,
    maxUsd: Number(process.env.CARBON_EVAL_MAX_USD ?? '1'),
    ...(live && key ? { apiKey: key } : {}),
    log: (l) => console.log(`  ${l}`),
  });
  const at = new Date().toISOString();
  const ran = new Set(out.runs.map((r) => r.case.id));
  const skipped = cases.filter((c) => !ran.has(c.id)).map((c) => c.id);
  // Self-consistency (SYSTEM §8a): fill, accept all, critique. Live through the
  // real gateway; offline from evals/fixtures/consistency/ through the builders.
  const consistencyCases = only
    ? CONSISTENCY_CASES.filter((c) => c.id.includes(only))
    : CONSISTENCY_CASES;
  const ref: { world: World } = { world: consistencyWorld() };
  const answer =
    live && key
      ? gatewayAnswerer(
          new ClaudeAiGateway({
            getWorld: () => ref.world,
            client: new Anthropic({ apiKey: key, maxRetries: 0, timeout: 120_000 }),
          }),
          ref,
        )
      : fixtureAnswerer(loadConsistencyFixtures(CONSISTENCY));
  const consistency =
    consistencyCases.length === 0
      ? []
      : await runConsistency(consistencyWorld(), consistencyCases, answer, (l) =>
          console.log(`  ${l}`),
        );
  const report = buildReport(mode, at, MODEL, world, out.runs, skipped, {
    metrics: consistency.length > 0 ? [consistencyMetric(consistency)] : [],
    costUsd: consistency.reduce((a, r) => a + r.costUsd, 0),
  });
  await mkdir(REPORTS, { recursive: true });
  const stem = `${at.replace(/[:.]/g, '-')}-${mode}`;
  const md = reportMarkdown(report);
  await writeFile(path.join(REPORTS, `${stem}.md`), md, 'utf8');
  await writeFile(
    path.join(REPORTS, `${stem}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await writeFile(path.join(REPORTS, `latest-${mode}.md`), md, 'utf8');
  if (mode === 'record') {
    const n = await writeRecorded(RECORDED, out.exchanges, key);
    console.log(`  recorded ${n} exchanges in evals/fixtures/recorded/`);
  }
  console.log(`\n${md}`);
  console.log(`report: evals/reports/${stem}.md · spend $${report.costUsd.toFixed(4)}`);
  // Live and replayed runs gate on the metrics; a dry run only checks the pipeline.
  if (mode !== 'dry') expect(report.pass, 'a metric is below its target').toBe(true);
  else expect(out.runs.length).toBe(cases.length);
});
