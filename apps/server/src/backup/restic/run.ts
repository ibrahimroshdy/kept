import { spawn as nodeSpawn } from 'node:child_process';
import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  BackupError as BackupErrorMessage,
  BackupSummary,
  CheckError,
  CheckSummary,
  documentOf,
  exitErrorOf,
  ForgetGroups,
  Initialized,
  LsNode,
  messagesOf,
  RepoConfig,
  ResticJsonError,
  Snapshots,
  Stats,
  splitLines,
} from './json.js';
import {
  type Restic,
  type ResticBackupOptions,
  type ResticBackupSummary,
  type ResticCheckOptions,
  type ResticCheckResult,
  ResticError,
  type ResticErrorReason,
  type ResticForgetOptions,
  type ResticForgetResult,
  type ResticNode,
  type ResticRepo,
  type ResticRestoreOptions,
  type ResticRestoreResult,
  type ResticSnapshot,
  type ResticStats,
  scrubSecrets,
} from './restic.js';

// The real restic (step-8 plan T5; D64): the pinned binary as a child process, never a library.
// What R1 recorded (docs/spikes/2026-10-06-step8-restic.md) and this follows:
// - `--json` on every command; messages parsed with json.ts's schemas;
// - the repository location, its password and its storage credentials go **only** in the
//   child's environment (RESTIC_REPOSITORY, RESTIC_PASSWORD, AWS_*), never argv: `ps` shows argv
//   to every user; the environment is the same uid's alone. The child gets a minimal environment
//   (no KEPT_* variable, no database URL): PATH, HOME, TMPDIR, the proxy variables, TZ=UTC and
//   the repository's own;
// - a fixed `--host kept` on backup and forget;
// - exit codes: 1 failed, 3 partial (a backup that couldn't read some files: the snapshot is
//   written), 10 no repository, 11 locked, 12 wrong password; a command past its timeout is
//   killed and reported `unreachable` (an unreachable S3 endpoint is retried forever, R1);
// - stderr is kept to a bounded buffer and scrubbed of every value of the repository's
//   environment before it reaches an error or a log;
// - TZ=UTC in the child: `backup --time` is written in UTC, and `forget` buckets days, weeks and
//   months in UTC whatever the host's zone (KEPT_BACKUP_TIME is UTC too).

export type ResticCliOptions = {
  /** KEPT_RESTIC_BIN, else `restic` on PATH (the image puts the pinned one there). */
  bin?: string;
  /** RESTIC_CACHE_DIR (plan Q5: `KEPT_DATA_DIR/.cache/restic`). Absent: restic's default. */
  cacheDir?: string;
  /** Milliseconds before a command is killed: `quick` for listing and checking a repository,
   * `long` for backup, restore, check and forget with prune. */
  timeouts?: { quick?: number; long?: number };
  /** The process environment the child's minimal one is picked from (tests). */
  baseEnv?: Readonly<Record<string, string | undefined>>;
  /** child_process.spawn, or a spy around it (the argv test). */
  spawn?: typeof nodeSpawn;
  /** Text lines restic printed that weren't JSON (warnings, retries), already scrubbed. */
  onLog?: (line: string, command: string) => void;
};

const QUICK_MS = 10 * 60_000;
const LONG_MS = 4 * 60 * 60_000;
const STDERR_MAX = 16 * 1024;
/** The child's environment beyond the repository's own, picked from the process's. */
const PASSED_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const;

type Outcome = { code: number | null; stdout: string; stderr: string; timedOut: boolean };

const REASONS: Record<number, ResticErrorReason> = {
  1: 'failed',
  3: 'partial',
  10: 'no_repository',
  11: 'locked',
  12: 'wrong_password',
};

/** `2026-01-01 12:00:00`, UTC (the child runs with TZ=UTC). */
function resticTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function under(p: string, prefix: string): boolean {
  const base = prefix.replace(/\/$/, '');
  return p === base || p.startsWith(`${base}/`);
}

/** A malformed message is a failed command (plan T5), never a crash. */
function parsed<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ResticJsonError) throw new ResticError('failed', err.message);
    throw err;
  }
}

