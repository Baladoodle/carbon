import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateWorld } from '@core/model/validate';
import { readWorldFiles, writeWorldDir } from '../../store/world-dir';
import { worldToFiles } from '@core/files/world-files';
import { replyStream, messageBody } from '../fixtures';
import { loadRecorded, replayFetch } from '../replay';
import { CASES, type EvalCase } from './cases';
import {
  buildReport,
  computeMetrics,
  meanOverlap,
  proposedNames,
  references,
  reportMarkdown,
  type CaseRun,
} from './metrics';
import { capturingFetch, messageFromSse, runEvals, toRecorded, writeRecorded } from './runner';
import { CLEAN, evalWorld, SEEDED } from './worlds';

const world = evalWorld();
const usage = { input: 1000, output: 100, cacheRead: 500, cacheWrite: 0 };
const run = (
  c: Partial<EvalCase> & Pick<EvalCase, 'moment'>,
  raw: unknown,
  more: Partial<CaseRun> = {},
): CaseRun => ({
  case: {
    id: c.id ?? `${c.moment}-x`,
    request: c.request ?? ({ entityId: 'glide', trigger: 'on_demand' } as never),
    ...c,
  },
  ok: true,
  raw,
  usage,
  costUsd: 0.001,
  latencyMs: 10,
  dropped: 0,
  ...more,
});

describe('the eval world', () => {
  it('is loadable: seeded flaws are warnings at most, never errors', () => {
    const problems = validateWorld(world);
    expect(problems.filter((p) => p.severity === 'error')).toEqual([]);
    expect(problems.some((p) => p.message.includes('frozen-reach'))).toBe(true);
    expect(SEEDED.map((s) => s.flaw).sort()).toEqual([
      'contradicts_relation',
      'contradicts_relation',
      'duplicate',
      'just_a_number',
      'rule_clash',
    ]);
    expect(CLEAN.length).toBeGreaterThanOrEqual(4);
    expect(new Set(CASES.map((c) => c.id)).size).toBe(CASES.length);
  });

  it('evals/worlds/flawed on disk matches evalWorld()', async () => {
    const dir = path.resolve(import.meta.dirname, '../../../../evals/worlds/flawed');
    if (process.env.UPDATE_FIXTURES === '1') {
      await rm(dir, { recursive: true, force: true });
      await writeWorldDir(dir, world);
      for (const d of ['exports', 'ai-log', 'spreads'])
        await writeFile(path.join(dir, d, '.gitkeep'), '');
    }
    const files = await readWorldFiles(dir);
    expect(new Map([...files].sort())).toEqual(new Map([...worldToFiles(world)].sort()));
  });
});

