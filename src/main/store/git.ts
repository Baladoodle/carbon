import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { entityFromMarkdown } from '@core/files/entity-file';
import type { World } from '@core/model/world';
import { exists } from './meta';
import { parsePorcelain, snapshotMessage } from './snapshot-message';

/**
 * Git snapshots of the world directory (docs/SYSTEM.md §4): the system `git`,
 * run with `execFile` (no shell, arguments as an array, a timeout, no prompts),
 * committing everything under the world directory with a generated message.
 *
 * Robust by design: no git, a directory that isn't a repository (it is
 * initialised), a directory inside someone else's repository (left alone),
 * nothing to commit, no configured identity, signing or hooks that would
 * prompt or block, and a locked index all end in a result, never a throw.
 */
export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when git couldn't be started at all (e.g. ENOENT). */
  spawnError?: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<GitResult>;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const errorCode = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'EINVAL';
};

export function systemGit(
  bin = 'git',
  opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): GitRunner {
  return (args, cwd) =>
    new Promise((resolve) => {
      // execFile throws at once on an argument it can't pass (one with a NUL):
      // a result, like a git that can't start, never a rejection.
      const failed = (e: unknown): void =>
        resolve({
          code: -1,
          stdout: '',
          stderr: e instanceof Error ? e.message : String(e),
          spawnError: errorCode(e),
        });
      try {
        execFile(
          bin,
          args,
          {
            cwd,
            timeout: opts.timeoutMs ?? 20_000,
            maxBuffer: 32 * 1024 * 1024,
            windowsHide: true,
            env: {
              ...(opts.env ?? process.env),
              GIT_TERMINAL_PROMPT: '0',
              GIT_ASKPASS: '',
              SSH_ASKPASS: '',
              GIT_EDITOR: 'true',
              LC_ALL: 'C',
            },
          },
          (error, stdout, stderr) => {
            const e = error as (NodeJS.ErrnoException & { code?: unknown }) | null;
            if (e && typeof e.code === 'string')
              resolve({ code: -1, stdout: '', stderr: '', spawnError: e.code });
            else
              resolve({
                code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
                stdout,
                stderr,
              });
          },
        );
      } catch (e) {
        failed(e);
      }
    });
}

export type SnapshotReason = 'idle' | 'quit' | 'manual';

export type SnapshotResult =
  | { status: 'committed'; sha: string; message: string; files: number }
  | { status: 'clean' }
  | { status: 'unavailable'; reason: string }
  | { status: 'failed'; message: string };

/**
 * Everything under the world directory except the temporary files of saves in
 * flight (`.<name>.<pid>.<n>.tmp`, atomic.ts): a command can be saved while a
 * snapshot runs, and its temporary file must never land in the history.
 */
const PATHSPEC = ['.', ':(exclude,glob)**/.*.tmp'];

/** Options for `git commit` that never prompt, sign, or run hooks. */
const COMMIT_CONFIG = ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null'];

