import type { MappableField } from '@kept/shared';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import type { Pools } from '../db/pools.js';
import { type Scope, type Tx, withScope } from '../db/scope.js';
import { AppError, toErrorReply } from '../http/errors.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { createPlace } from '../places/service.js';
import { createItem } from '../registries/service.js';
import type { RegistryKind } from '../registries/view.js';
import { insertThing } from '../things/service.js';
import type { ImportChoices } from './csv.js';
import {
  type Lookups,
  loadLookups,
  type PlannedRow,
  planRow,
  type Ref,
  type RunInput,
} from './dry-run.js';

// The `import-csv` job (plan T18, Q18; engineering spec §3.1b: 1 attempt, 2 h, resumable).
//
// A tenant job: it runs as the person who pressed Import, under their row-level security, and
// `data` only names the run, which is read back under that security (jobs/boss.ts's rule).
// The rows are worked CHUNK at a time, each chunk in its own transaction:
// - the run is locked and its status read first, so a cancel (which waits for the lock) stops
//   the import at the next chunk, and two workers never take the same rows;
// - each row goes through the step-2 services, as a request would: places for its path
//   (createPlace), brands, vendors and tags by name (createItem), and the thing with its one-line
//   purchase (insertThing, `created_via = 'import'`), each writing its own audit row;
// - each row is remembered in import_source_ids (its `source_id` cell, or the SHA-256 of the row),
//   so a re-run, or a resumed run, never makes it twice; its legacy codes go to legacy_codes
//   (source `csv`);
// - a row that fails anyway (something changed since the dry run) is rolled back to its
//   savepoint and reported, and the chunk goes on;
// - `progress` moves with the chunk, and one `import.run` audit event (as the person, with the
//   things made as its subjects) records it.
// The last chunk sets `done` and clears the rows. A run that fails (the database went away) is
// set `failed` with the reason, keeping its rows and progress: POST …/run resumes it.

/** Rows per transaction. */
export const CHUNK = 200;
/** How many skipped rows one chunk's audit event lists. */
const SKIPPED_LISTED = 50;

export type RunRow = {
  id: string;
  location_id: string;
  source: 'csv';
  status: 'draft' | 'checked' | 'running' | 'done' | 'failed' | 'cancelled';
  mapping: Record<string, MappableField>;
  choices: ImportChoices;
  rows: string[][] | null;
  dry_run_report: unknown;
  progress: number;
  total: number | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  error: string | null;
  row_version: number;
  updated_at: Date;
};

