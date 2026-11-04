import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * The AI package (W4) end to end. These run the REAL gateway in the app
 * (`CARBON_AI=replay`): the packer, the request shape, the SDK, streaming, the
 * cache, the JSONL log and cost accounting, against an offline Claude API that
 * answers from each request's schema (src/main/ai/replay.ts).
 */

let carbon: CarbonApp;
const page = (): CarbonApp['page'] => carbon.page;

test.beforeAll(async () => {
  carbon = await launchCarbon({ env: { CARBON_AI: 'replay' } });
});
test.afterAll(async () => {
  await carbon.close();
});

/** Puts an entity on the Bench through the palette. */
async function focus(name: string): Promise<void> {
  await page().locator('body').press('Control+k');
  await page().keyboard.type(name);
  await page().keyboard.press('Enter');
  await expect(page().getByTestId('palette')).toHaveCount(0);
}

const logRows = () => page().getByTestId('ai-log-row');

test('@smoke critique on demand goes through the real gateway into the AI log', async () => {
  const status = page().getByTestId('status-ai');
  await expect(status).toHaveAttribute('data-mode', 'real');
  await expect(status).toHaveText('$0.00 / $2.00');
  await focus('Glide');
  await page().locator('body').press('?');
  await expect(status).toHaveAttribute('data-state', 'idle');
  await page().locator('body').press('Control+l');
  const log = page().getByTestId('ai-log');
  await expect(log).toBeVisible();
  await expect(logRows().first()).toContainText('critique');
  await expect(logRows().first()).toContainText('glide');
  await expect(page().getByTestId('ai-log-totals')).toContainText('1 call');
  await page().keyboard.press('Enter');
  const request = page().getByTestId('ai-log-request');
  await expect(request).toContainText('<<system: digest · cached>>');
  await expect(request).toContainText('# Moment: critique');
  await expect(request).toContainText('effort low');
  await page().keyboard.press('Escape');
  await expect(request).toHaveCount(0);
  await page().keyboard.press('Escape');
  await expect(log).toHaveCount(0);
  // The JSONL log is in the world directory, without any key.
  const jsonl = (): string[] =>
    readdirSync(path.join(carbon.worldDir, 'ai-log')).filter((f) => f.endsWith('.jsonl'));
  await expect.poll(() => jsonl().length).toBe(1);
  const file = jsonl()[0]!;
  const line = readFileSync(path.join(carbon.worldDir, 'ai-log', file), 'utf8');
  expect(line).toContain('"moment":"critique"');
  expect(line).not.toContain('replay"'); // the replay client's dummy key never reaches the log
});

test('@smoke the off switch stops the AI for the session and turns it back on', async () => {
  const status = page().getByTestId('status-ai');
  await page().locator('body').press('Control+Shift+a');
  await expect(status).toHaveText('AI off: AI is off for this session');
  await expect(status).toHaveAttribute('data-state', 'off');
  const out = await carbon.invoke('ai:run', {
    requestId: 'off-1',
    moment: 'critique',
    request: { entityId: 'glide', trigger: 'on_demand' },
  });
  expect(out).toMatchObject({ ok: false, error: { code: 'disabled' } });
  await page().locator('body').press('Control+Shift+a');
  await expect(status).toHaveAttribute('data-state', 'idle');
});

test('an unchanged critique is served from the content-hash cache', async () => {
  const req = {
    moment: 'critique' as const,
    request: { entityId: 'cinder-wasp', trigger: 'on_demand' },
  };
  const a = await carbon.invoke('ai:run', { requestId: 'c-1', ...req });
  const b = await carbon.invoke('ai:run', { requestId: 'c-2', ...req });
  expect(a.ok && b.ok).toBe(true);
  expect(b.ok && b.meta.cached).toBe(true);
  expect(b.ok && b.meta.costUsd).toBe(0);
});

