import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiGateway } from './ai';
import { resolveWorldDir } from './config';
import { handle, registerIpc, send } from './ipc';
import { startModules } from './modules';
import { WorldSession } from './world-session';

const here = path.dirname(fileURLToPath(import.meta.url));
const isE2E = process.env.CARBON_E2E === '1';

let win: BrowserWindow | null = null;

if (isE2E && process.env.CARBON_USER_DATA) app.setPath('userData', process.env.CARBON_USER_DATA);

// One carbon at a time: a second launch focuses the existing window.
if (!isE2E && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void app.whenReady().then(start);
}

async function start(): Promise<void> {
  const worldDir = resolveWorldDir(process.argv, app.getPath('userData'));
  const session = await WorldSession.open(worldDir);
  const ai = createAiGateway(() => session.world);

  const info = { version: app.getVersion(), worldDir, platform: process.platform, e2e: isE2E };
  registerIpc({ window: () => win, session, ai, info });
  const stopModules = await startModules({ session, ai, info, window: () => win, handle, send });

  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: '#141416', // --bg (docs/VISUAL.md §2)
    title: 'carbon',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
  });
  // Links open in the browser, never inside carbon.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) await win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else await win.loadFile(path.join(here, '../renderer/index.html'));

  let quitting = false;
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    void stopModules()
      .then(() => session.flush())
      .finally(() => app.quit());
  });
}

app.on('window-all-closed', () => app.quit());
