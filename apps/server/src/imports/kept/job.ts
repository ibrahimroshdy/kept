import { EXPORT_PATHS, type ExportEntity, type ExportHistoryEvent } from '@kept/shared';
import type pg from 'pg';
import { audited } from '../../audit/audited.js';
import type { Sealed } from '../../crypto/envelope.js';
import type { SecretKeys } from '../../crypto/keyring.js';
import type { Pools } from '../../db/pools.js';
import { type Scope, type Tx, withScope } from '../../db/scope.js';
import { HistoryEventSchema } from '../../exports/format.js';
import type { IngestDeps } from '../../files/ingest.js';
import { toErrorReply } from '../../http/errors.js';
import { defineJob, type JobDefinition } from '../../jobs/boss.js';
import { JOB_POLICIES } from '../../jobs/policies.js';
import type { JobQueue } from '../../jobs/queue.js';
import type { SystemJobDeps } from '../../jobs/system.js';
import { ArchiveContentError, ArchiveError } from '../../portability/zip/limits.js';
import type { OpenArchive } from '../../portability/zip/read.js';
import { type FileStorage, importArchiveKey } from '../../storage/blob-store.js';
import { ImageLimiter } from '../../storage/derivatives.js';
import {
  APPLY_ORDER,
  type Applied,
  type ApplyCtx,
  applyRow,
  type Known,
  NOT_APPLIED,
  needsOrder,
  REGISTRY_ENTITIES,
  type Row,
  rememberSourceId,
  sortRows,
} from './apply.js';
import { ensurePrimaryCodes } from './codes.js';
import { type ExportedFile, importFile, type Originals, originalsOf } from './files.js';
import { type DoorEvent, doorEventOf, HISTORY_BATCH, writeHistory } from './history.js';
import { IdMap } from './ids.js';
import { rowsOf, type Scan, scanArchive, totalOf } from './plan.js';
import { openKeptArchive, readManifest } from './read.js';
import { clearRunKey, readSecrets, sealedKeyOf, writeSecrets } from './secrets.js';

// The `import-kept` job (D69; step-7 plan T14, Q8–Q11; engineering spec §3.1b: one attempt,
// 2 hours, resumable). A tenant job: it runs as the person who pressed Import, under their
// row-level security, and `data` only names the run (never a passphrase or a key, Q7).
//
// The archive is read by byte range from the blob store (T7), and worked through in units: every
// row of every entity in APPLY_ORDER (apply.ts), every original file, then every history event.
// `progress` counts the units done; each chunk of rows is its own transaction that also moves
// `progress`, so a cancel (which waits for the run's lock) stops the job at the next chunk, a
// lost membership (D180: the run is no longer visible) stops it too, and a resumed run (POST …/run
// on a failed one) starts where it stopped. Ids are a function of the run and the old id (ids.ts),
// so a chunk that runs twice meets its own rows. The registries (match-or-make) run again in full
// on a resume: their matches live in memory. A chunk never spans two entities.
//
// After the rows: the secrets (only with the passphrase given, D68), in one transaction that also
// clears the sealed key; then the history in batches through kept.import_history() (Q10), each
// its own short transaction (it may create audit partitions); then every thing without a label
// gets one, the run is done, its key cleared and its archive deleted.
//
// One `import.run` audit event per chunk, as the person, with the things made as its subjects
// (Q11), and a last one with the totals.

/** Rows per transaction. */
export const CHUNK = 200;
/** Files per progress step (each file is ingested in its own transactions, ingestFile()). */
const FILE_CHUNK = 20;
/** How many skipped rows one chunk's audit event lists. */
const SKIPPED_LISTED = 50;

export type KeptJobDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  files: FileStorage;
  keys: SecretKeys | null;
  log: SystemJobDeps['log'];
  jobs?: JobQueue | null;
  limiter?: ImageLimiter;
};

type RunState = {
  id: string;
  location_id: string;
  status: string;
  progress: number;
  total: number | null;
  archive_bytes: number | null;
  created_at: Date;
  account_id: string;
  unplaced_id: string | null;
};

