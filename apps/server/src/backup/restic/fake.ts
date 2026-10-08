import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type Restic,
  type ResticBackupOptions,
  type ResticBackupSummary,
  type ResticCheckResult,
  ResticError,
  type ResticErrorReason,
  type ResticForgetOptions,
  type ResticForgetResult,
  type ResticKeepPolicy,
  type ResticNode,
  type ResticRepo,
  type ResticRestoreOptions,
  type ResticRestoreResult,
  type ResticSnapshot,
  type ResticStats,
  scrubSecrets,
} from './restic.js';

// An in-memory restic (step-8 plan T2) for T5–T8's tests before, and beside, the real binary. It
// reads and writes real directories (backup reads the given paths, restore writes the target), and
// keeps the repository in memory: snapshots of paths → contents, content deduplicated by SHA-256.
// It passes test/restic-contract.ts, which T5's run.ts must pass too.
//
// The password is read from `RESTIC_PASSWORD` in the repository's env (T0a R1 used that name:
// docs/spikes/2026-10-06-step8-restic.md). Retention follows restic's "newest snapshot in each of
// the last N days / ISO weeks / months", bucketed in local time, and keeps the oldest snapshot
// while a policy's buckets aren't all filled (R1 saw restic keep its "oldest monthly snapshot").
// Snapshots are grouped by host and tags unless `groupBy` says otherwise: R1's proposal for
// every forget Kept runs. Relative paths with `cwd` are stored under `/` (R1: a backup of
// `backup` run from KEPT_DATA_DIR restores with `--include /backup/readable`).
//
// Test hooks: failNext() makes the next command fail with a reason and stderr (which the fake
// scrubs as the real wrapper must), lock()/unlock() a repository, and `calls` records every
// command with the env names it got (never their values), so a test can prove nothing secret was
// passed anywhere but the environment. Its errors carry no exit code: those are R1's to record
// and run.ts's to map.

type Entry = { type: 'file'; sha: string; size: number } | { type: 'dir' };

type Snap = ResticSnapshot & { tree: Map<string, Entry> };

type Repo = { password: string; snaps: Snap[]; blobs: Map<string, Buffer>; locked: boolean };

export type FakeResticCall = { command: string; location: string; envNames: string[] };

export class FakeRestic implements Restic {
  readonly calls: FakeResticCall[] = [];
  private readonly repos = new Map<string, Repo>();
  private failure: { reason: ResticErrorReason; stderr: string } | null = null;

  constructor(private readonly binaryVersion = '0.0.0-fake') {}

  /** The next command fails with `reason`; `stderr` goes through the scrubber into the message. */
  failNext(reason: ResticErrorReason, stderr = 'fake failure'): void {
    this.failure = { reason, stderr };
  }

  /** Holds the repository's lock, as another restic process would. */
  lock(location: string): void {
    const repo = this.repos.get(location);
    if (repo) repo.locked = true;
  }

  /** Every snapshot the repository holds, for assertions. */
  snapshotCount(location: string): number {
    return this.repos.get(location)?.snaps.length ?? 0;
  }

  async version(): Promise<string> {
    return this.binaryVersion;
  }

  async init(repo: ResticRepo): Promise<{ created: boolean }> {
    this.enter('init', repo);
    if (this.repos.has(repo.location)) return { created: false };
    const password = repo.env.RESTIC_PASSWORD;
    if (!password) throw new ResticError('failed', 'init: no password given');
    this.repos.set(repo.location, { password, snaps: [], blobs: new Map(), locked: false });
    return { created: true };
  }

