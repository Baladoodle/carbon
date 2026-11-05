import { describe, expect, it } from 'vitest';
import type { Candidate } from '@core/ai/moments';
import { MOVE_DEFS } from '@core/spreads/moves';
import { createIpcAiGateway, type AiBridge } from './client';

/**
 * The partial/reply ordering of the IPC client. `ai:partial` events and the
 * `ai:run` reply have no shared order in Electron, so a fake bridge here
 * delivers them in the orders load produced: the reply first, partials late,
 * partials out of order, some never.
 */

const cand = (i: number): Candidate => ({
  key: `c${i}`,
  kind: 'item',
  name: `Candidate ${i}`,
  identity: `It does thing ${i}.`,
  fields: {},
  attributes: {},
  relations: [],
  position: { x: 0.5, y: 0.5 },
  wildcard: i === 6,
});
const CANDS = [1, 2, 3, 4, 5, 6].map(cand);
const META = {
  moment: 'spread' as const,
  requestHash: 'h',
  model: 'm',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  costUsd: 0,
  latencyMs: 1,
  cached: false,
  dropped: 0,
};
const REQ = {
  spot: { type: 'cell' as const, band: 'low-sky', lane: 'items' as const },
  move: 'fill' as const,
  count: 6,
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** A bridge whose `ai:run` reply resolves at once, with partials sent when the test says. */
function fakeBridge(reply: { ok: boolean; partials?: number } = { ok: true, partials: 6 }) {
  let listener: ((e: { requestId: string; seq: number; partial: unknown }) => void) | null = null;
  let requestId = '';
  const cancels: string[] = [];
  const bridge = {
    on: (_channel: string, l: typeof listener) => {
      listener = l;
      return () => undefined;
    },
    invoke: (channel: string, req: { requestId: string }) => {
      if (channel === 'ai:cancel') {
        cancels.push(req.requestId);
        return Promise.resolve({ ok: true });
      }
      requestId = req.requestId;
      return Promise.resolve(
        reply.ok
          ? {
              ok: true,
              result: { axes: MOVE_DEFS.fill.axes, candidates: CANDS },
              meta: META,
              partials: reply.partials,
            }
          : {
              ok: false,
              error: { code: 'server', message: 'stream broke', retryable: true },
              meta: META,
              partials: reply.partials,
            },
      );
    },
  } as unknown as AiBridge;
  const send = (seq: number, id = requestId): void =>
    listener?.({ requestId: id, seq, partial: CANDS[seq] });
  return { bridge, send, cancels, id: () => requestId };
}

describe('the IPC AI client orders partials before the reply', () => {
  it('resolves only after every partial, delivered in order, even when the reply comes first', async () => {
    const f = fakeBridge();
    const g = createIpcAiGateway(f.bridge, { waitMs: 1000 });
    const seen: string[] = [];
    let resolved = false;
    const run = g
      .run('spread', REQ, { onPartial: (c) => seen.push(c.key) })
      .then((r) => ((resolved = true), r));
    await tick();
    // The reply has arrived; only 2 of 6 partials have (the reported failure).
    f.send(0);
    f.send(1);
    await tick();
    expect(resolved).toBe(false);
    expect(seen).toEqual(['c1', 'c2']);
    // The rest arrive late and out of order.
    f.send(4);
    f.send(2);
    f.send(5);
    f.send(3);
    const out = await run;
    expect(out.ok).toBe(true);
    expect(seen).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
    // The streamed items are the result's, in the same order.
    expect(out.ok && out.result.candidates.map((c) => c.key)).toEqual(seen);
  });

  it('drops a partial for a finished request, and duplicates', async () => {
    const f = fakeBridge({ ok: true, partials: 2 });
    const g = createIpcAiGateway(f.bridge, { waitMs: 1000 });
    const seen: string[] = [];
    const run = g.run('spread', REQ, { onPartial: (c) => seen.push(c.key) });
    await tick();
    f.send(0);
    f.send(0);
    f.send(1);
    await run;
    const id = f.id();
    f.send(2, id);
    f.send(3, 'someone-else');
    expect(seen).toEqual(['c1', 'c2']);
  });

  it('fails loudly when partials never arrive', async () => {
    const f = fakeBridge();
    const g = createIpcAiGateway(f.bridge, { waitMs: 30 });
    const seen: string[] = [];
    const run = g.run('spread', REQ, { onPartial: (c) => seen.push(c.key) });
    await tick();
    f.send(0);
    const out = await run;
    expect(out).toMatchObject({
      ok: false,
      error: { code: 'server', message: 'lost 5 of 6 streamed results in transit' },
    });
    // And nothing lands afterwards.
    f.send(1);
    expect(seen).toEqual(['c1']);
  });

  it('a failed run still waits for the partials it streamed', async () => {
    const f = fakeBridge({ ok: false, partials: 2 });
    const g = createIpcAiGateway(f.bridge, { waitMs: 1000 });
    const seen: string[] = [];
    const run = g.run('spread', REQ, { onPartial: (c) => seen.push(c.key) });
    await tick();
    f.send(1);
    f.send(0);
    const out = await run;
    expect(out).toMatchObject({ ok: false, error: { code: 'server' } });
    expect(seen).toEqual(['c1', 'c2']);
  });

  it('after a cancel, no partial reaches the caller', async () => {
    const f = fakeBridge();
    const g = createIpcAiGateway(f.bridge, { waitMs: 1000 });
    const seen: string[] = [];
    const ac = new AbortController();
    const run = g.run('spread', REQ, { signal: ac.signal, onPartial: (c) => seen.push(c.key) });
    await tick();
    f.send(0);
    ac.abort();
    f.send(1);
    f.send(2);
    await run;
    expect(seen).toEqual(['c1']);
    expect(f.cancels).toEqual([f.id()]);
  });

  it('a run with no partials resolves at once', async () => {
    const f = fakeBridge({ ok: true, partials: 0 });
    const g = createIpcAiGateway(f.bridge, { waitMs: 10_000 });
    const out = await g.run('spread', REQ);
    expect(out.ok).toBe(true);
  });
});
