import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sampleWorld } from '@core/testing/sample';
import { resetDiskState } from './disk-state';
import { Snapshotter, systemGit, type GitRunner } from './git';
import { parsePorcelain, snapshotMessage } from './snapshot-message';
import { writeChanges, writeWorldDir } from './world-dir';

let tmp: string;
let home: string;
let dir: string;
/** git with an empty HOME: no global identity, signing or hooks leak in from the machine. */
let git: GitRunner;
const env = (): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  XDG_CONFIG_HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
});
const sh = (args: string[], cwd = dir): string =>
  execFileSync('git', args, { cwd, env: env(), encoding: 'utf8' });

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'carbon-git-'));
  home = path.join(tmp, 'home');
  dir = path.join(tmp, 'world');
  await mkdir(home);
  git = systemGit('git', { env: env() });
});
afterEach(async () => {
  resetDiskState(dir);
  await rm(tmp, { recursive: true, force: true });
});

describe('Snapshotter never rejects', () => {
  // Its callers fire and forget (an idle snapshot, the startup check): a
  // rejection would be unhandled in main. Every failure is a result.
  it('commits an entity whose name holds a NUL (git refuses NUL in a message)', async () => {
    const w = sampleWorld();
    const glide = w.entities.glide!;
    w.entities.glide = { ...glide, name: 'Gl\u0000ide' };
    await writeWorldDir(dir, sampleWorld());
    const s = new Snapshotter(dir, () => w, git);
    expect((await s.snapshot('idle')).status).toBe('committed');
    await writeWorldDir(dir, w);
    const r = await s.snapshot('idle');
    expect(r.status).toBe('committed');
    expect(sh(['log', '-1', '--format=%B'])).toContain('Glide');
  });

  it('a git runner that throws gives a failed or unavailable result', async () => {
    await writeWorldDir(dir, sampleWorld());
    const throwing: GitRunner = () => Promise.reject(new Error('spawn exploded'));
    const s = new Snapshotter(dir, () => sampleWorld(), throwing);
    await expect(s.prepare()).resolves.toMatchObject({ ok: false });
    await expect(s.snapshot('idle')).resolves.toMatchObject({ status: 'unavailable' });
  });

  it('a world folder that is gone gives a result, and a later call checks again', async () => {
    await writeWorldDir(dir, sampleWorld());
    // git says yes to everything, but the folder has gone (moved, deleted).
    const fake: GitRunner = (args) =>
      Promise.resolve({ code: 0, stdout: args[0] === 'rev-parse' ? dir : '', stderr: '' });
    const s = new Snapshotter(path.join(tmp, 'moved-away'), () => sampleWorld(), fake);
    await expect(s.prepare()).resolves.toMatchObject({ ok: false });
    // Not cached as a verdict: the folder may come back.
    const again = new Snapshotter(dir, () => sampleWorld(), fake);
    await expect(again.prepare()).resolves.toEqual({ ok: true });
  });
});