async function readState(
  client: pg.ClientBase,
  runId: string,
  lock: boolean,
): Promise<RunState | null> {
  const { rows } = await client.query<RunState>(
    `SELECT r.id, r.location_id, r.status, r.progress, r.total,
            r.archive_bytes::float8 AS archive_bytes, r.created_at,
            l.owner_account_id AS account_id,
            (SELECT p.id FROM public.places p
              WHERE p.location_id = r.location_id AND p.is_unplaced) AS unplaced_id
       FROM public.import_runs r JOIN public.locations l ON l.id = r.location_id
      WHERE r.id = $1 AND r.source = 'kept_zip'${lock ? ' FOR UPDATE OF r' : ''}`,
    [runId],
  );
  return rows[0] ?? null;
}

type Totals = {
  rows: number;
  things: number;
  skipped: number;
  files: number;
  codesAdopted: number;
  codesReissued: number;
  secrets: number;
  secretsSkipped: number;
  history: number;
  historyDropped: number;
};

const NO_TOTALS: Totals = {
  rows: 0,
  things: 0,
  skipped: 0,
  files: 0,
  codesAdopted: 0,
  codesReissued: 0,
  secrets: 0,
  secretsSkipped: 0,
  history: 0,
  historyDropped: 0,
};

type Session = {
  deps: KeptJobDeps;
  scope: Scope;
  runId: string;
  locationId: string;
  accountId: string;
  unplacedId: string;
  ids: IdMap;
  known: Known;
  archive: OpenArchive;
  /** Units done when this session started; units below it are skipped (except registries). */
  done: number;
  /** The unit the session is at. */
  at: number;
  columns: ApplyCtx['columns'];
  totals: Totals;
};

type Skipped = { entity: ExportEntity; id: string | null; reason: string };

/** The run is no longer running (cancelled, or no longer the caller's): stop quietly. */
class Stop extends Error {}

