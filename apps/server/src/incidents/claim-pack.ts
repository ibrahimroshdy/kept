import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { safeCsvCell } from '@kept/shared';
import type pg from 'pg';
import yazl from 'yazl';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import type { Pools } from '../db/pools.js';
import { type Scope, type Tx, withScope, withSystem } from '../db/scope.js';
import { downloadName } from '../files/views.js';
import { AppError, conflict, invalid, notFound, pgErrorOf } from '../http/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { prepareInsurance, renderPrepared, reportLocaleOf, todayFor } from '../reports/service.js';
import { exportKey, type FileStorage } from '../storage/blob-store.js';
import type { InsuranceOptions } from './report.js';

// Claim packs (D158, D180, D201; engineering spec §2.8; step-4 plan T18, Q19): a ZIP with the
// insurance report and every referenced receipt, invoice and photo, and a serial list, for an
// incident or a selection of things. Owners and admins only (`incidents.manage`), behind an
// explicit "this includes prices and documents" acknowledgement, and shared by an expiring
// download link (`/x/<token>`, download.ts), never a share-link page.
//
// - POST /api/v1/claim-packs records an export run (export_runs, 0048/0049; the creator's alone)
//   and sends the `claim-pack` tenant job in the same transaction. Five an hour per user, like
//   reports.
// - The job (buildClaimPack) runs as the creator, under row-level security: it claims the run
//   (kept.export_run_claim), renders the insurance report through the D201 engine, then streams
//   the files from the blob store into a stored (not deflated: photos and PDFs don't shrink,
//   spike) ZIP spooled under the data volume's tmp/, puts it at `x/<runId>.zip` and finishes the
//   run (kept.export_run_finish, which writes that key itself). Progress every 20 files. The
//   creator gets an `export_ready` notification. Secrets are never read.
// - The link: POST …/link mints a new token (32 random bytes, base64url), stores only its sha256
//   and revokes any earlier one; the URL is shown once. DELETE …/link revokes it. The pack and its
//   link go after 7 days (kept.purge_expired_exports, the `purge-exports` job).

export const PACK_RATE_LIMIT = 5;
const PACK_RATE_WINDOW_SECONDS = 3600;
export const MAX_PACK_THINGS = 500;
/** Past this many files a pack fails `too_many_files` (choose fewer things). */
export const MAX_PACK_FILES = 5000;
const PROGRESS_EVERY = 20;
/** A run still `running` this long after it was created has been abandoned (the job's
 * 1,800 s expiry, jobs/policies.ts, plus a margin). */
const STALE_RUNNING_MS = 40 * 60 * 1000;
export const LINK_DAYS_DEFAULT = 7;

export const CreateClaimPackBody = z
  .object({
    scope: z.union([
      z.object({ incidentId: z.uuid() }).strict(),
      z
        .object({ locationId: z.uuid(), thingIds: z.array(z.uuid()).min(1).max(MAX_PACK_THINGS) })
        .strict(),
    ]),
    locale: z.enum(['en', 'ar', 'fr', 'de', 'it']).optional(),
    digits: z.enum(['western', 'eastern']).optional(),
    /** D158: the "this includes prices and documents" warning was shown and accepted. */
    acknowledged: z.boolean().optional(),
  })
  .strict();
export type CreateClaimPackBody = z.infer<typeof CreateClaimPackBody>;

export const ClaimPackLinkBody = z
  .object({ days: z.number().int().min(1).max(7).optional() })
  .strict();

export const ClaimPackView = z.object({
  id: z.uuid(),
  status: z.enum(['queued', 'running', 'done', 'failed', 'expired']),
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  bytes: z.number().int().optional(),
  error: z.string().optional(),
  link: z
    .object({
      expiresAt: z.string(),
      downloads: z.number().int(),
      lastDownloadedAt: z.string().nullable(),
    })
    .nullable(),
  expiresAt: z.string(),
});
export type ClaimPackView = z.infer<typeof ClaimPackView>;

/** What the job needs besides the run: the reader's language, and the day the report is as of.
 * Not rights: the job reads everything as the creator (jobs/boss.ts). */
export type ClaimPackJobData = {
  runId: string;
  locale: 'en' | 'ar';
  digits: 'western' | 'eastern';
  asOf: string;
};