function nodeType(type: string): ResticNode['type'] {
  return type === 'file' || type === 'dir' || type === 'symlink' ? type : 'other';
}

export class ResticCli implements Restic {
  private readonly bin: string;
  private readonly quickMs: number;
  private readonly longMs: number;
  private readonly spawnFn: typeof nodeSpawn;

  constructor(private readonly opts: ResticCliOptions = {}) {
    this.bin = opts.bin ?? 'restic';
    this.quickMs = opts.timeouts?.quick ?? QUICK_MS;
    this.longMs = opts.timeouts?.long ?? LONG_MS;
    this.spawnFn = opts.spawn ?? nodeSpawn;
  }

  async version(): Promise<string> {
    const out = await this.exec(null, 'version', ['version', '--json'], { ms: this.quickMs });
    const { messages, text } = splitLines(out.stdout);
    const fromJson = messages.find((m) => typeof m.version === 'string')?.version;
    const fromText = /restic (\d+\.\d+\.\d+)/.exec(text.join(' '))?.[1];
    const version = (typeof fromJson === 'string' ? fromJson : undefined) ?? fromText;
    if (!version) throw new ResticError('failed', 'restic version: no version in its output');
    return version;
  }

  async init(repo: ResticRepo): Promise<{ created: boolean }> {
    // `init` on an existing repository is exit 1 ("config file already exists"); `cat config`
    // tells them apart by exit code: 0 there, 10 not there, 12 the wrong password.
    try {
      const out = await this.run(repo, 'cat', ['cat', 'config'], this.quickMs);
      parsed(() => documentOf(out.stdout, RepoConfig, 'cat config'));
      return { created: false };
    } catch (err) {
      if (!(err instanceof ResticError) || err.reason !== 'no_repository') throw err;
    }
    const out = await this.run(repo, 'init', ['init'], this.quickMs);
    if (
      parsed(() => messagesOf(splitLines(out.stdout).messages, 'initialized', Initialized))
        .length === 0
    ) {
      throw new ResticError('failed', 'restic init: no confirmation in its output');
    }
    return { created: true };
  }

  async backup(repo: ResticRepo, o: ResticBackupOptions): Promise<ResticBackupSummary> {
    const args = ['backup', '--host', 'kept'];
    for (const tag of o.tags) args.push('--tag', tag);
    for (const ex of o.exclude ?? []) args.push('--exclude', ex);
    if (o.time) args.push('--time', resticTime(o.time));
    args.push('--', ...o.paths);
    const out = await this.exec(repo, 'backup', args, {
      ms: this.longMs,
      cwd: o.cwd,
      okCodes: [0, 3],
    });
    const { messages } = splitLines(out.stdout);
    const summary = parsed(() => messagesOf(messages, 'summary', BackupSummary)).at(-1);
    if (!summary) {
      throw new ResticError('failed', 'restic backup: no summary in its output', out.code);
    }
    const result: ResticBackupSummary = {
      snapshotId: summary.snapshot_id,
      filesNew: summary.files_new,
      filesChanged: summary.files_changed,
      filesUnmodified: summary.files_unmodified,
      bytesAdded: summary.data_added,
      filesTotal: summary.total_files_processed,
      bytesTotal: summary.total_bytes_processed,
    };
    if (out.code === 3) {
      const unreadable = parsed(() => messagesOf(messages, 'error', BackupErrorMessage)).length;
      throw new ResticError(
        'partial',
        `restic backup: ${unreadable} file(s) could not be read; the snapshot was written`,
        3,
        { summary: result, unreadable },
      );
    }
    return result;
  }