/** One transaction: the run locked and still running (else Stop), then `fn`, then progress. */
async function inChunk<T>(
  s: Session,
  units: { from: number; to: number },
  fn: (tx: Tx, client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return withScope(s.deps.pools.app, s.scope, async (tx, client) => {
    const run = await readState(client, s.runId, true);
    if (run?.status !== 'running') throw new Stop();
    const out = await fn(tx, client);
    if (units.to > run.progress) {
      await client.query('UPDATE public.import_runs SET progress = $2 WHERE id = $1', [
        s.runId,
        Math.min(units.to, run.total ?? units.to),
      ]);
    }
    return out;
  });
}

async function chunkAudit(
  tx: Tx,
  s: Session,
  entity: ExportEntity,
  units: { from: number; to: number },
  made: number,
  things: string[],
  skipped: Skipped[],
): Promise<void> {
  await audited(tx, {
    locationId: s.locationId,
    actor: { type: 'user', id: s.scope.userId },
    action: 'import.run',
    entity: { type: 'import_run', id: s.runId },
    after: {
      entity,
      units: `${units.from + 1}-${units.to}`,
      made,
      skipped: skipped.length,
      ...(skipped.length > 0 ? { skipped_rows: skipped.slice(0, SKIPPED_LISTED) } : {}),
    },
    subjects: things,
    requestId: `import:${s.runId}`,
  });
}

function applyCtxOf(s: Session, client: pg.ClientBase): ApplyCtx {
  return {
    client,
    runId: s.runId,
    locationId: s.locationId,
    accountId: s.accountId,
    ids: s.ids,
    known: s.known,
    unplacedId: s.unplacedId,
    columns: s.columns,
  };
}

/** Applies one chunk of an entity's rows, each in its savepoint. */
async function applyChunk(
  s: Session,
  entity: ExportEntity,
  rows: Row[],
  from: number,
): Promise<void> {
  const units = { from, to: from + rows.length };
  const counted = units.to > s.done;
  await inChunk(s, units, async (tx, client) => {
    const c = applyCtxOf(s, client);
    const things: string[] = [];
    const skipped: Skipped[] = [];
    let made = 0;
    for (const row of rows) {
      const oldId = typeof row.id === 'string' ? row.id.toLowerCase() : null;
      await client.query('SAVEPOINT kept_row');
      let applied: Applied;
      try {
        applied = await applyRow(c, entity, row);
        if (applied.status !== 'skipped' && oldId && applied.newId) {
          await rememberSourceId(c, entity, oldId, applied.newId);
        }
        await client.query('RELEASE SAVEPOINT kept_row');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT kept_row');
        applied = { status: 'skipped', reason: toErrorReply(err).body.code };
      }
      if (applied.status === 'skipped') {
        s.known.drop(oldId);
        skipped.push({ entity, id: oldId, reason: applied.reason });
        continue;
      }
      if (applied.status === 'inserted') made += 1;
      if (applied.code === 'adopted') s.totals.codesAdopted += 1;
      if (applied.code === 'reissued' || applied.code === 'kept_legacy') {
        s.totals.codesReissued += 1;
      }
      if (entity === 'things' && applied.newId) things.push(applied.newId);
    }
    if (counted) {
      s.totals.rows += rows.length;
      s.totals.things += entity === 'things' ? things.length : 0;
      s.totals.skipped += skipped.length;
      await chunkAudit(tx, s, entity, units, made, things, skipped);
    }
  });
}

async function collect(rows: AsyncIterable<Row>): Promise<Row[]> {
  const out: Row[] = [];
  for await (const r of rows) out.push(r);
  return out;
}

/** Every row of an entity, chunk by chunk, skipping what an earlier session did. */
async function applyEntity(s: Session, entity: ExportEntity, count: number): Promise<void> {
  const start = s.at;
  s.at += count;
  const registry = REGISTRY_ENTITIES.has(entity);
  if (s.at <= s.done && !registry) return;
  let index = start;
  let batch: Row[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const rows = batch;
    const from = index - rows.length;
    batch = [];
    if (from + rows.length <= s.done && !registry) return;
    // A registry runs again in full (it only matches what it made); anything else starts where
    // the earlier session stopped.
    const skip = registry ? 0 : Math.max(0, s.done - from);
    await applyChunk(s, entity, rows.slice(skip), from + skip);
  };
  const source = needsOrder(entity)
    ? sortRows(entity, await collect(rowsOf(s.archive, entity)))
    : rowsOf(s.archive, entity);
  for await (const row of source) {
    batch.push(row);
    index += 1;
    if (batch.length >= CHUNK) await flush();
  }
  await flush();
}

/** The original files: each ingested on its own, then the progress for a few at a time. */
async function applyFiles(s: Session, count: number, originals: Originals): Promise<void> {
  const start = s.at;
  s.at += count;
  if (s.at <= s.done) return;
  const ingest: IngestDeps = {
    pools: s.deps.pools,
    files: s.deps.files,
    limiter: s.deps.limiter ?? new ImageLimiter(1, 1000),
    log: s.deps.log,
    jobs: s.deps.jobs ?? null,
  };
  let index = start;
  let pending: { id: string; newId: string | null; skip?: string }[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const done = pending;
    pending = [];
    const units = { from: index - done.length, to: index };
    await inChunk(s, units, async (tx, client) => {
      const c = applyCtxOf(s, client);
      const skipped: Skipped[] = [];
      for (const f of done) {
        if (f.newId) await rememberSourceId(c, 'files', f.id, f.newId);
        else skipped.push({ entity: 'files', id: f.id, reason: f.skip ?? 'file_missing' });
      }
      s.totals.files += done.length - skipped.length;
      s.totals.skipped += skipped.length;
      s.totals.rows += done.length;
      await chunkAudit(tx, s, 'files', units, done.length - skipped.length, [], skipped);
    });
  };
  for await (const row of rowsOf(s.archive, 'files')) {
    index += 1;
    if (index <= s.done) continue;
    const f = row as unknown as ExportedFile;
    const out = await importFile(
      ingest,
      s.scope,
      s.archive,
      { runId: s.runId, locationId: s.locationId, ids: s.ids, originals },
      f,
    );
    if (out.status === 'skipped') {
      s.known.drop(f.id);
      pending.push({ id: f.id.toLowerCase(), newId: null, skip: out.code });
    } else pending.push({ id: f.id.toLowerCase(), newId: out.newId });
    if (pending.length >= FILE_CHUNK) await flush();
  }
  await flush();
}

/** The secrets, with the passphrase's key; the key is cleared in the same transaction. */
async function applySecrets(s: Session): Promise<void> {
  const keys = s.deps.keys;
  await withScope(s.deps.pools.app, s.scope, async (tx, client) => {
    const run = await readState(client, s.runId, true);
    if (run?.status !== 'running') throw new Stop();
    const sealed: Sealed | null = await sealedKeyOf(client, s.runId);
    if (!sealed) return;
    if (keys) {
      const records = await readSecrets(s.archive, keys, s.runId, sealed);
      if (records) {
        const out = await writeSecrets(
          { tx, client, scope: s.scope, requestId: `import:${s.runId}` },
          keys,
          s.ids,
          records,
        );
        s.totals.secrets += out.written;
        s.totals.secretsSkipped += out.skipped;
      }
    }
    await clearRunKey(client, s.runId);
  });
}

/** The history, in the door's batches, each its own short transaction. */
async function applyHistory(s: Session, count: number): Promise<void> {
  const start = s.at;
  s.at += count;
  if (s.at <= s.done) return;
  const name = EXPORT_PATHS.data('history');
  if (!s.archive.has(name)) return;
  const now = Date.now();
  let index = start;
  let batch: DoorEvent[] = [];
  let sent = 0;
  const flush = async () => {
    const events = batch;
    const units = { from: index - sent, to: index };
    batch = [];
    sent = 0;
    if (units.to <= units.from) return;
    await inChunk(s, units, async (_tx, client) => {
      const written = await writeHistory(client, s.runId, events);
      s.totals.history += written;
      s.totals.historyDropped += units.to - units.from - written;
    });
  };
  for await (const e of s.archive.ndjson(name, HistoryEventSchema)) {
    index += 1;
    if (index <= s.done) continue;
    sent += 1;
    const event = doorEventOf(e as ExportHistoryEvent, s.ids, s.known, now);
    if (event) batch.push(event);
    if (sent >= HISTORY_BATCH) await flush();
  }
  await flush();
}

/** Done: every thing labelled, the key cleared, the totals audited; then the archive deleted. */
async function finish(s: Session): Promise<void> {
  await withScope(s.deps.pools.app, s.scope, async (tx, client) => {
    const run = await readState(client, s.runId, true);
    if (run?.status !== 'running') throw new Stop();
    const labelled = await ensurePrimaryCodes(client, s.locationId);
    await clearRunKey(client, s.runId);
    await client.query(
      `UPDATE public.import_runs
          SET status = 'done', progress = coalesce(total, progress), finished_at = now(),
              error = NULL
        WHERE id = $1`,
      [s.runId],
    );
    await audited(tx, {
      locationId: s.locationId,
      actor: { type: 'user', id: s.scope.userId },
      action: 'import.run',
      entity: { type: 'import_run', id: s.runId },
      after: {
        status: 'done',
        rows: s.totals.rows,
        things: s.totals.things,
        files: s.totals.files,
        skipped: s.totals.skipped,
        codes_adopted: s.totals.codesAdopted,
        codes_reissued: s.totals.codesReissued + labelled,
        secrets: s.totals.secrets,
        secrets_skipped: s.totals.secretsSkipped,
        history: s.totals.history,
        history_dropped: s.totals.historyDropped,
      },
      requestId: `import:${s.runId}`,
    });
  });
  // The archive is no longer needed (a missing one is fine); the prune catches a crash here.
  await s.deps.files.blobs.delete(importArchiveKey(s.runId)).catch((err: unknown) => {
    s.deps.log.error({ runId: s.runId, code: toErrorReply(err).body.code }, 'import archive kept');
  });
}

/** Runs (or resumes) run `runId` to its end as `scope`. */
export async function runKeptImport(deps: KeptJobDeps, scope: Scope, runId: string): Promise<void> {
  const state = await withScope(deps.pools.app, scope, (_tx, client) =>
    readState(client, runId, false),
  );
  if (state?.status !== 'running' || state.archive_bytes === null || !state.unplaced_id) return;
  let archive: OpenArchive | null = null;
  try {
    archive = await openKeptArchive(deps.files.blobs, runId, state.archive_bytes);
    const manifest = await readManifest(archive);
    const scan: Scan = await scanArchive(archive, manifest);
    const total = totalOf(scan);
    if (state.total !== total) {
      await withScope(deps.pools.app, scope, (_tx, client) =>
        client.query(
          `UPDATE public.import_runs SET total = $2, progress = least(progress, $2)
            WHERE id = $1 AND status = 'running'`,
          [runId, total],
        ),
      );
    }
    const s: Session = {
      deps,
      scope,
      runId,
      locationId: state.location_id,
      accountId: state.account_id,
      unplacedId: state.unplaced_id,
      ids: new IdMap(runId, state.created_at.getTime(), manifest.location.id, state.location_id),
      known: scan.known,
      archive,
      done: Math.min(state.progress, total),
      at: 0,
      columns: new Map(),
      totals: { ...NO_TOTALS },
    };
    const originals = originalsOf(manifest.files);
    for (const entity of APPLY_ORDER) {
      if (NOT_APPLIED.has(entity)) continue;
      const count = scan.counts.get(entity) ?? 0;
      if (entity === 'files') await applyFiles(s, count, originals);
      else await applyEntity(s, entity, count);
    }
    await applySecrets(s);
    await applyHistory(s, scan.history.total);
    await finish(s);
  } catch (err) {
    if (err instanceof Stop) return;
    // Kept for a resume: the progress (and the key) stay; the person sees why and can go on.
    // An archive Kept can't read: `archive_invalid:<reason>`, as the archive routes store it.
    const reason =
      err instanceof ArchiveError
        ? `${err.reason === 'too_large' ? 'archive_too_large' : 'archive_invalid'}:${err.reason}`
        : err instanceof ArchiveContentError
          ? 'archive_invalid'
          : String(toErrorReply(err).body.code);
    deps.log.error({ runId, code: reason }, 'Kept import failed');
    await withScope(deps.pools.app, scope, (_tx, client) =>
      client.query(
        `UPDATE public.import_runs SET status = 'failed', error = $2
          WHERE id = $1 AND status = 'running'`,
        [runId, reason.slice(0, 500)],
      ),
    ).catch(() => undefined);
  } finally {
    archive?.close();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `import-kept` tenant job (plan T14), aggregated by jobs/portability.ts. */
export function keptImportJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'import-kept',
      kind: 'tenant',
      policy: JOB_POLICIES['import-kept'],
      handler: async ({ data, scope, client }) => {
        const runId = (data as { runId?: unknown } | null)?.runId;
        if (typeof runId !== 'string' || !UUID.test(runId)) {
          throw new Error('import-kept job: data names no run');
        }
        const app = deps.pools.app;
        if (!app) throw new Error('import-kept job: the worker has no kept_app pool');
        if (!deps.files) throw new Error('import-kept job: the worker has no file storage');
        // runJob() holds this scoped transaction open while each chunk commits on its own
        // connection, for up to the policy's 2 hours.
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '7260s'`);
        const sendTenant = deps.sendTenant;
        await runKeptImport(
          {
            pools: { app, system: deps.pools.system },
            files: deps.files,
            keys: deps.secretKeys ?? null,
            log: deps.log,
            jobs: sendTenant
              ? {
                  send: async () => {
                    throw new Error('import-kept: sends tenant jobs only');
                  },
                  sendTenant: (c, name, d) => sendTenant(c, name, d, { startAfter: new Date() }),
                }
              : null,
          },
          scope,
          runId.toLowerCase(),
        );
      },
    }),
  ];
}
