import { RESTIC_ERROR_REASONS, type ResticErrorReason } from '@kept/shared';

// The restic seam (step-8 plan T2; D64). restic is a child process, never a library: T5's run.ts
// spawns the pinned binary with `--json` and maps its messages (json.ts, from T0a's R1 note) and
// exit codes onto these types. Everything else (the nightly job, restore, the drill, verify, the
// pre-upgrade snapshot) is written against this interface, so T6, T7 and T8 run on fake.ts before
// the real wrapper lands. test/restic-contract.ts is what both implementations promise.
//
// These are Kept's shapes, not restic's JSON: field names here are ours, and T5 translates. The
// summary's fields mirror what restic's `backup --json` summary is documented to report (new,
// changed and unmodified files, data added); R1 confirms the exact message, and T5 maps it.
//
// Secrets: a repository's password and storage credentials live only in `ResticRepo.env`, which
// the real wrapper passes as the child's environment (never argv, never a log line). A
// ResticError's message is scrubbed of them before it is built; `ResticRepo.description` is what
// logs and backup_runs.target show.

export { RESTIC_ERROR_REASONS, type ResticErrorReason };

/** A repository and how to open it. */
export type ResticRepo = Readonly<{
  /** restic's repository location (`RESTIC_REPOSITORY`): a path, `s3:…` or `sftp:…`; the
   * syntax per target is R1's and repo.ts's (T5). Holds no credential. */
  location: string;
  /** The child's environment: the password and the storage credentials (and, for SFTP, the
   * options naming the key and known_hosts files). Never logged, never in argv. */
  env: Readonly<Record<string, string>>;
  /** For logs and `backup_runs.target`, e.g. "directory /mnt/nas/kept". Never a credential. */
  description: string;
  /** restic's extended options (`-o key=value`), e.g. `s3.bucket-lookup=path`, or `sftp.args`
   * naming the key and known_hosts files (R1). Never a credential: they are in argv. */
  options?: Readonly<Record<string, string>>;
}>;

export type ResticBackupOptions = {
  /** Paths to back up: absolute, or relative to `cwd`. R1 proposes relative paths run from
   * KEPT_DATA_DIR (`backup`, `blobs`), so a moved data directory never starts a new group; they
   * are stored in the snapshot under `/` (`/backup/db/db.dump`). */
  paths: readonly string[];
  /** The directory restic runs in (the child's cwd), for relative `paths`. */
  cwd?: string;
  /** `kept`, the run's kind, `v<version>` (plan T5). */
  tags: readonly string[];
  /** Paths (or prefixes) to leave out, absolute or as stored in the snapshot: `tmp/`, `.cache/`. */
  exclude?: readonly string[];
  /** The snapshot's time, for retention tests over faked days (R1 records restic's flag). */
  time?: Date;
};

export type ResticBackupSummary = {
  snapshotId: string;
  filesNew: number;
  filesChanged: number;
  filesUnmodified: number;
  /** Bytes added to the repository by this snapshot (after deduplication). */
  bytesAdded: number;
  /** Files and bytes the snapshot holds. */
  filesTotal: number;
  bytesTotal: number;
};

export type ResticSnapshot = {
  id: string;
  time: Date;
  host: string;
  paths: string[];
  tags: string[];
};

export type ResticKeepPolicy = {
  /** Keep the newest snapshot in each of the last N days, ISO weeks and months. */
  daily?: number;
  weekly?: number;
  monthly?: number;
  /** Keep the newest N regardless of time (pre-upgrade snapshots: 3, plan Q7). */
  last?: number;
};

export type ResticForgetOptions = {
  /** Only snapshots carrying every one of these tags are considered. */
  tags: readonly string[];
  keep: ResticKeepPolicy;
  /** How snapshots are grouped before the policy applies. R1 proposes `host,tags` for every
   * forget Kept runs (a changing path would otherwise escape retention); the fake defaults to it. */
  groupBy?: readonly ('host' | 'paths' | 'tags')[];
  prune: boolean;
};

export type ResticForgetResult = { kept: string[]; removed: string[] };

export type ResticNode = {
  /** Absolute path inside the snapshot. */
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'other';
  size: number;
};

export type ResticRestoreOptions = {
  /** An empty directory; files land at `<target><their path in the snapshot>`. */
  target: string;
  /** Subtrees, as paths in the snapshot (`/backup/db`), to restore; absent: everything. */
  include?: readonly string[];
};

export type ResticRestoreResult = { filesRestored: number; bytesRestored: number };

export type ResticCheckOptions = {
  /** `restic check --read-data-subset`, e.g. `5%` (plan T7). */
  readDataSubset?: string;
};

export type ResticCheckResult = { ok: boolean; errors: string[] };

export type ResticStats = { totalBytes: number; totalFiles: number; snapshots: number };

export interface Restic {
  /** The binary's version, e.g. `0.18.0`. */
  version(): Promise<string>;
  /** Creates the repository; `created: false` when one already exists there. */
  init(repo: ResticRepo): Promise<{ created: boolean }>;
  backup(repo: ResticRepo, opts: ResticBackupOptions): Promise<ResticBackupSummary>;
  forget(repo: ResticRepo, opts: ResticForgetOptions): Promise<ResticForgetResult>;
  /** Newest first. */
  snapshots(repo: ResticRepo, opts?: { tags?: readonly string[] }): Promise<ResticSnapshot[]>;
  /** Every node in a snapshot, or under `path` when given. */
  ls(repo: ResticRepo, snapshotId: string, opts?: { path?: string }): Promise<ResticNode[]>;
  restore(
    repo: ResticRepo,
    snapshotId: string,
    opts: ResticRestoreOptions,
  ): Promise<ResticRestoreResult>;
  check(repo: ResticRepo, opts?: ResticCheckOptions): Promise<ResticCheckResult>;
  /** Removes stale locks (a crash mid-run). */
  unlock(repo: ResticRepo): Promise<void>;
  /** The repository's raw size, for the status page. */
  stats(repo: ResticRepo): Promise<ResticStats>;
}

/**
 * A restic command that failed. `reason` is one of RESTIC_ERROR_REASONS: `no_repository` (none
 * at the location), `wrong_password`, `locked` (another process holds it), `partial` (a backup
 * that couldn't read some files: the snapshot exists), `unreachable` (the storage), `failed`
 * (anything else). The message never holds a password, a key or a credential.
 */
export class ResticError extends Error {
  readonly reason: ResticErrorReason;
  /** The child's exit code, when it exited. */
  readonly exitCode: number | null;
  /** `partial` from `backup` (R1: exit 3 still writes the snapshot): what it wrote, and how
   * many files it could not read. */
  readonly partial?: { summary: ResticBackupSummary; unreadable: number };

  constructor(
    reason: ResticErrorReason,
    message: string,
    exitCode: number | null = null,
    partial?: { summary: ResticBackupSummary; unreadable: number },
  ) {
    super(message);
    this.name = 'ResticError';
    this.reason = reason;
    this.exitCode = exitCode;
    if (partial) this.partial = partial;
  }
}

/** `text` with every value of the repository's environment (its password and credentials)
 * replaced, for anything that may reach an error or a log (plan T5: stderr is scrubbed). */
export function scrubSecrets(text: string, repo: Pick<ResticRepo, 'env'>): string {
  let out = text;
  const secrets = Object.values(repo.env)
    .filter((value) => value.length >= 4)
    .sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join('[redacted]');
  return out;
}