/** The run `id` as the caller sees it (null when they can't), optionally locked. */
export async function readRun(
  client: pg.ClientBase,
  id: string,
  opts: { lock?: boolean; rows?: boolean } = {},
): Promise<RunRow | null> {
  const { rows } = await client.query<RunRow>(
    `SELECT id, location_id, source, status, mapping, choices,
            ${opts.rows ? 'rows' : 'NULL::jsonb AS rows'}, dry_run_report, progress, total,
            created_at, started_at, finished_at, error, row_version, updated_at
       FROM public.import_runs WHERE id = $1${opts.lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/** The mapper's view of a run: `rows` holds the header row first, then the data rows. */
export function runInputOf(run: RunRow): RunInput {
  const [columns = [], ...data] = run.rows ?? [];
  return {
    id: run.id,
    locationId: run.location_id,
    columns,
    rows: data,
    mapping: run.mapping,
    choices: run.choices,
  };
}

type ChunkCtx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  lookups: Lookups;
  locationId: string;
};

/** The id of a brand, vendor or tag named in a row, creating it the first time. */
async function ensureItem(
  c: ChunkCtx,
  kind: Extract<RegistryKind, 'brands' | 'vendors' | 'tags'>,
  ref: Ref | null,
): Promise<string | undefined> {
  if (!ref) return undefined;
  if ('id' in ref) return ref.id;
  let id: string;
  try {
    const made = await createItem(
      { tx: c.tx, client: c.client, userId: c.scope.userId, requestId: c.requestId, jobs: null },
      kind,
      c.lookups.accountId,
      { name: ref.create },
    );
    id = made.item.id;
  } catch (err) {
    // Made by someone else since the lookups were read (a brand or tag name is unique).
    const existing = err instanceof AppError ? err.extra?.existingId : undefined;
    if (typeof existing !== 'string') throw err;
    id = existing;
  }
  if (kind === 'brands') c.lookups.rememberBrand(ref.create, id);
  else if (kind === 'vendors') c.lookups.rememberVendor(ref.create, id);
  else c.lookups.rememberTag(ref.create, id);
  return id;
}

type Applied = { thingId: string; places: number; purchase: boolean; codes: number };

/** Writes one planned row. Throws when a service refuses it (the caller rolls the row back). */
async function applyRow(c: ChunkCtx, runId: string, planned: PlannedRow): Promise<Applied> {
  const t = planned.thing;
  if (!t) throw new Error('import: a skipped row has nothing to apply');

  let placeId: string;
  let places = 0;
  if ('placeId' in t.target) placeId = t.target.placeId;
  else {
    let parent = t.target.parentId;
    for (const name of t.target.create) {
      // A top-level place is a room; one inside another place is a zone (D33's built-in kinds).
      const made = await createPlace(
        { tx: c.tx, client: c.client, scope: c.scope, jobs: null, requestId: c.requestId },
        c.locationId,
        { parentId: parent, name, kindKey: parent === null ? 'room' : 'zone' },
      );
      c.lookups.rememberPlace(parent, name, made.id);
      parent = made.id;
      places += 1;
    }
    placeId = parent as string;
  }

  const brandId = await ensureItem(c, 'brands', t.brand);
  const tagIds: string[] = [];
  for (const tag of t.tags) {
    const id = await ensureItem(c, 'tags', tag);
    if (id && !tagIds.includes(id)) tagIds.push(id);
  }
  const vendorId = t.purchase ? await ensureItem(c, 'vendors', t.purchase.vendor) : undefined;

  const thingId = await insertThing(
    { tx: c.tx, client: c.client, scope: c.scope, requestId: c.requestId, jobs: null, files: null },
    {
      locationId: c.locationId,
      placeId,
      name: t.name,
      quantity: t.quantity,
      ...(t.typeId ? { typeId: t.typeId } : {}),
      ...(brandId ? { brandId } : {}),
      ...(t.model ? { model: t.model } : {}),
      ...(t.serial ? { serial: t.serial } : {}),
      ...(t.barcode ? { barcode: t.barcode } : {}),
      ...(t.colour ? { colour: t.colour } : {}),
      ...(t.condition ? { condition: t.condition } : {}),
      ...(t.notes ? { notes: t.notes } : {}),
      ...(Object.keys(t.aliases).length > 0 ? { aliases: t.aliases } : {}),
      ...(tagIds.length > 0 ? { tagIds } : {}),
      ...(t.manualUrl ? { manualUrl: t.manualUrl } : {}),
      ...(Object.keys(t.custom).length > 0 ? { custom: t.custom } : {}),
      ...(t.purchase
        ? {
            purchase: {
              purchasedOn: t.purchase.purchasedOn,
              currency: t.purchase.currency,
              price: t.purchase.price,
              ...(vendorId ? { vendorId } : {}),
            },
          }
        : {}),
    },
    { createdVia: 'import' },
  );

  for (const code of t.legacyCodes) {
    // The primary key is per source; the lookups refused a code taken under any source.
    await c.client.query(
      `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id)
       VALUES ($1, 'csv', '', $2, $3)`,
      [c.locationId, code, thingId],
    );
    c.lookups.rememberCode(code, thingId);
  }
  for (const code of t.ownCodes) {
    // Own codes (D208, T17a): the lookups checked the format rule and every source.
    await c.client.query(
      `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id)
       VALUES ($1, 'own', '', $2, $3)`,
      [c.locationId, code, thingId],
    );
    c.lookups.rememberCode(code, thingId);
  }
  await c.client.query(
    `INSERT INTO public.import_source_ids (location_id, source, source_id, entity_type, entity_id,
                                           run_id)
     VALUES ($1, 'csv', $2, 'thing', $3, $4)`,
    [c.locationId, planned.sourceId, thingId, runId],
  );
  return {
    thingId,
    places,
    purchase: !!t.purchase,
    codes: t.legacyCodes.length + t.ownCodes.length,
  };
}

/** Why a row failed, in words the report can show (never a value from the row). */
function reasonOf(err: unknown): string {
  const { body } = toErrorReply(err);
  return typeof body.hint === 'string' ? body.hint : body.error;
}

/**
 * Works the next chunk of run `runId`. Returns whether there is more to do: false once the run
 * is done, or no longer `running` (cancelled, or gone).
 */
export async function importChunk(
  tx: Tx,
  client: pg.PoolClient,
  scope: Scope,
  runId: string,
): Promise<boolean> {
  const run = await readRun(client, runId, { lock: true, rows: true });
  if (run?.status !== 'running') return false;
  const input = runInputOf(run);
  const total = input.rows.length;
  const start = Math.min(run.progress, total);
  const end = Math.min(start + CHUNK, total);
  const chunk = input.rows.slice(start, end).map((row, i) => ({ index: start + i, row }));
  const requestId = `import:${runId}`;

  const created: string[] = [];
  const skipped: { row: number; reason: string }[] = [];
  const counts = { places: 0, purchases: 0, legacy_codes: 0 };
  if (chunk.length > 0) {
    const lookups = await loadLookups(tx, client, scope, input, chunk);
    const c: ChunkCtx = { tx, client, scope, requestId, lookups, locationId: run.location_id };
    for (const { index, row } of chunk) {
      lookups.begin();
      const planned = await planRow(client, input, lookups, index, row, 'apply');
      if (planned.status === 'skipped') {
        lookups.commit();
        skipped.push({ row: planned.row, reason: planned.issues[0]?.message ?? 'Skipped.' });
        continue;
      }
      await client.query('SAVEPOINT import_row');
      try {
        const done = await applyRow(c, runId, planned);
        await client.query('RELEASE SAVEPOINT import_row');
        lookups.commit();
        created.push(done.thingId);
        counts.places += done.places;
        counts.purchases += done.purchase ? 1 : 0;
        counts.legacy_codes += done.codes;
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT import_row');
        lookups.rollback();
        skipped.push({ row: planned.row, reason: reasonOf(err) });
      }
    }
  }

  const finished = end >= total;
  await client.query(
    `UPDATE public.import_runs
        SET progress = $2,
            status = CASE WHEN $3 THEN 'done' ELSE status END,
            rows = CASE WHEN $3 THEN NULL ELSE rows END,
            finished_at = CASE WHEN $3 THEN now() ELSE finished_at END
      WHERE id = $1`,
    [runId, end, finished],
  );
  await audited(tx, {
    locationId: run.location_id,
    actor: { type: 'user', id: scope.userId },
    action: 'import.run',
    entity: { type: 'import_run', id: runId },
    after: {
      rows: chunk.length > 0 ? `${start + 1}-${end}` : null,
      things: created.length,
      places: counts.places,
      purchases: counts.purchases,
      legacy_codes: counts.legacy_codes,
      skipped: skipped.length,
      ...(skipped.length > 0 ? { skipped_rows: skipped.slice(0, SKIPPED_LISTED) } : {}),
      ...(finished ? { status: 'done' } : {}),
    },
    subjects: created,
    requestId,
  });
  return !finished;
}

export type ImportJobDeps = {
  pools: Pick<Pools, 'app'>;
  log: SystemJobDeps['log'];
};

/** Runs (or resumes) run `runId` to its end, a chunk per transaction, as `scope`. */
export async function runImport(deps: ImportJobDeps, scope: Scope, runId: string): Promise<void> {
  try {
    for (;;) {
      const more = await withScope(deps.pools.app, scope, (tx, client) =>
        importChunk(tx, client, scope, runId),
      );
      if (!more) return;
    }
  } catch (err) {
    // Kept for a resume: the rows and the progress stay; the person sees why and can go on.
    deps.log.error({ runId, code: toErrorReply(err).body.code }, 'CSV import failed');
    const reason = reasonOf(err).slice(0, 500);
    await withScope(deps.pools.app, scope, (_tx, client) =>
      client.query(
        `UPDATE public.import_runs SET status = 'failed', error = $2
          WHERE id = $1 AND status = 'running'`,
        [runId, reason],
      ),
    );
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `import-csv` tenant job (T18): a resumable import in the importing person's scope (Q18).
 * Aggregated by jobs/capture.ts. */
export function importJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'import-csv',
      kind: 'tenant',
      policy: JOB_POLICIES['import-csv'],
      handler: async ({ data, scope, client }) => {
        const runId = (data as { runId?: unknown } | null)?.runId;
        if (typeof runId !== 'string' || !UUID.test(runId)) {
          throw new Error('import-csv job: data names no run');
        }
        const app = deps.pools.app;
        if (!app) throw new Error('import-csv job: the worker has no kept_app pool');
        // runJob() holds this scoped transaction open while each chunk commits on its own
        // connection; a large import runs up to the policy's 2 hours, past the pool's 30 s
        // idle-in-transaction limit. It holds no lock and no transaction id.
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '7260s'`);
        await runImport({ pools: { app }, log: deps.log }, scope, runId.toLowerCase());
      },
    }),
  ];
}