// ---------------------------------------------------------------------------------------------
// POST /api/v1/claim-packs
// ---------------------------------------------------------------------------------------------

async function checkPackRate(client: pg.ClientBase): Promise<void> {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('kept.claim_pack:' || kept.current_user_id()::text, 0))`,
  );
  const { rows } = await client.query<{ n: number; oldest: Date | null }>(
    `SELECT count(*)::int AS n, min(created_at) AS oldest FROM public.export_runs
      WHERE created_by = kept.current_user_id()
        AND created_at > now() - make_interval(secs => $1)`,
    [PACK_RATE_WINDOW_SECONDS],
  );
  const { n = 0, oldest = null } = rows[0] ?? {};
  if (n >= PACK_RATE_LIMIT) {
    const retryAfter = oldest
      ? Math.max(
          1,
          Math.ceil((oldest.getTime() + PACK_RATE_WINDOW_SECONDS * 1000 - Date.now()) / 1000),
        )
      : PACK_RATE_WINDOW_SECONDS;
    throw new AppError(
      'rate_limited',
      429,
      `At most ${PACK_RATE_LIMIT} claim packs an hour. Try again later.`,
      { retryAfter },
    );
  }
}

export async function createClaimPack(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  jobs: JobQueue,
  body: CreateClaimPackBody,
  requestId: string,
): Promise<{ id: string; status: 'queued' }> {
  if (body.acknowledged !== true) {
    throw invalid(
      'Send acknowledged: true once the "this includes prices and documents" warning was shown.',
    );
  }
  let locationId: string;
  let incidentId: string | null = null;
  let thingIds: string[] | null = null;
  if ('incidentId' in body.scope) {
    const { rows } = await client.query<{ id: string; location_id: string }>(
      'SELECT id, location_id FROM public.incidents WHERE id = $1',
      [body.scope.incidentId.toLowerCase()],
    );
    const found = rows[0];
    if (!found) throw notFound();
    locationId = found.location_id;
    incidentId = found.id;
  } else {
    locationId = body.scope.locationId.toLowerCase();
  }
  const me = await requireMembership(client, locationId);
  requireCan(me.role, 'incidents.manage', 'Only owners and admins can build a claim pack.');
  if ('thingIds' in body.scope) {
    thingIds = [...new Set(body.scope.thingIds.map((t) => t.toLowerCase()))];
    const { rows } = await client.query(
      'SELECT 1 FROM public.things WHERE id = ANY ($1::uuid[]) AND location_id = $2',
      [thingIds, locationId],
    );
    if (rows.length !== thingIds.length) {
      throw invalid('Check body.scope.thingIds: every thing must be in the location.');
    }
  }
  await checkPackRate(client);
  const { rows: profile } = await client.query<{ locale: string; digits: 'western' | 'eastern' }>(
    'SELECT locale, digits FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  const locale = reportLocaleOf(body.locale ?? profile[0]?.locale);
  const digits = body.digits ?? profile[0]?.digits ?? (locale === 'ar' ? 'eastern' : 'western');
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.export_runs (location_id, kind, incident_id, thing_ids, created_by)
     VALUES ($1, 'claim_pack', $2, $3::uuid[], kept.current_user_id())
     RETURNING id`,
    [locationId, incidentId, thingIds],
  );
  const id = (rows[0] as { id: string }).id;
  await audited(tx, {
    locationId,
    actor: { type: 'user', id: scope.userId },
    action: 'claim_pack.create',
    entity: { type: 'export_run', id },
    before: null,
    after: {
      scope: incidentId ? 'incident' : 'things',
      ...(incidentId ? { incident_id: incidentId } : {}),
      ...(thingIds ? { thing_count: thingIds.length } : {}),
      locale,
    },
    subjects: thingIds ?? [],
    requestId,
  });
  const data: ClaimPackJobData = { runId: id, locale, digits, asOf: await todayFor(client) };
  await jobs.sendTenant(client, 'claim-pack', data);
  return { id, status: 'queued' };
}

// ---------------------------------------------------------------------------------------------
// GET /api/v1/claim-packs/:id, and the link
// ---------------------------------------------------------------------------------------------

