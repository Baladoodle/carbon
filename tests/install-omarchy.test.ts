import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * scripts/install-omarchy.sh in a throwaway home: a fake AppImage (a shell
 * script that records its arguments) and, for the focus test, a fake hyprctl.
 */
const SCRIPT = path.resolve(import.meta.dirname, '../scripts/install-omarchy.sh');
let tmp: string;
let env: NodeJS.ProcessEnv;
let fakeApp: string;

const p = (...xs: string[]): string => path.join(tmp, ...xs);
const run = (...args: string[]): { status: number | null; out: string } => {
  const r = spawnSync('bash', [SCRIPT, ...args], { env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'carbon-install-'));
  mkdirSync(p('home'));
  mkdirSync(p('fakebin'));
  env = {
    PATH: `${p('fakebin')}:/usr/bin:/bin`,
    HOME: p('home'),
    XDG_DATA_HOME: p('home/.local/share'),
    XDG_CONFIG_HOME: p('home/.config'),
    CARBON_BIN_DIR: p('home/.local/bin'),
  };
  fakeApp = p('carbon-0.1.0.AppImage');
  writeFileSync(fakeApp, `#!/bin/sh\necho "started $*" > "${p('started')}"\n`);
  chmodSync(fakeApp, 0o755);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const launcher = (): string => p('home/.local/bin/carbon');

describe('install-omarchy.sh', () => {
  it('passes bash -n', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
  });

  it('installs the app, the launcher, the desktop entry and the window rule', () => {
    const r = run('--appimage', fakeApp);
    expect(r.status, r.out).toBe(0);
    expect(statSync(p('home/.local/share/carbon/carbon.AppImage')).mode & 0o111).toBeTruthy();
    expect(statSync(launcher()).mode & 0o111).toBeTruthy();
    const desktop = readFileSync(p('home/.local/share/applications/carbon.desktop'), 'utf8');
    expect(desktop).toContain(`Exec=${launcher()} %U`);
    expect(desktop).toContain('StartupWMClass=carbon');
    expect(readFileSync(p('home/.config/hypr/carbon.conf'), 'utf8')).toContain('class:^(carbon)$');
    // Without --hypr, hyprland.conf isn't touched.
    expect(existsSync(p('home/.config/hypr/hyprland.conf'))).toBe(false);
    expect(r.out).toContain('is not on your PATH');
  });

  const fakeHyprVersion = (tag: string): void => {
    writeFileSync(
      p('fakebin/hyprctl'),
      `#!/bin/sh\nif [ "$1" = version ]; then echo '{"branch": "", "tag": "${tag}", "version": "x"}'; fi\n`,
    );
    chmodSync(p('fakebin/hyprctl'), 0o755);
  };
  const rule = (): string[] =>
    readFileSync(p('home/.config/hypr/carbon.conf'), 'utf8')
      .split('\n')
      .filter((l) => /^windowrule/.test(l));

  it('writes the window rule in the syntax of the Hyprland it finds', () => {
    fakeHyprVersion('v0.53.1');
    expect(run('--appimage', fakeApp).status).toBe(0);
    expect(rule()).toEqual([
      'windowrule = match:class ^(carbon)$, workspace name:carbon',
      'windowrule = match:class ^(carbon)$, tile on',
    ]);
    fakeHyprVersion('v0.50.0');
    expect(run('--appimage', fakeApp).status).toBe(0);
    expect(rule()).toEqual([
      'windowrule = workspace name:carbon, class:^(carbon)$',
      'windowrule = tile, class:^(carbon)$',
    ]);
    fakeHyprVersion('v0.45.2');
    expect(run('--appimage', fakeApp).status).toBe(0);
    expect(rule()).toEqual([
      'windowrulev2 = workspace name:carbon, class:^(carbon)$',
      'windowrulev2 = tile, class:^(carbon)$',
    ]);
  });

  it('without hyprctl, writes the current syntax and keeps the older forms as comments', () => {
    expect(run('--appimage', fakeApp).status).toBe(0);
    expect(rule()).toEqual([
      'windowrule = match:class ^(carbon)$, workspace name:carbon',
      'windowrule = match:class ^(carbon)$, tile on',
    ]);
    const text = readFileSync(p('home/.config/hypr/carbon.conf'), 'utf8');
    expect(text).toContain('# windowrule = workspace name:carbon, class:^(carbon)$');
  });

  it('installs the icon and names it in the desktop entry', () => {
    expect(run('--appimage', fakeApp).status).toBe(0);
    expect(existsSync(p('home/.local/share/icons/hicolor/scalable/apps/carbon.svg'))).toBe(true);
    const desktop = readFileSync(p('home/.local/share/applications/carbon.desktop'), 'utf8');
    expect(desktop).toMatch(/^Icon=carbon$/m);
    expect(run('--uninstall').status).toBe(0);
    expect(existsSync(p('home/.local/share/icons/hicolor/scalable/apps/carbon.svg'))).toBe(false);
  });

  it('the launcher starts carbon when it isn’t running (no hyprctl)', () => {
    run('--appimage', fakeApp);
    execFileSync(launcher(), ['--world', '/x'], { env });
    expect(readFileSync(p('started'), 'utf8').trim()).toBe('started --world /x');
  });

  it('the launcher focuses a running carbon through hyprctl', () => {
    run('--appimage', fakeApp);
    writeFileSync(
      p('fakebin/hyprctl'),
      `#!/bin/sh\nif [ "$1" = clients ]; then echo '[{"class": "carbon"}]'; else echo "$*" > "${p('hyprctl-called')}"; fi\n`,
    );
    chmodSync(p('fakebin/hyprctl'), 0o755);
    execFileSync(launcher(), [], { env });
    expect(readFileSync(p('hyprctl-called'), 'utf8').trim()).toBe(
      'dispatch focuswindow class:^(carbon)$',
    );
    expect(existsSync(p('started'))).toBe(false);
  });

  it('is idempotent, including the hyprland.conf source line', () => {
    mkdirSync(p('home/.config/hypr'), { recursive: true });
    writeFileSync(p('home/.config/hypr/hyprland.conf'), 'monitor = ,preferred,auto,1\n');
    run('--appimage', fakeApp, '--hypr');
    const snapshot = (): string[] =>
      [
        launcher(),
        p('home/.local/share/applications/carbon.desktop'),
        p('home/.config/hypr/carbon.conf'),
        p('home/.config/hypr/hyprland.conf'),
      ].map((f) => readFileSync(f, 'utf8'));
    const first = snapshot();
    const again = run('--appimage', fakeApp, '--hypr');
    expect(again.status).toBe(0);
    expect(snapshot()).toEqual(first);
    expect(first[3]?.match(/carbon\.conf/g)).toHaveLength(1);
  });

  it('installs an unpacked build too', () => {
    mkdirSync(p('unpacked'));
    writeFileSync(p('unpacked/carbon'), '#!/bin/sh\necho unpacked > "' + p('started') + '"\n');
    chmodSync(p('unpacked/carbon'), 0o755);
    expect(run('--dir', p('unpacked')).status).toBe(0);
    execFileSync(launcher(), [], { env });
    expect(readFileSync(p('started'), 'utf8').trim()).toBe('unpacked');
  });

  it('by default prefers the unpacked build, which needs no FUSE, over the AppImage', () => {
    mkdirSync(p('dist/linux-unpacked'), { recursive: true });
    writeFileSync(
      p('dist/linux-unpacked/carbon'),
      '#!/bin/sh\necho unpacked > "' + p('started') + '"\n',
    );
    chmodSync(p('dist/linux-unpacked/carbon'), 0o755);
    writeFileSync(p('dist/carbon-0.1.0-x86_64.AppImage'), readFileSync(fakeApp));
    env.CARBON_DIST = p('dist');
    const r = run();
    expect(r.status).toBe(0);
    expect(existsSync(p('home/.local/share/carbon/app/carbon'))).toBe(true);
    expect(existsSync(p('home/.local/share/carbon/carbon.AppImage'))).toBe(false);
    execFileSync(launcher(), [], { env });
    expect(readFileSync(p('started'), 'utf8').trim()).toBe('unpacked');
  });

  it('warns when the AppImage needs libfuse.so.2 and the system has none', () => {
    writeFileSync(p('fakebin/ldconfig'), '#!/bin/sh\necho "12 libs found in cache"\n');
    chmodSync(p('fakebin/ldconfig'), 0o755);
    const r = run('--appimage', fakeApp);
    expect(r.status).toBe(0);
    expect(r.out).toContain('needs libfuse.so.2');
    expect(r.out).toContain('pacman -S fuse2');
    // With it present, no warning.
    writeFileSync(
      p('fakebin/ldconfig'),
      '#!/bin/sh\necho "\tlibfuse.so.2 (libc6,x86-64) => /usr/lib/libfuse.so.2"\n',
    );
    expect(run('--appimage', fakeApp).out).not.toContain('libfuse.so.2');
  });

  it('uninstalls everything it installed, and only that', () => {
    mkdirSync(p('home/.config/hypr'), { recursive: true });
    writeFileSync(p('home/.config/hypr/hyprland.conf'), 'monitor = ,preferred,auto,1\n');
    run('--appimage', fakeApp, '--hypr');
    const r = run('--uninstall');
    expect(r.status, r.out).toBe(0);
    expect(existsSync(launcher())).toBe(false);
    expect(existsSync(p('home/.local/share/applications/carbon.desktop'))).toBe(false);
    expect(existsSync(p('home/.local/share/carbon'))).toBe(false);
    expect(existsSync(p('home/.config/hypr/carbon.conf'))).toBe(false);
    expect(readFileSync(p('home/.config/hypr/hyprland.conf'), 'utf8').trim()).toBe(
      'monitor = ,preferred,auto,1',
    );
    // A launcher someone else wrote is left alone.
    mkdirSync(p('home/.local/bin'), { recursive: true });
    writeFileSync(launcher(), '#!/bin/sh\necho mine\n');
    run('--uninstall');
    expect(existsSync(launcher())).toBe(true);
  });

  it('dry run changes nothing; bad input fails clearly', () => {
    expect(run('--appimage', fakeApp, '--dry-run').status).toBe(0);
    expect(existsSync(launcher())).toBe(false);
    expect(run('--appimage', p('nope.AppImage')).out).toContain('no such AppImage');
    expect(run('--bogus').status).not.toBe(0);
  });
});