export class Snapshotter {
  private ready: Promise<{ ok: true } | { ok: false; reason: string }> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly dir: string,
    private readonly world: () => World | null,
    private readonly git: GitRunner = systemGit(),
    private readonly opts: { init?: boolean } = {},
  ) {}

  /** Checks git and the repository once; initialises the directory if it isn't in one. */
  prepare(): Promise<{ ok: true } | { ok: false; reason: string }> {
    // A check that threw (the folder gone, git failing to start) is a result,
    // not a verdict: the next call checks again.
    this.ready ??= this.check().catch((e: unknown) => {
      this.ready = null;
      return { ok: false as const, reason: `git check failed: ${errorText(e)}` };
    });
    return this.ready;
  }

  private async check(): Promise<{ ok: true } | { ok: false; reason: string }> {
    const v = await this.git(['--version'], this.dir);
    if (v.spawnError || v.code !== 0) return { ok: false, reason: 'git is not installed' };
    const top = await this.git(['rev-parse', '--show-toplevel'], this.dir);
    if (top.code !== 0) {
      // A `.git` that git can't read is a broken repository, not a missing one:
      // `git init` over it could point HEAD at a fresh branch. Leave it to the user.
      if (await exists(path.join(this.dir, '.git')))
        return {
          ok: false,
          reason: `the world's git repository is broken (${firstLine(top.stderr)})`,
        };
      if (this.opts.init === false)
        return { ok: false, reason: 'the world is not a git repository' };
      const init = await this.git(['init', '-q'], this.dir);
      if (init.code !== 0)
        return { ok: false, reason: `git init failed: ${firstLine(init.stderr)}` };
      return { ok: true };
    }
    const [a, b] = await Promise.all([
      realpath(top.stdout.trim()).catch(() => ''),
      realpath(this.dir),
    ]);
    if (a !== b)
      return { ok: false, reason: `the world is inside another repository (${top.stdout.trim()})` };
    return { ok: true };
  }

  /** Commits every change under the world directory. Serialised: one snapshot at a time. */
  snapshot(reason: SnapshotReason): Promise<SnapshotResult> {
    // Never rejects: callers fire and forget (an idle snapshot).
    const run = this.queue.then(() =>
      this.commit(reason).catch((e: unknown): SnapshotResult => ({
        status: 'failed',
        message: errorText(e),
      })),
    );
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async commit(reason: SnapshotReason): Promise<SnapshotResult> {
    const ready = await this.prepare();
    if (!ready.ok) return { status: 'unavailable', reason: ready.reason };
    const st = await this.git(
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...PATHSPEC],
      this.dir,
    );
    if (st.code !== 0) return { status: 'failed', message: firstLine(st.stderr) };
    const entries = parsePorcelain(st.stdout);
    if (entries.length === 0) return { status: 'clean' };
    const add = await this.git(['add', '-A', '--', ...PATHSPEC], this.dir);
    if (add.code !== 0) return { status: 'failed', message: firstLine(add.stderr) };
    const world = this.world();
    const names = new Map<string, string>();
    for (const e of entries) {
      const id = /^entities\/[a-z]+\/([^/]+)\.md$/.exec(e.path)?.[1];
      if (!id || world?.entities[id]) continue;
      const old = await this.git(['show', `HEAD:./${e.path}`], this.dir);
      const r = old.code === 0 ? entityFromMarkdown(old.stdout) : null;
      if (r?.ok) names.set(e.path, r.value.name);
    }
    // git can't take a NUL in an argument (a name can hold one).
    const message = snapshotMessage(entries, world, reason, names).replace(/\0/g, '');
    const identity = await this.identity();
    const commit = await this.git(
      [
        ...COMMIT_CONFIG,
        ...identity,
        'commit',
        '-q',
        '--no-verify',
        '-m',
        message,
        '--',
        ...PATHSPEC,
      ],
      this.dir,
    );
    if (commit.code !== 0) {
      const out = `${commit.stdout}\n${commit.stderr}`;
      if (/nothing (added )?to commit|no changes added/.test(out)) return { status: 'clean' };
      return { status: 'failed', message: firstLine(commit.stderr || commit.stdout) };
    }
    const head = await this.git(['rev-parse', 'HEAD'], this.dir);
    return { status: 'committed', sha: head.stdout.trim(), message, files: entries.length };
  }

  /** `-c user.name/email` when the repository has no identity configured (fresh machines). */
  private async identity(): Promise<string[]> {
    const email = await this.git(['config', 'user.email'], this.dir);
    const name = await this.git(['config', 'user.name'], this.dir);
    return [
      ...(name.code === 0 && name.stdout.trim() ? [] : ['-c', 'user.name=carbon']),
      ...(email.code === 0 && email.stdout.trim() ? [] : ['-c', 'user.email=carbon@localhost']),
    ];
  }
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? '';