  async backup(repo: ResticRepo, opts: ResticBackupOptions): Promise<ResticBackupSummary> {
    const r = this.open('backup', repo, true);
    const tree = new Map<string, Entry>();
    const excluded = (p: string) =>
      (opts.exclude ?? []).some((e) => p === e || p.startsWith(`${e.replace(/\/$/, '')}/`));
    const cwd = opts.cwd;
    /** Where a file on disk sits in the snapshot: its absolute path, or `/<relative>` with cwd. */
    const inSnapshot = (abs: string) =>
      cwd ? `/${path.relative(cwd, abs).split(path.sep).join('/')}` : abs;
    const walk = async (abs: string): Promise<void> => {
      if (excluded(abs) || excluded(inSnapshot(abs))) return;
      const stat = await lstat(abs).catch(() => null);
      if (!stat) throw new ResticError('failed', `backup: ${abs} does not exist`);
      if (stat.isDirectory()) {
        tree.set(inSnapshot(abs), { type: 'dir' });
        for (const name of (await readdir(abs)).sort()) await walk(path.join(abs, name));
      } else if (stat.isFile()) {
        const bytes = await readFile(abs);
        const sha = createHash('sha256').update(bytes).digest('hex');
        tree.set(inSnapshot(abs), { type: 'file', sha, size: bytes.length });
        if (!r.blobs.has(sha)) r.blobs.set(sha, bytes);
      }
    };
    const shasBefore = new Set(r.blobs.keys());
    const resolve = (p: string) => {
      if (path.isAbsolute(p)) return path.resolve(p);
      if (!cwd) throw new ResticError('failed', `backup: ${p} is relative and no cwd was given`);
      return path.resolve(cwd, p);
    };
    for (const p of opts.paths) await walk(resolve(p));
    const paths = opts.paths.map((p) => inSnapshot(resolve(p))).sort();
    const parent = r.snaps.find((s) => sameList(s.paths, paths));
    let filesNew = 0;
    let filesChanged = 0;
    let filesUnmodified = 0;
    let bytesAdded = 0;
    let filesTotal = 0;
    let bytesTotal = 0;
    const counted = new Set<string>();
    for (const [p, entry] of tree) {
      if (entry.type !== 'file') continue;
      filesTotal++;
      bytesTotal += entry.size;
      const before = parent?.tree.get(p);
      if (!before) filesNew++;
      else if (before.type === 'file' && before.sha === entry.sha) filesUnmodified++;
      else filesChanged++;
      if (!shasBefore.has(entry.sha) && !counted.has(entry.sha)) {
        counted.add(entry.sha);
        bytesAdded += entry.size;
      }
    }
    const snap: Snap = {
      id: randomBytes(32).toString('hex'),
      time: opts.time ?? new Date(),
      host: 'kept',
      paths,
      tags: [...opts.tags],
      tree,
    };
    // Newest first. Two backups in the same millisecond keep the later one first (the sort is
    // stable), as restic's own order by time does for them in practice.
    r.snaps.unshift(snap);
    r.snaps.sort((a, b) => b.time.getTime() - a.time.getTime());
    return {
      snapshotId: snap.id,
      filesNew,
      filesChanged,
      filesUnmodified,
      bytesAdded,
      filesTotal,
      bytesTotal,
    };
  }

  async forget(repo: ResticRepo, opts: ResticForgetOptions): Promise<ResticForgetResult> {
    const r = this.open('forget', repo, true);
    const considered = r.snaps.filter((s) => opts.tags.every((t) => s.tags.includes(t)));
    const groupBy = opts.groupBy ?? ['host', 'tags'];
    const groups = new Map<string, Snap[]>();
    for (const snap of considered) {
      const key = JSON.stringify(
        groupBy.map((g) => (g === 'host' ? snap.host : g === 'paths' ? snap.paths : snap.tags)),
      );
      groups.set(key, [...(groups.get(key) ?? []), snap]);
    }
    const kept = new Set<string>();
    for (const group of groups.values()) {
      for (const id of keepByPolicy(group, opts.keep)) kept.add(id);
    }
    const removed = considered.filter((s) => !kept.has(s.id)).map((s) => s.id);
    r.snaps = r.snaps.filter((s) => !removed.includes(s.id));
    if (opts.prune) {
      const live = new Set<string>();
      for (const s of r.snaps)
        for (const e of s.tree.values()) if (e.type === 'file') live.add(e.sha);
      for (const sha of [...r.blobs.keys()]) if (!live.has(sha)) r.blobs.delete(sha);
    }
    return { kept: considered.filter((s) => kept.has(s.id)).map((s) => s.id), removed };
  }

  async snapshots(
    repo: ResticRepo,
    opts: { tags?: readonly string[] } = {},
  ): Promise<ResticSnapshot[]> {
    const r = this.open('snapshots', repo, false);
    return r.snaps
      .filter((s) => (opts.tags ?? []).every((t) => s.tags.includes(t)))
      .map(({ tree: _tree, ...s }) => ({ ...s, paths: [...s.paths], tags: [...s.tags] }));
  }

