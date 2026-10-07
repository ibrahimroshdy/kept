import type {
  ArchiveRefusal,
  ArchiveSource,
  HomeboxChoices,
  HomeboxFieldKind,
  ImportIssue,
  ImportIssueRef,
  ImportRunStatus,
  Role,
} from '@kept/shared';
import type pg from 'pg';
import type { Scope, Tx } from '../db/scope.js';
import type { JobQueue } from '../jobs/queue.js';
import type { OpenArchive } from '../portability/zip/read.js';
import type { FileStorage } from '../storage/blob-store.js';

// The archive importers' contract (step-7 plan T8, T9, T14), in the shapes of the web's
// apps/web/src/api/portability/types.ts (ArchiveImportRun, ArchiveInspect, ArchiveDryRunReport).
// imports/archive.ts serves the routes and dispatches on `import_runs.source` to an
// `ArchiveImporter`: Homebox's (imports/homebox/importer.ts, T9) and the Kept export's (T14).

/** `import_runs` as the archive routes read it (the caller's row-level security applies). */
export type ArchiveRunRow = {
  id: string;
  location_id: string | null;
  source: ArchiveSource;
  source_version: string | null;
  status: ImportRunStatus;
  choices: Record<string, unknown>;
  dry_run_report: unknown;
  progress: number;
  total: number | null;
  created_by: string;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  archive_bytes: string | number | null;
  archive_sha256: string | null;
  archive_ready_at: Date | null;
  inspect: Record<string, unknown> | null;
  /** Whether a passphrase-derived key is sealed on the run (T14); the key itself is never read
   * by the routes. */
  has_key: boolean;
  row_version: number;
  updated_at: Date;
};

export type HomeboxCollectionCounts = {
  entities: number;
  locations: number;
  attachments: number;
  maintenance: number;
  tags: number;
  types: number;
};

/** What the Homebox choices step offers (web HomeboxMappingHints): names and counts only. */
export type HomeboxMappingHints = {
  types: { id: string; name: string; items: number }[];
  fields: { name: string; kind: HomeboxFieldKind; items: number }[];
  insuredItems: number;
  seededUnused: { places: string[]; tags: string[] };
};

export type HomeboxInspect = {
  source: 'homebox_zip';
  sourceVersion: string | null;
  collections: {
    id?: string;
    name?: string;
    counts: HomeboxCollectionCounts;
    exportedAt?: string;
    mapping?: HomeboxMappingHints;
  }[];
};

export type KeptInspect = {
  source: 'kept_zip';
  sourceVersion: string | null;
  kept: {
    locationName: string;
    kind: string;
    exportedAt: string;
    keptVersion: string;
    counts: Record<string, number>;
    includesSecrets: boolean;
    members: { name: string; role: Role }[];
  };
};

/** POST /imports/:id/inspect: read from the manifest and the row counts only. */
export type ArchiveInspect = HomeboxInspect | KeptInspect;

/** One row of an archive dry run: only rows with issues are kept (plan Q27). */
export type ArchiveReportRow = {
  status: 'ok' | 'text' | 'skipped';
  ref: ImportIssueRef;
  issues: ImportIssue[];
};

export type HomeboxDryRunSummary = {
  places: number;
  things: number;
  containers: number;
  purchases: number;
  warranties: number;
  services: number;
  schedules: number;
  attachments: number;
  links: number;
  tags: number;
  types: number;
  fieldsAdded: number;
  legacyCodes: number;
  skipped: number;
  asText: number;
  refusedFiles: number;
};

export type KeptDryRunSummary = {
  places: number;
  things: number;
  attachments: number;
  files: number;
  codesAdopted: number;
  codesReissued: number;
  history: number;
  historyDropped: number;
  secrets: number;
  skipped: number;
  asText: number;
  members: { name: string; role: Role }[];
};

export type ArchiveDryRunReport =
  | { source: 'homebox_zip'; summary: HomeboxDryRunSummary; rows: ArchiveReportRow[] }
  | { source: 'kept_zip'; summary: KeptDryRunSummary; rows: ArchiveReportRow[] };

/** A request's transaction, as the dry run runs in it (writing nothing). */
export type ArchiveCtx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  files: FileStorage | null;
  jobs: JobQueue | null;
};

/**
 * One archive format. imports/archive.ts calls, in order:
 * - `inspect`, on the opened archive, outside any transaction: the manifest and counts;
 * - `load`, outside any transaction, before a dry run: everything the plan reads from the
 *   archive (never a file's bytes);
 * - `dryRun`, in the request's transaction against the run's target, writing nothing: the report
 *   (summary, and only the rows with issues) and how many steps the job will take (`total`).
 * Archive rule refusals are ArchiveError (portability/zip/limits.ts); an entry that isn't what
 * the format says is ArchiveContentError. The route maps both.
 */
export type ArchiveImporter<Loaded = unknown> = {
  /** The tenant job POST /imports/:id/run sends with `{runId}`. */
  job: 'import-homebox' | 'import-kept';
  inspect(archive: OpenArchive, run: ArchiveRunRow): Promise<ArchiveInspect>;
  load(archive: OpenArchive, run: ArchiveRunRow): Promise<Loaded>;
  dryRun(
    c: ArchiveCtx,
    run: ArchiveRunRow & { location_id: string },
    loaded: Loaded,
  ): Promise<{ report: ArchiveDryRunReport; total: number }>;
  /** Opens the uploaded archive with this format's expected names. */
  open(files: FileStorage, run: ArchiveRunRow): Promise<OpenArchive>;
};

/** A run's choices when they are Homebox's, else null. */
export type MaybeChoices = HomeboxChoices | null;

/** Why an archive was refused, as the run records it (`error` = `archive_invalid`). */
export type StoredRefusal = {
  error: 'archive_invalid' | 'archive_too_large';
  reason?: ArchiveRefusal;
};
