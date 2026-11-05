import { expect, test, type Locator, type Page } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { launchCarbon, type CarbonApp } from './harness';

/**
 * The agent socket end to end (docs/MCP.md): a real MCP client from the
 * official SDK, through the real `carbon mcp` (out/main/mcp.js under
 * Electron in node mode, as the launcher runs it), over the Unix socket, into
 * the running app, with the user's view of it checked through the UI.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELAY = path.join(ROOT, 'scripts/carbon-mcp.mjs');

const chip = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="column-svg"] [data-id="${id}"]`).first();
const field = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="bench-entity"] [data-bench-field="${key}"]`);

async function connect(socket: string, name = 'carbon-e2e'): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [RELAY],
    env: { ...(process.env as Record<string, string>), CARBON_SOCKET: socket },
    stderr: 'pipe',
  });
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

async function data<T>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const r = await call(client, name, args);
  if (r.isError) throw new Error(r.content[0]?.text);
  return JSON.parse(r.content[0]?.text ?? 'null') as T;
}

test.describe('an agent over carbon mcp', () => {
  test.describe.configure({ mode: 'serial' });
  let carbon: CarbonApp;
  let client: Client;

  test.beforeAll(async () => {
    carbon = await launchCarbon();
    await carbon.gotoView('column', '1');
    client = await connect(carbon.socket);
  });
  test.afterAll(async () => {
    await client.close();
    await carbon.close();
  });

  test('lists the tools, and the status line names the agent @smoke', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of [
      'world_summary',
      'find_entities',
      'create_entity',
      'set_state',
      'spread',
      'judge_candidate',
      'focus',
    ])
      expect(names).toContain(n);
    await expect(carbon.page.getByTestId('status-agent')).toHaveText('carbon-e2e');
    expect(statSync(carbon.socket).mode & 0o777).toBe(0o600);
  });

  test('reads the world the app holds', async () => {
    const s = await data<{ entities: number; bands: { id: string }[] }>(client, 'world_summary');
    expect(s.entities).toBe(24);
    expect(s.bands.map((b) => b.id)).toContain('low-sky');
    const found = await data<{ entities: { id: string }[] }>(client, 'find_entities', {
      query: 'kind:item subkind:accessory',
    });
    expect(found.entities.map((e) => e.id)).toEqual(['cloud-anklet']);
  });

  test('creates an entity the user sees in the Column, marked as the agent’s, and ctrl+z undoes it', async () => {
    const { page } = carbon;
    const made = await data<{ id: string }>(client, 'create_entity', {
      kind: 'creature',
      name: 'Ash Heron',
      identity: 'Wades the vents for embers.',
      relations: [{ type: 'in_band', target: 'undercroft' }],
    });
    expect(made.id).toBe('ash-heron');
    await expect(chip(page, 'ash-heron')).toBeVisible();
    await data(client, 'focus', { id: 'ash-heron' });
    await expect(page.getByTestId('bench-entity')).toHaveAttribute('data-entity', 'ash-heron');
    await expect(field(page, 'identity').getByTestId('agent-marker-identity')).toBeVisible();
    await page.mouse.move(5, 5);
    await page.locator('body').press('Control+z');
    await expect(chip(page, 'ash-heron')).toHaveCount(0);
    const gone = await call(client, 'get_entity', { id: 'ash-heron' });
    expect(gone.isError).toBe(true);
  });

  test('is refused by the Why gate with the command’s own reason', async () => {
    const r = await call(client, 'set_state', { id: 'spore-lantern', state: 'decided' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^state\.missing_fields: .*why/);
  });

  test('an agent edit of a field the user is typing in asks which to keep', async () => {
    const { page } = carbon;
    await data(client, 'focus', { id: 'reef-ray' });
    const identity = field(page, 'identity').locator('input');
    const conflict = field(page, 'identity').getByTestId('field-conflict');
    await identity.click();
    await identity.fill('Mine, typed.');
    await data(client, 'update_entity', { id: 'reef-ray', set: { identity: 'The agent’s.' } });
    await expect(conflict).toContainText('Changed by the agent');
    await expect(conflict).toHaveAttribute('data-by', 'agent');
    await expect(identity).toHaveValue('Mine, typed.');
    await conflict.getByRole('button', { name: 'Keep mine' }).click();
    await expect(conflict).toHaveCount(0);
    await identity.press('Escape');
  });

  test('is refused a paid call until the user allows spending', async () => {
    const r = await call(client, 'suggest', { entityId: 'glide', field: 'identity' });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^agent\.spend_off:/);
  });

  test('with spending allowed, runs a spread on the fake AI and keeps a candidate', async () => {
    const { page } = carbon;
    await page.mouse.move(5, 5);
    await page.locator('body').press('Control+Shift+l');
    const panel = page.getByTestId('agent-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('agent-log-row').first()).toBeVisible();
    const spend = panel.getByTestId('agent-spend');
    await expect(spend).toHaveAttribute('aria-checked', 'false');
    await spend.click();
    await expect(spend).toHaveAttribute('aria-checked', 'true');
    await carbon.screenshot('mcp-agent-panel', { docs: true });
    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);

    const s = await data<{ id: string; candidates: { key: string; role: string; name: string }[] }>(
      client,
      'spread',
      { spot: { type: 'cell', band: 'low-sky', lane: 'items' }, move: 'fill', count: 4 },
    );
    const first = s.candidates.find((c) => c.role === 'new');
    expect(first).toBeDefined();
    const kept = await data<{ entity: string }>(client, 'judge_candidate', {
      spread: s.id,
      key: first?.key,
      verdict: 'keep',
      note: 'The drift needs light.',
    });
    await expect(chip(page, kept.entity)).toBeVisible();
    const killed = s.candidates.filter((c) => c.role === 'new')[1];
    await data(client, 'judge_candidate', {
      spread: s.id,
      key: killed?.key,
      verdict: 'kill',
      reason: '1',
    });

    // The call is in the AI log, marked as the agent's.
    await page.locator('body').press('Control+l');
    await expect(page.getByTestId('ai-log-via-agent').first()).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('the Agent overlay lists the calls and undoes the last write', async () => {
    const { page } = carbon;
    await data(client, 'set_variable', { name: 'k', value: 120 });
    await page.locator('body').press('Control+Shift+l');
    const panel = page.getByTestId('agent-panel');
    const top = panel.getByTestId('agent-log-row').first();
    await expect(top).toHaveAttribute('data-tool', 'set_variable');
    await expect(
      panel.locator('[data-tool="set_state"][data-outcome="error"]').first(),
    ).toBeVisible();
    await top.getByTestId('agent-undo').click();
    await expect(top.getByTestId('agent-undo')).toHaveCount(0);
    const n = await data<{ variables: Record<string, unknown> }>(client, 'get_numbers');
    expect(n.variables.k).toBe(100);
    await page.keyboard.press('Escape');
  });

  test('turning access off refuses the agent', async () => {
    await carbon.invoke('agent:setSettings', { access: false });
    const r = await call(client, 'world_summary');
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/^agent\.access_off:/);
    await expect(carbon.page.getByTestId('status-agent')).toContainText('access off');
    await carbon.invoke('agent:setSettings', { access: true });
  });
});

test.describe('carbon mcp and the socket', () => {
  test('carbon mcp with no carbon running says so and exits 1', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'carbon-mcp-'));
    try {
      const r = spawnSync(process.execPath, [RELAY], {
        env: { ...process.env, CARBON_SOCKET: path.join(dir, 'carbon.sock') },
        input: '',
        encoding: 'utf8',
      });
      expect(r.status).toBe(1);
      expect(r.stdout).toBe('');
      expect(r.stderr.trim()).toBe(
        "carbon mcp: carbon isn't running. Start it (`carbon`), then connect the agent again.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a socket left by a crashed carbon is replaced', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'carbon-stale-'));
    const socket = path.join(dir, 'carbon.sock');
    // A carbon that crashed: something listening on the socket, killed before it could clean up.
    const child = spawn(process.execPath, [
      '-e',
      `require('net').createServer().listen(${JSON.stringify(socket)}, () => process.stdout.write('up'))`,
    ]);
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
    child.kill('SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(statSync(socket).isSocket()).toBe(true);
    const carbon = await launchCarbon({ env: { CARBON_SOCKET: socket } });
    try {
      const client = await connect(carbon.socket, 'after-a-crash');
      const s = await data<{ entities: number }>(client, 'world_summary');
      expect(s.entities).toBe(24);
      await expect(carbon.page.getByTestId('status-agent')).toHaveText('after-a-crash');
      await client.close();
      await expect(carbon.page.getByTestId('status-agent')).toHaveCount(0);
    } finally {
      await carbon.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