describe('Snapshotter', () => {
  it('initialises a plain directory and commits the whole world with a generated message', async () => {
    await writeWorldDir(dir, sampleWorld());
    const s = new Snapshotter(dir, () => sampleWorld(), git);
    const r = await s.snapshot('idle');
    expect(r.status).toBe('committed');
    if (r.status !== 'committed') return;
    expect(r.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sh(['log', '--format=%an <%ae>']).trim()).toBe('carbon <carbon@localhost>');
    expect(sh(['log', '-1', '--format=%B'])).toContain('carbon snapshot (idle)');
    expect(sh(['status', '--porcelain'])).toBe('');
  });

  it('does nothing when there is nothing to commit', async () => {
    await writeWorldDir(dir, sampleWorld());
    const s = new Snapshotter(dir, () => sampleWorld(), git);
    expect((await s.snapshot('idle')).status).toBe('committed');
    expect(await s.snapshot('quit')).toEqual({ status: 'clean' });
    expect(sh(['rev-list', '--count', 'HEAD']).trim()).toBe('1');
  });

  it('names the entities that changed in the subject', async () => {
    const w = sampleWorld();
    await writeWorldDir(dir, w);
    const s = new Snapshotter(dir, () => w, git);
    await s.snapshot('idle');
    const glide = w.entities.glide;
    if (!glide) throw new Error('sample changed');
    w.entities.glide = { ...glide, identity: 'Fall with style.' };
    delete w.entities['first-descent'];
    await writeChanges(dir, {
      write: new Map([['entities/capability/glide.md', 'changed\n']]),
      remove: ['entities/feat/first-descent.md'],
    });
    const r = await s.snapshot('quit');
    expect(r.status).toBe('committed');
    const subject = sh(['log', '-1', '--format=%s']).trim();
    // The removed entity's name comes from the last commit.
    expect(subject).toBe('Edit Glide; remove First Descent');
  });

  it('keeps out of a repository the world merely sits inside', async () => {
    await mkdir(dir, { recursive: true });
    sh(['init', '-q'], tmp);
    await writeWorldDir(dir, sampleWorld());
    const r = await new Snapshotter(dir, () => null, git).snapshot('idle');
    expect(r).toEqual({
      status: 'unavailable',
      reason: expect.stringContaining('inside another repository') as string,
    });
    expect(() => sh(['rev-parse', 'HEAD'], tmp)).toThrow();
  });

  it('reports a missing git instead of throwing', async () => {
    await writeWorldDir(dir, sampleWorld());
    const r = await new Snapshotter(dir, () => null, systemGit('/nonexistent/git')).snapshot(
      'quit',
    );
    expect(r).toEqual({ status: 'unavailable', reason: 'git is not installed' });
  });

  it('can be told not to initialise', async () => {
    await writeWorldDir(dir, sampleWorld());
    const r = await new Snapshotter(dir, () => null, git, { init: false }).snapshot('idle');
    expect(r).toEqual({ status: 'unavailable', reason: 'the world is not a git repository' });
  });

  it('uses the configured identity, and ignores hooks and signing', async () => {
    await writeWorldDir(dir, sampleWorld());
    sh(['init', '-q']);
    sh(['config', 'user.name', 'Ada']);
    sh(['config', 'user.email', 'ada@example.com']);
    sh(['config', 'commit.gpgsign', 'true']);
    await mkdir(path.join(dir, '.git/hooks'), { recursive: true });
    await writeFile(path.join(dir, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', {
      mode: 0o755,
    });
    const r = await new Snapshotter(dir, () => null, git).snapshot('manual');
    expect(r.status).toBe('committed');
    expect(sh(['log', '--format=%an']).trim()).toBe('Ada');
  });

  it('fails softly when the index is locked, and works again once it is free', async () => {
    await writeWorldDir(dir, sampleWorld());
    const s = new Snapshotter(dir, () => null, git);
    await s.snapshot('idle');
    await writeFile(path.join(dir, 'numbers/formulas.carbon'), 'x = 1\n');
    await writeFile(path.join(dir, '.git/index.lock'), '');
    const r = await s.snapshot('idle');
    expect(r.status).toBe('failed');
    await rm(path.join(dir, '.git/index.lock'));
    expect((await s.snapshot('idle')).status).toBe('committed');
  });

  it('never commits a temporary file of a save in flight', async () => {
    await writeWorldDir(dir, sampleWorld());
    const s = new Snapshotter(dir, () => sampleWorld(), git);
    expect((await s.snapshot('idle')).status).toBe('committed');
    // An atomic write that is mid-way when the snapshot runs.
    await writeFile(path.join(dir, 'entities/item/.glass-lung.md.4242.7.tmp'), 'half');
    await writeFile(path.join(dir, 'numbers/formulas.carbon'), 'k = 1\n');
    const r = await s.snapshot('idle');
    expect(r.status).toBe('committed');
    expect(sh(['ls-files'])).not.toMatch(/\.tmp/);
  });

  it('reports a broken repository instead of initialising over it', async () => {
    await writeWorldDir(dir, sampleWorld());
    const s = new Snapshotter(dir, () => sampleWorld(), git);
    expect((await s.snapshot('idle')).status).toBe('committed');
    await rm(path.join(dir, '.git/HEAD'));
    const r = await new Snapshotter(dir, () => sampleWorld(), git).snapshot('idle');
    expect(r).toEqual({ status: 'unavailable', reason: expect.stringMatching(/broken/) as string });
    // Nothing was re-created: the repository is as the user left it.
    await expect(readFile(path.join(dir, '.git/HEAD'), 'utf8')).rejects.toThrow();
  });

  it('serialises concurrent snapshots', async () => {
    await writeWorldDir(dir, sampleWorld());
    const s = new Snapshotter(dir, () => null, git);
    const rs = await Promise.all([s.snapshot('idle'), s.snapshot('idle'), s.snapshot('quit')]);
    expect(rs.map((r) => r.status)).toEqual(['committed', 'clean', 'clean']);
  });

  it('passes arguments without a shell (a path with spaces and quotes is fine)', async () => {
    dir = path.join(tmp, `my "world" $(echo pwned)`);
    await writeWorldDir(dir, sampleWorld());
    const r = await new Snapshotter(dir, () => null, git).snapshot('idle');
    expect(r.status).toBe('committed');
  });
});

describe('snapshot messages', () => {
  it('parses porcelain -z, including renames', () => {
    expect(parsePorcelain(' M a.md\0?? b c.md\0R  new.md\0old.md\0D  gone.md\0')).toEqual([
      { xy: ' M', path: 'a.md' },
      { xy: '??', path: 'b c.md' },
      { xy: 'R ', path: 'new.md', from: 'old.md' },
      { xy: 'D ', path: 'gone.md' },
    ]);
    expect(parsePorcelain('')).toEqual([]);
  });

  it('summarises entities by name and other files by area', () => {
    const w = sampleWorld();
    const msg = snapshotMessage(
      [
        { xy: '??', path: 'entities/item/new-thing.md' },
        { xy: ' M', path: 'entities/band/low-sky.md' },
        { xy: ' M', path: 'numbers/formulas.carbon' },
        { xy: ' M', path: 'taste/rules.json' },
      ],
      w,
      'idle',
    );
    const [subject, , ...rest] = msg.split('\n');
    expect(subject).toBe('Add new-thing; edit Low Sky and numbers, taste');
    expect(rest.join('\n')).toContain('edited   band Low Sky');
    expect(msg.endsWith('carbon snapshot (idle)\n')).toBe(true);
  });

  it('keeps the subject short when many entities change', () => {
    const w = sampleWorld();
    const entries = Object.values(w.entities).map((e) => ({
      xy: ' M',
      path: `entities/${e.kind}/${e.id}.md`,
    }));
    const subject = snapshotMessage(entries, w, 'quit').split('\n')[0] ?? '';
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject).toMatch(/^Edit .+ and \d+ more$/);
  });

  it('only settings: an "update" subject', () => {
    expect(
      snapshotMessage([{ xy: ' M', path: 'carbon.json' }], null, 'manual').split('\n')[0],
    ).toBe('Update carbon');
  });
});