describe('metrics', () => {
  it('scores recall on seeded flaws and precision on clean entities', () => {
    const flaw = (id: string, catches: string[], kinds: string[]): CaseRun =>
      run(
        { id, moment: 'critique', expect: { catches } },
        { notes: kinds.map((kind) => ({ kind, text: 't', entities: [] })) },
      );
    const clean = (id: string, kinds: string[]): CaseRun =>
      run(
        { id, moment: 'critique', expect: { clean: true } },
        { notes: kinds.map((kind) => ({ kind, text: 't', entities: [] })) },
      );
    const m = computeMetrics(world, [
      flaw('a', ['duplicate'], ['duplicate']),
      flaw('b', ['rule_clash'], ['weak_identity']),
      clean('c', []),
      clean('d', ['weak_identity']),
    ]);
    const by = Object.fromEntries(m.map((x) => [x.id, x]));
    expect(by.recall).toMatchObject({ value: 0.5, pass: false });
    expect(by.recall!.detail).toContain('missed b (weak_identity)');
    expect(by.precision).toMatchObject({ value: 0.5, pass: false });
    expect(by.schema).toMatchObject({ value: 1, pass: true });
    expect(by.size).toMatchObject({ value: 1500, pass: true });
    expect(by.size!.detail).toContain('cache read rate 33.3%');
  });

  it('counts unresolved references, duplicate names and invalid outputs', () => {
    const runs = [
      run(
        { moment: 'critique' },
        { notes: [{ kind: 'duplicate', text: 't', entities: ['lumen-spore', 'nope'] }] },
      ),
      run(
        { moment: 'suggest_three', request: { entityId: 'glide', field: 'name' } },
        { suggestions: [{ value: 'Spore Lantern' }, { value: 'Kite' }, { value: 'kite' }] },
      ),
      run({ moment: 'suggest_one' }, undefined, {
        ok: false,
        error: { code: 'invalid_output', message: 'x', retryable: false },
      }),
      run({ moment: 'critique' }, undefined, {
        ok: false,
        error: { code: 'not_found', message: 'x', retryable: false },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ];
    const by = Object.fromEntries(computeMetrics(world, runs).map((x) => [x.id, x]));
    expect(by.references).toMatchObject({ value: 0.5, pass: false, detail: 'nope' });
    expect(by.duplicates!.value).toBeCloseTo(1 / 3);
    expect(by.schema!.value).toBeCloseTo(2 / 3);
    expect(by.recall!.value).toBeNull();
    expect(by.recall!.pass).toBeNull();
  });

  it('measures spread diversity by pairwise overlap', () => {
    expect(meanOverlap(['Glass Lung', 'Ember Coat', 'Drift Bell'])).toBe(0);
    expect(meanOverlap(['Iron Ring', 'Iron Ring'])).toBe(1);
    expect(meanOverlap(['only one'])).toBe(0);
    const spread = run(
      {
        moment: 'spread',
        request: { spot: { type: 'cell', band: 'low-sky', lane: 'items' }, move: 'fill' } as never,
      },
      {
        candidates: [
          {
            kind: 'item',
            name: 'Iron Ring',
            identity: 'grants defense',
            relations: [{ type: 'in_band', target: 'low-sky' }],
            about: null,
          },
          {
            kind: 'item',
            name: 'Iron Band',
            identity: 'grants defense',
            relations: [],
            about: 'glide',
          },
          { kind: null, name: 'Iron Exploit', identity: 'x', relations: [] },
        ],
      },
    );
    const by = Object.fromEntries(computeMetrics(world, [spread]).map((x) => [x.id, x]));
    expect(by['spread-names']!.pass).toBe(false);
    expect(by['spread-identity']!.value).toBeGreaterThan(0.3);
    expect(references(world, 'spread', spread.raw).map((r) => r.id)).toEqual(['low-sky', 'glide']);
    expect(proposedNames('spread', undefined, spread.raw)).toEqual(['Iron Ring']);
    expect(proposedNames('suggest_one', 'name', { suggestion: { value: 'X' } })).toEqual(['X']);
    expect(proposedNames('suggest_one', 'identity', { suggestion: { value: 'X' } })).toEqual([]);
  });

  it('builds a report and renders it as markdown', () => {
    const r = buildReport('dry', '2026-11-04T10:00:00.000Z', 'claude-haiku-5-5', world, [
      run({ moment: 'critique', expect: { clean: true } }, { notes: [] }),
    ]);
    expect(r.pass).toBe(true);
    expect(r.costUsd).toBe(0.001);
    const md = reportMarkdown(r);
    expect(md).toContain('# Prompt evals: PASS');
    expect(md).toContain('Dry run');
    expect(md).toContain('| Critique raises no notes on clean entities | 100.0% | ≥ 0.8 | pass |');
  });
});

describe('runner', () => {
  it('runs every case through the real gateway offline and captures each exchange', async () => {
    const out = await runEvals({ world, cases: CASES, fetch: replayFetch(), maxUsd: 1 });
    expect(out.runs).toHaveLength(CASES.length);
    expect(out.stoppedAtBudget).toBe(false);
    expect(out.runs.every((r) => r.raw !== undefined)).toBe(true);
    expect(out.exchanges.length).toBeGreaterThanOrEqual(CASES.length);
    const report = buildReport('dry', 'now', 'm', world, out.runs);
    expect(report.metrics.find((m) => m.id === 'size')!.pass).toBe(true);
  });

  it('stops at its spend cap', async () => {
    const out = await runEvals({
      world,
      cases: CASES,
      fetch: replayFetch(),
      maxUsd: 0.0005,
      log: () => undefined,
    });
    expect(out.stoppedAtBudget).toBe(true);
    expect(out.runs.length).toBeLessThan(CASES.length);
  });

  it('records exchanges as fixtures that replay, and never writes a key', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'carbon-record-'));
    try {
      const cases = CASES.filter((c) => c.moment === 'critique' || c.moment === 'spread').slice(
        0,
        7,
      );
      const live = await runEvals({ world, cases, fetch: replayFetch(), maxUsd: 1 });
      expect(await writeRecorded(dir, live.exchanges, 'sk-ant-api03-not-a-real-key')).toBe(
        live.exchanges.length,
      );
      const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(live.exchanges.length);
      for (const f of files)
        expect(await readFile(path.join(dir, f), 'utf8')).not.toMatch(/sk-ant-/);
      // Replaying the recordings gives the same raw outputs, without generating anything.
      const again = await runEvals({
        world,
        cases,
        fetch: replayFetch({ recorded: loadRecorded(dir) }),
        maxUsd: 1,
      });
      expect(again.runs.map((r) => r.raw)).toEqual(live.runs.map((r) => r.raw));
      // A fixture that would contain a credential is refused.
      const leak = {
        ...live.exchanges[0]!.exchange,
        body: { system: 'sk-ant-api03-abcdefghijklmnop' },
      };
      expect(toRecorded(cases[0]!, leak)).toBeNull();
      expect(
        toRecorded(cases[0]!, { ...leak, body: { k: 'my-secret-key-123' } }, 'my-secret-key-123'),
      ).toBeNull();
      expect(toRecorded(cases[0]!, { url: '', body: {}, status: 500 })).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rebuilds a streamed message from SSE, and tees responses without consuming them', async () => {
    const res = replyStream({
      text: '{"a":1}',
      usage: { input_tokens: 5, output_tokens: 3 },
      thinking: true,
      chunks: 3,
    });
    const m = messageFromSse(await res.text());
    expect(m?.content).toEqual([{ type: 'text', text: '{"a":1}', citations: null }]);
    expect(m?.usage.output_tokens).toBe(3);
    expect(m?.stop_reason).toBe('end_turn');
    expect(messageFromSse('data: {nope\n\n')).toBeUndefined();
    const sink: Parameters<typeof capturingFetch>[1] = [];
    const f = capturingFetch(
      () =>
        Promise.resolve(
          new Response(JSON.stringify(messageBody({ text: '{}' })), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
      sink,
    );
    const r = await f('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      body: '{"model":"m"}',
    });
    expect(((await r.json()) as { type: string }).type).toBe('message');
    expect(sink[0]).toMatchObject({
      body: { model: 'm' },
      status: 200,
      message: { type: 'message' },
    });
    await f('https://api.anthropic.com/v1/messages/count_tokens', { method: 'POST', body: '{}' });
    expect(sink).toHaveLength(1);
  });
});