  async forget(repo: ResticRepo, o: ResticForgetOptions): Promise<ResticForgetResult> {
    const groupBy = o.groupBy ?? ['host', 'tags'];
    const args = ['forget', '--host', 'kept', '--group-by', groupBy.join(',')];
    if (o.tags.length > 0) args.push('--tag', o.tags.join(','));
    const keep = o.keep;
    if (keep.last) args.push('--keep-last', String(keep.last));
    if (keep.daily) args.push('--keep-daily', String(keep.daily));
    if (keep.weekly) args.push('--keep-weekly', String(keep.weekly));
    if (keep.monthly) args.push('--keep-monthly', String(keep.monthly));
    if (!keep.last && !keep.daily && !keep.weekly && !keep.monthly) {
      // A forget with no policy would remove nothing at best; Kept never means "remove all".
      throw new ResticError('failed', 'restic forget: no retention policy given');
    }
    if (o.prune) args.push('--prune');
    const out = await this.run(repo, 'forget', args, o.prune ? this.longMs : this.quickMs);
    const groups = parsed(() => documentOf(out.stdout || '[]', ForgetGroups, 'forget'));
    const kept: string[] = [];
    const removed: string[] = [];
    for (const g of groups) {
      for (const s of g.keep ?? []) kept.push(s.id);
      for (const s of g.remove ?? []) removed.push(s.id);
    }
    return { kept, removed };
  }

  async snapshots(repo: ResticRepo, o: { tags?: readonly string[] } = {}) {
    const args = ['snapshots'];
    if (o.tags && o.tags.length > 0) args.push('--tag', o.tags.join(','));
    const out = await this.run(repo, 'snapshots', args, this.quickMs);
    const list = parsed(() => documentOf(out.stdout, Snapshots, 'snapshots'));
    return list
      .map(
        (s): ResticSnapshot => ({
          id: s.id,
          time: new Date(s.time),
          host: s.hostname,
          paths: [...(s.paths ?? [])],
          tags: [...(s.tags ?? [])],
        }),
      )
      .sort((a, b) => b.time.getTime() - a.time.getTime());
  }