type RunRow = {
  id: string;
  location_id: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  progress_done: number;
  progress_total: number;
  bytes: string | number | null;
  error: string | null;
  token_hash: string | null;
  token_expires_at: Date | null;
  revoked_at: Date | null;
  downloads: number;
  last_downloaded_at: Date | null;
  created_at: Date;
  expires_at: Date;
};

/** The creator's run (the policies: anyone else's, or one they no longer administer, is a 404). */
async function readRun(client: pg.ClientBase, id: string, lock = false): Promise<RunRow> {
  const { rows } = await client.query<RunRow>(
    `SELECT id, location_id, status, progress_done, progress_total, bytes, error, token_hash,
            token_expires_at, revoked_at, downloads, last_downloaded_at, created_at, expires_at
       FROM public.export_runs WHERE id = $1 AND kind = 'claim_pack'${lock ? ' FOR UPDATE' : ''}`,
    [id.toLowerCase()],
  );
  const run = rows[0];
  if (!run) throw notFound();
  return run;
}

function statusOf(run: RunRow): ClaimPackView['status'] {
  if (run.status === 'done' && run.expires_at.getTime() <= Date.now()) return 'expired';
  if (run.status === 'running' && Date.now() - run.created_at.getTime() > STALE_RUNNING_MS) {
    return 'failed';
  }
  return run.status;
}

export async function claimPackView(client: pg.ClientBase, id: string): Promise<ClaimPackView> {
  const run = await readRun(client, id);
  const status = statusOf(run);
  const view: ClaimPackView = {
    id: run.id,
    status,
    progress: { done: run.progress_done, total: run.progress_total },
    link:
      run.token_hash && !run.revoked_at && run.token_expires_at && status === 'done'
        ? {
            expiresAt: run.token_expires_at.toISOString(),
            downloads: run.downloads,
            lastDownloadedAt: run.last_downloaded_at?.toISOString() ?? null,
          }
        : null,
    expiresAt: run.expires_at.toISOString(),
  };
  if (status === 'done') view.bytes = Number(run.bytes ?? 0);
  if (status === 'failed')
    view.error = run.status === 'failed' ? (run.error ?? 'failed') : 'timeout';
  return view;
}

/** The sha256 of a link token, as stored (hex). */
export const tokenHash = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

export async function createPackLink(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  id: string,
  days: number,
  publicUrl: string,
  requestId: string,
): Promise<{ url: string; expiresAt: string }> {
  const run = await readRun(client, id, true);
  if (statusOf(run) !== 'done') throw conflict('The claim pack is not ready, or has expired.');
  const token = randomBytes(32).toString('base64url');
  const wanted = Date.now() + days * 24 * 3600 * 1000;
  const expiresAt = new Date(Math.min(wanted, run.expires_at.getTime()));
  await client.query(
    `UPDATE public.export_runs SET token_hash = $2, token_expires_at = $3, revoked_at = NULL
      WHERE id = $1`,
    [run.id, tokenHash(token), expiresAt],
  );
  await audited(tx, {
    locationId: run.location_id,
    actor: { type: 'user', id: scope.userId },
    action: 'claim_pack.link',
    entity: { type: 'export_run', id: run.id },
    // Never the token (nor its hash): only that a link now exists, and until when.
    before: { link_expires_at: run.revoked_at ? null : run.token_expires_at },
    after: { link_expires_at: expiresAt },
    requestId,
  });
  return { url: `${publicUrl.replace(/\/+$/, '')}/x/${token}`, expiresAt: expiresAt.toISOString() };
}

