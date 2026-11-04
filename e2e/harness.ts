import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from '@core/commands/registry';
import type { DispatchResult, InvokeChannel, InvokeRequest, InvokeResponse } from '@shared/ipc';

/**
 * The end-to-end harness. `launchCarbon()` copies a fixture world to a
 * temporary directory and starts the built app on it (FakeAiGateway and a
 * private userData dir), so tests never touch real data.
 */
export interface CarbonApp {
  app: ElectronApplication;
  page: Page;
  /** The temporary world directory the app is editing. */
  worldDir: string;
  /** Calls a main-process channel through the preload bridge. */
  invoke<C extends InvokeChannel>(
    channel: C,
    request: InvokeRequest<C>,
  ): Promise<InvokeResponse<C>>;
  /** Sends commands as one undo step. */
  dispatch(...commands: Command[]): Promise<DispatchResult>;
  /** Switches view with its rail key and waits for it. */
  gotoView(id: string, key: string): Promise<void>;
  /** Saves `test-results/screens/<name>.png` (and `docs/screens/<name>.png` with UPDATE_SCREENS=1). */
  screenshot(name: string): Promise<void>;
  close(): Promise<void>;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export interface LaunchOptions {
  /** A folder in fixtures/worlds (default `sample`), or null for a brand-new world. */
  world?: string | null;
  /** A world directory anywhere on disk to copy instead of a fixture (e.g. a generated one). Added by W1. */
  worldDir?: string;
  /** Extra environment (e.g. `{ CARBON_AI: 'off' }` or `{ CARBON_AI_DELAY_MS: '50' }`). */
  env?: Record<string, string>;
}

export async function launchCarbon(opts: LaunchOptions = {}): Promise<CarbonApp> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'carbon-e2e-'));
  const worldDir = path.join(tmp, 'world');
  const world = opts.world === undefined ? 'sample' : opts.world;
  if (opts.worldDir) cpSync(opts.worldDir, worldDir, { recursive: true });
  else if (world) cpSync(path.join(ROOT, 'fixtures/worlds', world), worldDir, { recursive: true });
  const userData = path.join(tmp, 'user-data');
  mkdirSync(userData, { recursive: true });

  const app = await electron.launch({
    args: ['--no-sandbox', path.join(ROOT, 'out/main/index.js')],
    cwd: ROOT,
    env: {
      ...process.env,
      CARBON_E2E: '1',
      CARBON_WORLD_DIR: worldDir,
      CARBON_USER_DATA: userData,
      CARBON_AI: 'fake',
      ...opts.env,
    },
  });
  const page = await app.firstWindow();
  await page.waitForSelector('[data-testid="shell"]');
  await page.waitForSelector('[data-testid="status-entities"]');

  const invoke = <C extends InvokeChannel>(
    channel: C,
    request: InvokeRequest<C>,
  ): Promise<InvokeResponse<C>> =>
    page.evaluate(([c, r]) => window.carbon.invoke(c as never, r as never), [
      channel,
      request,
    ] as const);

  return {
    app,
    page,
    worldDir,
    invoke,
    dispatch: (...commands) => invoke('world:dispatch', { commands }),
    async gotoView(id, key) {
      await page.locator('body').press(key);
      await page.waitForSelector(`[data-testid="view-${id}"]`);
    },
    async screenshot(name) {
      const file = path.join(ROOT, 'test-results/screens', `${name}.png`);
      await page.screenshot({ path: file, animations: 'disabled' });
      if (process.env.UPDATE_SCREENS === '1')
        cpSync(file, path.join(ROOT, 'docs/screens', `${name}.png`));
    },
    async close() {
      await app.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}