  async ls(repo: ResticRepo, snapshotId: string, o: { path?: string } = {}) {
    const args = ['ls', snapshotId];
    if (o.path) args.push('--recursive', '--', o.path);
    const out = await this.run(repo, 'ls', args, this.quickMs);
    const nodes = parsed(() => messagesOf(splitLines(out.stdout).messages, 'node', LsNode));
    return nodes
      .filter((n) => !o.path || under(n.path, o.path))
      .map((n): ResticNode => ({ path: n.path, type: nodeType(n.type), size: n.size }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async restore(
    repo: ResticRepo,
    snapshotId: string,
    o: ResticRestoreOptions,
  ): Promise<ResticRestoreResult> {
    const args = ['restore', snapshotId, '--target', o.target];
    for (const inc of o.include ?? []) args.push('--include', inc);
    await this.run(repo, 'restore', args, this.longMs);
    // restic's own count includes directories (R1); the target was empty, so what it now holds
    // is what was restored.
    let filesRestored = 0;
    let bytesRestored = 0;
    const walk = async (dir: string): Promise<void> => {
      for (const name of await readdir(dir)) {
        const p = path.join(dir, name);
        const st = await lstat(p);
        if (st.isDirectory()) await walk(p);
        else if (st.isFile()) {
          filesRestored++;
          bytesRestored += st.size;
        }
      }
    };
    await walk(o.target);
    return { filesRestored, bytesRestored };
  }

  async check(repo: ResticRepo, o: ResticCheckOptions = {}): Promise<ResticCheckResult> {
    const args = ['check'];
    if (o.readDataSubset) args.push(`--read-data-subset=${o.readDataSubset}`);
    const out = await this.exec(repo, 'check', args, { ms: this.longMs, okCodes: [0, 1] });
    const { messages } = splitLines(out.stdout);
    const errors = parsed(() => messagesOf(messages, 'error', CheckError)).map((e) =>
      scrubSecrets(e.message, repo),
    );
    const summary = parsed(() => messagesOf(messages, 'summary', CheckSummary)).at(-1);
    if (out.code === 1 && !summary) throw this.failure(repo, 'check', out);
    const ok = out.code === 0 && (summary?.num_errors ?? 0) === 0 && errors.length === 0;
    if (!ok && errors.length === 0) {
      errors.push(`restic check found ${summary?.num_errors ?? 'some'} error(s)`);
    }
    return { ok, errors };
  }

  async unlock(repo: ResticRepo): Promise<void> {
    await this.run(repo, 'unlock', ['unlock'], this.quickMs);
  }

  async stats(repo: ResticRepo): Promise<ResticStats> {
    // raw-data: what the repository stores (after deduplication and compression), not what a
    // restore of every snapshot would write.
    const out = await this.run(repo, 'stats', ['stats', '--mode', 'raw-data'], this.longMs);
    const s = parsed(() => documentOf(out.stdout, Stats, 'stats'));
    return {
      totalBytes: s.total_size,
      totalFiles: s.total_file_count,
      snapshots: s.snapshots_count,
    };
  }

  /** A command that must exit 0. */
  private async run(repo: ResticRepo, command: string, args: string[], ms: number) {
    return this.exec(repo, command, args, { ms });
  }

  private async exec(
    repo: ResticRepo | null,
    command: string,
    args: string[],
    o: { ms: number; cwd?: string | undefined; okCodes?: number[] },
  ): Promise<Outcome> {
    const argv = ['--json'];
    if (repo) {
      for (const [key, value] of Object.entries(repo.options ?? {})) {
        argv.push('-o', `${key}=${value}`);
      }
    }
    argv.push(...args);
    const env = this.childEnv(repo);
    let out: Outcome;
    try {
      out = await this.spawnOnce(argv, env, o.ms, o.cwd);
    } catch (err) {
      const why = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'is not installed' : 'failed';
      throw new ResticError(
        'failed',
        `restic ${command}: the binary ${why} (${this.bin}); Kept's image ships it`,
      );
    }
    this.logText(repo, command, out.stderr);
    if (out.timedOut) {
      throw new ResticError(
        'unreachable',
        `restic ${command}: no answer within ${Math.round(o.ms / 1000)} s; is the backup storage reachable?`,
        out.code,
      );
    }
    if (!(o.okCodes ?? [0]).includes(out.code ?? -1)) throw this.failure(repo, command, out);
    return out;
  }

  private failure(repo: ResticRepo | null, command: string, out: Outcome): ResticError {
    const scrub = (text: string) => (repo ? scrubSecrets(text, repo) : text);
    const exit = exitErrorOf(out.stderr);
    const detail = exit?.message ?? splitLines(out.stderr).text.slice(-3).join(' ');
    const reason = REASONS[out.code ?? -1] ?? 'failed';
    return new ResticError(
      reason,
      `restic ${command} failed (exit ${out.code}): ${scrub(detail).slice(0, 600)}`,
      out.code,
    );
  }

  private logText(repo: ResticRepo | null, command: string, stderr: string) {
    if (!this.opts.onLog) return;
    for (const line of splitLines(stderr).text) {
      this.opts.onLog(repo ? scrubSecrets(line, repo) : line, command);
    }
  }

  private childEnv(repo: ResticRepo | null): Record<string, string> {
    const base = this.opts.baseEnv ?? process.env;
    const env: Record<string, string> = {};
    for (const name of PASSED_ENV) {
      const value = base[name];
      if (value) env[name] = value;
    }
    env.HOME ??= '/tmp';
    env.TZ = 'UTC';
    if (this.opts.cacheDir) env.RESTIC_CACHE_DIR = this.opts.cacheDir;
    if (repo) {
      Object.assign(env, repo.env);
      env.RESTIC_REPOSITORY = repo.location;
    }
    return env;
  }

  private spawnOnce(
    argv: string[],
    env: Record<string, string>,
    ms: number,
    cwd: string | undefined,
  ): Promise<Outcome> {
    return new Promise((resolve, reject) => {
      const child = this.spawnFn(this.bin, argv, {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      let stderr = '';
      let timedOut = false;
      child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < STDERR_MAX) stderr += chunk.slice(0, STDERR_MAX - stderr.length);
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
      }, ms);
      timer.unref();
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(stdout).toString('utf8'), stderr, timedOut });
      });
    });
  }
}