export async function revokePackLink(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  id: string,
  requestId: string,
): Promise<void> {
  const run = await readRun(client, id, true);
  if (!run.token_hash || run.revoked_at) throw notFound('The claim pack has no link to revoke.');
  await client.query('UPDATE public.export_runs SET revoked_at = now() WHERE id = $1', [run.id]);
  await audited(tx, {
    locationId: run.location_id,
    actor: { type: 'user', id: scope.userId },
    action: 'claim_pack.link_revoke',
    entity: { type: 'export_run', id: run.id },
    before: { link_expires_at: run.token_expires_at },
    after: { link_expires_at: null },
    requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// The `claim-pack` job
// ---------------------------------------------------------------------------------------------

export type ClaimPackDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  files: FileStorage | null;
  publicUrl: string;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  render?: { memoryMb?: number; timeoutMs?: number };
  now?: () => Date;
};

export type ClaimPackOutcome =
  | { status: 'done'; bytes: number; files: number }
  | { status: 'failed'; error: string }
  | { status: 'skipped' };

type Entry = { name: string; key: string; bytes: number | null };

/** A name for a ZIP entry: what the person called it, without anything a file system reads as
 * structure (separators, dots at the start, control characters), at most 60 characters. */
export function safeName(name: string, fallback: string): string {
  const visible = Array.from(name.normalize('NFC'), (c) => {
    const code = c.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f ? ' ' : c;
  }).join('');
  const cleaned = visible
    .replace(/[<>:"/\\|?*]+/g, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60)
    .trim();
  return cleaned === '' ? fallback : cleaned;
}

const extOf = (fileId: string, mime: string) =>
  downloadName(fileId, mime, 'original').split('.').pop() ?? 'bin';

class PackError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PackError';
  }
}

/** The files a pack holds, read as the creator. */
async function entriesOf(
  client: pg.ClientBase,
  things: readonly { id: string; name: string; shortCode: string | null }[],
  incidentId: string | null,
): Promise<Entry[]> {
  const out: Entry[] = [];
  const used = new Set<string>();
  const unique = (name: string) => {
    let n = name;
    for (let i = 2; used.has(n.toLowerCase()); i++) {
      const dot = name.lastIndexOf('.');
      n = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
    }
    used.add(n.toLowerCase());
    return n;
  };
  for (const t of things) {
    const dir = `things/${safeName(t.name, 'thing')} (${t.shortCode ?? t.id.slice(0, 8)})`;
    // The purchase's receipts and invoices (originals, members and above: the creator is an
    // owner or admin), and any receipt or invoice on the thing itself.
    const { rows: receipts } = await client.query<{
      file_id: string;
      storage_key: string;
      mime: string;
      bytes: string;
    }>(
      `SELECT r.file_id, f.storage_key, f.mime, f.bytes::text AS bytes
         FROM kept.thing_receipts($1) r
         CROSS JOIN LATERAL kept.thing_receipt_file($1, r.file_id) f
       UNION
       SELECT fl.id, fl.storage_key, fl.mime, fl.bytes::text
         FROM public.attachments a JOIN public.files fl ON fl.id = a.file_id
        WHERE a.thing_id = $1 AND a.role IN ('receipt', 'invoice')
       ORDER BY 1`,
      [t.id],
    );
    receipts.forEach((r, i) => {
      out.push({
        name: unique(`${dir}/receipt-${i + 1}.${extOf(r.file_id, r.mime)}`),
        key: r.storage_key,
        bytes: Number(r.bytes),
      });
    });
    // Photos: the display rendition (GPS stripped, rotated), not the original.
    const { rows: photos } = await client.query<{ storage_key: string; bytes: string }>(
      `SELECT d.storage_key, d.bytes::text AS bytes FROM public.attachments a
         JOIN public.file_derivatives d ON d.file_id = a.file_id AND d.variant = 'display'
        WHERE a.thing_id = $1 AND a.role = 'photo'
        ORDER BY a.sort, a.created_at, a.id`,
      [t.id],
    );
    photos.forEach((p, i) => {
      out.push({
        name: unique(`${dir}/photo-${i + 1}.jpg`),
        key: p.storage_key,
        bytes: Number(p.bytes),
      });
    });
  }
  if (incidentId) {
    const { rows: docs } = await client.query<{
      id: string;
      storage_key: string;
      mime: string;
      bytes: string;
    }>(
      `SELECT f.id, f.storage_key, f.mime, f.bytes::text AS bytes FROM public.attachments a
         JOIN public.files f ON f.id = a.file_id
        WHERE a.incident_id = $1
        ORDER BY a.sort, a.id`,
      [incidentId],
    );
    docs.forEach((d, i) => {
      out.push({
        name: unique(`incident/document-${i + 1}.${extOf(d.id, d.mime)}`),
        key: d.storage_key,
        bytes: Number(d.bytes),
      });
    });
  }
  if (out.length > MAX_PACK_FILES) throw new PackError('too_many_files');
  return out;
}

/** serials.csv: one row per thing, formula-safe (D169). */
function serialsCsv(
  things: readonly {
    id: string;
    shortCode: string | null;
    name: string;
    brand: string | null;
    model: string | null;
    serial: string | null;
  }[],
): string {
  const header = ['id', 'short_id', 'name', 'brand', 'model', 'serial'];
  const lines = things.map((t) =>
    [t.id, t.shortCode ?? '', t.name, t.brand ?? '', t.model ?? '', t.serial ?? '']
      .map(safeCsvCell)
      .join(','),
  );
  return `${[header.join(','), ...lines].join('\r\n')}\r\n`;
}

async function finish(
  deps: ClaimPackDeps,
  scope: Scope,
  id: string,
  outcome: { bytes: number } | { error: string },
): Promise<boolean> {
  try {
    await withScope(deps.pools.app, scope, (_tx, c) =>
      c.query('SELECT kept.export_run_finish($1, $2, $3, $4)', [
        id,
        'bytes' in outcome ? outcome.bytes : null,
        'bytes' in outcome ? 'done' : 'failed',
        'error' in outcome ? outcome.error : null,
      ]),
    );
    return true;
  } catch (err) {
    if (pgErrorOf(err)?.code === '42501') return false;
    throw err;
  }
}

/**
 * One run of the `claim-pack` job, in `scope` (the creator's, from the tenant job). A run that is
 * gone, not queued, or whose creator no longer administers the location is skipped (the claim
 * door's 42501).
 */
export async function buildClaimPack(
  deps: ClaimPackDeps,
  scope: Scope,
  data: ClaimPackJobData,
): Promise<ClaimPackOutcome> {
  const now = deps.now ?? (() => new Date());
  const runId = data.runId.toLowerCase();
  let claimed: {
    location_id: string;
    incident_id: string | null;
    thing_ids: string[] | null;
    created_by: string;
  } | null;
  try {
    claimed = await withScope(deps.pools.app, scope, async (_tx, c) => {
      const { rows } = await c.query<{
        location_id: string;
        incident_id: string | null;
        thing_ids: string[] | null;
        created_by: string;
      }>('SELECT location_id, incident_id, thing_ids, created_by FROM kept.export_run_claim($1)', [
        runId,
      ]);
      return rows[0] ?? null;
    });
  } catch (err) {
    if (pgErrorOf(err)?.code === '42501') return { status: 'skipped' };
    throw err;
  }
  if (!claimed) return { status: 'skipped' };
  const files = deps.files;
  if (!files) {
    await finish(deps, scope, runId, { error: 'no_storage' });
    return { status: 'failed', error: 'no_storage' };
  }
  if (!claimed.incident_id && !claimed.thing_ids) {
    // Its incident was deleted before the job ran: nothing is left to pack.
    await finish(deps, scope, runId, { error: 'scope_gone' });
    return { status: 'failed', error: 'scope_gone' };
  }

  const publicUrl = deps.publicUrl.replace(/\/+$/, '');
  let dir: string | null = null;
  try {
    const options: InsuranceOptions = {
      kind: 'insurance',
      locationId: claimed.location_id,
      incidentId: claimed.incident_id,
      asOf: data.asOf,
      reportCurrency: null,
      include: { photos: true },
      locale: data.locale === 'ar' ? 'ar' : 'en',
      digits: data.digits === 'eastern' ? 'eastern' : 'western',
    };
    const { prepared, entries, things } = await withScope(deps.pools.app, scope, async (tx, c) => {
      const p = await prepareInsurance(
        tx,
        c,
        scope,
        { ...options, ...(claimed.thing_ids ? { thingIds: claimed.thing_ids } : {}) },
        { publicUrl, now },
      );
      const t = p.things as unknown as {
        id: string;
        name: string;
        shortCode: string | null;
        brand: string | null;
        model: string | null;
        serial: string | null;
      }[];
      return { prepared: p, entries: await entriesOf(c, t, claimed.incident_id), things: t };
    });
    const total = entries.length + 2;
    const progress = (done: number) =>
      withScope(deps.pools.app, scope, (_tx, c) =>
        c.query('SELECT kept.export_run_progress($1, $2, $3)', [
          runId,
          Math.min(done, total),
          total,
        ]),
      );
    await progress(0);

    await mkdir(files.tmpDir, { recursive: true });
    dir = await mkdtemp(path.join(files.tmpDir, 'claim-pack-'));
    const rendered = await renderPrepared(files, path.join(dir, 'report'), prepared, {
      publicUrl,
      log: deps.log,
      render: deps.render ?? {},
    });

    const zip = new yazl.ZipFile();
    const zipPath = path.join(dir, 'pack.zip');
    const written = pipeline(zip.outputStream, createWriteStream(zipPath));
    const mtime = now();
    const stored = { compress: false, mtime };
    zip.addFile(rendered.file, 'report.pdf', stored);
    zip.addBuffer(Buffer.from(serialsCsv(things), 'utf8'), 'serials.csv', stored);
    let done = 1;
    for (const e of entries) {
      zip.addReadStreamLazy(
        e.name,
        { ...stored, ...(e.bytes !== null ? { size: e.bytes } : {}) },
        (cb) => {
          files.blobs.stream(e.key).then(
            (s) => {
              done += 1;
              if (done % PROGRESS_EVERY === 0) {
                progress(done).catch((err: unknown) =>
                  deps.log.error({ err, runId }, 'claim pack: progress not written'),
                );
              }
              cb(null, s);
            },
            (err: unknown) => cb(err, undefined as unknown as NodeJS.ReadableStream),
          );
        },
      );
    }
    zip.end();
    await written;
    const { size } = await stat(zipPath);
    const key = exportKey(runId);
    await files.blobs.put(key, zipPath, { contentType: 'application/zip', bytes: size });
    if (!(await finish(deps, scope, runId, { bytes: size }))) {
      // Purged, or its creator lost the role, while it was built: nothing may serve it.
      await files.blobs.delete(key);
      return { status: 'skipped' };
    }
    await withSystem(deps.pools.system, (_tx, c) =>
      c.query(
        `INSERT INTO public.notifications (user_id, location_id, kind, payload)
         VALUES ($1, $2, 'export_ready', $3::jsonb)`,
        [claimed.created_by, claimed.location_id, JSON.stringify({ runId, kind: 'claim_pack' })],
      ),
    ).catch((err: unknown) => deps.log.error({ err, runId }, 'claim pack: notice not written'));
    deps.log.info({ runId, files: entries.length, bytes: size }, 'claim pack built');
    return { status: 'done', bytes: size, files: entries.length };
  } catch (err) {
    const code =
      err instanceof PackError
        ? err.code
        : typeof (err as { code?: unknown })?.code === 'string' &&
            ['timeout', 'memory', 'render'].includes((err as { code: string }).code)
          ? (err as { code: string }).code
          : (err as { name?: string })?.name === 'TooManyThingsError'
            ? 'too_many_things'
            : 'internal';
    await finish(deps, scope, runId, { error: code }).catch(() => false);
    if (code !== 'internal') return { status: 'failed', error: code };
    throw err;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// The purge
// ---------------------------------------------------------------------------------------------

const PURGE_BATCH = 500;
const PURGE_ROUNDS = 100;

/** Runs past their 7 days become `expired` (kept.purge_expired_exports, kept_system's door),
 * then their ZIPs are deleted. A blob that won't delete is logged and named. */
export async function purgeExpiredExports(deps: {
  pools: Pick<Pools, 'system'>;
  files: FileStorage | null;
  log: ClaimPackDeps['log'];
}): Promise<{ packs: number; failedBlobs: string[] }> {
  const out = { packs: 0, failedBlobs: [] as string[] };
  if (!deps.files) {
    deps.log.info(
      {},
      'purge-exports: no file storage configured for this worker; left for one that has it',
    );
    return out;
  }
  for (let round = 0; round < PURGE_ROUNDS; round++) {
    const keys = await withSystem(deps.pools.system, async (_tx, c) => {
      const { rows } = await c.query<{ key: string }>(
        'SELECT k AS key FROM kept.purge_expired_exports($1) AS k',
        [PURGE_BATCH],
      );
      return rows.map((r) => r.key);
    });
    out.packs += keys.length;
    for (const key of keys) {
      try {
        await deps.files.blobs.delete(key);
      } catch (err) {
        out.failedBlobs.push(key);
        deps.log.error({ err, key }, 'purge-exports: a claim pack could not be deleted');
      }
    }
    if (keys.length < PURGE_BATCH) break;
  }
  return out;
}