test('finishing an edit and changing state trigger a critique', async () => {
  await focus('Spore Lantern');
  const before = (await carbon.invoke('ai:log', {})).length;
  const r = await carbon.dispatch({
    type: 'entity.update',
    payload: { id: 'spore-lantern', set: { identity: 'Light that breathes, and remembers.' } },
  });
  expect(r.ok).toBe(true);
  await focus('Glide'); // focus leaves Spore Lantern after a change
  await expect
    .poll(async () =>
      (await carbon.invoke('ai:log', {})).slice(before).map((e) => `${e.entity}:${e.trigger}`),
    )
    .toContain('spore-lantern:finish_edit');
  const s = await carbon.dispatch({
    type: 'entity.setState',
    payload: { id: 'high-drift', state: 'graveyard', killed: { reason: 'seen it' } },
  });
  expect(s.ok).toBe(true);
  // Killing it is not critiqued; resurrecting it is a state change that is.
  await carbon.dispatch({ type: 'entity.setState', payload: { id: 'high-drift', state: 'idea' } });
  await expect
    .poll(async () =>
      (await carbon.invoke('ai:log', {})).slice(before).map((e) => `${e.entity}:${e.trigger}`),
    )
    .toContain('high-drift:state_change');
  const triggers = (await carbon.invoke('ai:log', {}))
    .slice(before)
    .filter((e) => e.entity === 'high-drift');
  expect(triggers).toHaveLength(1);
});

test('a spread streams candidates over IPC through the real gateway', async () => {
  const out = await page().evaluate(async () => {
    const parts: string[] = [];
    const off = window.carbon.on('ai:partial', (e) => {
      if (e.requestId === 's-1') parts.push((e.partial as { name: string }).name);
    });
    const res = await window.carbon.invoke('ai:run', {
      requestId: 's-1',
      moment: 'spread',
      request: { spot: { type: 'cell', band: 'low-sky', lane: 'items' }, move: 'fill', count: 6 },
    });
    off();
    return {
      parts,
      names: res.ok
        ? (res.result as { candidates: { name: string }[] }).candidates.map((c) => c.name)
        : [],
    };
  });
  expect(out.parts.length).toBeGreaterThan(0);
  expect(out.parts).toEqual(out.names);
});

test('the AI log shows every moment with costs and cache reads', async () => {
  await carbon.invoke('ai:run', {
    requestId: 'l-1',
    moment: 'suggest_three',
    request: { entityId: 'glide', field: 'name' },
  });
  await carbon.invoke('ai:run', {
    requestId: 'l-2',
    moment: 'fill_entity',
    request: { entityId: 'high-drift' },
  });
  await carbon.invoke('ai:run', {
    requestId: 'l-3',
    moment: 'spec_draft',
    request: { entityIds: ['cinder-sting'], name: 'First weapon' },
  });
  await carbon.invoke('ai:run', {
    requestId: 'l-4',
    moment: 'critique',
    request: { entityId: 'ghost-entity', trigger: 'on_demand' },
  });
  await page().locator('body').press('Control+l');
  await expect(page().getByTestId('ai-log')).toBeVisible();
  await expect(logRows().first()).toContainText('not_found');
  await expect(page().getByTestId('ai-log-totals')).toContainText('cache read');
  await carbon.screenshot('ai-log');
  await page().keyboard.press('j');
  await page().keyboard.press('Enter');
  await expect(page().getByTestId('ai-log-request')).toContainText('# Moment: spec draft');
  await carbon.screenshot('ai-log-request');
  await page().keyboard.press('Escape');
  await page().keyboard.press('Escape');
});

test('the AI pauses at the budget, and raising it resumes', async () => {
  const status = page().getByTestId('status-ai');
  await carbon.dispatch({
    type: 'settings.set',
    payload: { key: 'ai', value: { budget: { sessionUsd: 0, monthUsd: 20 } } },
  });
  await expect(status).toHaveAttribute('data-state', 'paused');
  await expect(status).toContainText('AI paused: Session budget of $0.00 reached');
  const out = await carbon.invoke('ai:run', {
    requestId: 'b-1',
    moment: 'critique',
    request: { entityId: 'glide', trigger: 'state_change' },
  });
  expect(out).toMatchObject({ ok: false, error: { code: 'budget' } });
  await status.click();
  const session = page().getByTestId('ai-budget-session');
  await expect(session).toBeVisible();
  await session.fill('5');
  await carbon.screenshot('ai-budget');
  await page().getByTestId('ai-budget-save').click();
  await expect(status).toHaveAttribute('data-state', 'idle');
  await expect(status).toContainText('/ $5.00');
  await carbon.screenshot('ai-status');
});

test('without a key the AI is off and says why', async () => {
  const off = await launchCarbon({ env: { CARBON_AI: 'real', ANTHROPIC_API_KEY: '' } });
  try {
    await expect(off.page.getByTestId('status-ai')).toHaveText(
      'AI off: No API key: set ANTHROPIC_API_KEY to turn the AI on',
    );
    await expect(off.page.getByTestId('status-ai')).toHaveAttribute('data-mode', 'off');
  } finally {
    await off.close();
  }
});