  async ls(repo: ResticRepo, snapshotId: string, opts: { path?: string } = {}) {
    const snap = this.find(this.open('ls', repo, false), snapshotId);
    const nodes: ResticNode[] = [];
    for (const [p, e] of snap.tree) {
      if (opts.path && !under(p, opts.path)) continue;
      nodes.push({ path: p, type: e.type, size: e.type === 'file' ? e.size : 0 });
    }
    return nodes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async restore(
    repo: ResticRepo,
    snapshotId: string,
    opts: ResticRestoreOptions,
  ): Promise<ResticRestoreResult> {
    const r = this.open('restore', repo, false);
    const snap = this.find(r, snapshotId);
    let filesRestored = 0;
    let bytesRestored = 0;
    for (const [p, e] of [...snap.tree].sort(([a], [b]) => a.localeCompare(b))) {
      if (opts.include && !opts.include.some((inc) => under(p, inc))) continue;
      const dest = path.join(opts.target, p);
      if (e.type === 'dir') {
        await mkdir(dest, { recursive: true });
        continue;
      }
      const bytes = r.blobs.get(e.sha);
      if (!bytes) throw new ResticError('failed', `restore: a blob of ${p} is missing`);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, bytes);
      filesRestored++;
      bytesRestored += bytes.length;
    }
    return { filesRestored, bytesRestored };
  }

  async check(repo: ResticRepo): Promise<ResticCheckResult> {
    const r = this.open('check', repo, true);
    const errors: string[] = [];
    for (const s of r.snaps) {
      for (const [p, e] of s.tree) {
        if (e.type === 'file' && !r.blobs.has(e.sha)) errors.push(`snapshot ${s.id}: ${p}`);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  async unlock(repo: ResticRepo): Promise<void> {
    const r = this.open('unlock', repo, false);
    r.locked = false;
  }

  async stats(repo: ResticRepo): Promise<ResticStats> {
    const r = this.open('stats', repo, false);
    let totalBytes = 0;
    for (const bytes of r.blobs.values()) totalBytes += bytes.length;
    return { totalBytes, totalFiles: r.blobs.size, snapshots: r.snaps.length };
  }

  private enter(command: string, repo: ResticRepo): void {
    this.calls.push({ command, location: repo.location, envNames: Object.keys(repo.env).sort() });
    const failure = this.failure;
    if (failure) {
      this.failure = null;
      throw new ResticError(
        failure.reason,
        `restic ${command}: ${scrubSecrets(failure.stderr, repo)}`,
      );
    }
  }

  private open(command: string, repo: ResticRepo, exclusive: boolean): Repo {
    this.enter(command, repo);
    const r = this.repos.get(repo.location);
    if (!r) throw new ResticError('no_repository', `restic ${command}: no repository there`);
    if (repo.env.RESTIC_PASSWORD !== r.password) {
      throw new ResticError('wrong_password', `restic ${command}: wrong password`);
    }
    if (exclusive && r.locked) {
      throw new ResticError('locked', `restic ${command}: the repository is locked`);
    }
    return r;
  }

  private find(r: Repo, snapshotId: string): Snap {
    const snap = r.snaps.find((s) => s.id === snapshotId || s.id.startsWith(snapshotId));
    if (!snap || snapshotId.length < 8) {
      throw new ResticError('failed', `no snapshot ${snapshotId}`);
    }
    return snap;
  }
}

function under(p: string, prefix: string): boolean {
  const base = prefix.replace(/\/$/, '');
  return p === base || p.startsWith(`${base}/`);
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The ids `keep` retains in one group, newest first: restic's documented policy. */
function keepByPolicy(group: readonly Snap[], keep: ResticKeepPolicy): Set<string> {
  const newestFirst = [...group].sort((a, b) => b.time.getTime() - a.time.getTime());
  const kept = new Set<string>();
  for (const s of newestFirst.slice(0, keep.last ?? 0)) kept.add(s.id);
  const buckets: [number | undefined, (d: Date) => string][] = [
    [keep.daily, (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`],
    [keep.weekly, isoWeek],
    [keep.monthly, (d) => `${d.getFullYear()}-${d.getMonth()}`],
  ];
  for (const [count, bucketOf] of buckets) {
    if (!count) continue;
    const seen = new Set<string>();
    for (const s of newestFirst) {
      const bucket = bucketOf(s.time);
      if (seen.has(bucket)) continue;
      if (seen.size >= count) break;
      seen.add(bucket);
      kept.add(s.id);
    }
    // Fewer buckets than asked for: restic also keeps the oldest snapshot (R1).
    const oldest = newestFirst.at(-1);
    if (seen.size < count && oldest) kept.add(oldest.id);
  }
  return kept;
}

/** ISO 8601 week (`YYYY-Www`) of a local date. */
function isoWeek(d: Date): string {
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const weekday = (day.getDay() + 6) % 7;
  day.setDate(day.getDate() - weekday + 3);
  const year = day.getFullYear();
  const firstThursday = new Date(year, 0, 4);
  const week =
    1 +
    Math.round(
      ((day.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getDay() + 6) % 7)) /
        7,
    );
  return `${year}-W${week}`;
}
