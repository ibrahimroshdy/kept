import type pg from 'pg';
import { withScope } from '../db/scope.js';
import type { JobQueue } from '../jobs/queue.js';
import { PDF_TEXT_JOB } from './pdf-text.js';

// `kept admin backfill-pdf-text` (T21 follow-up): the `pdf-text` job for every PDF uploaded
// before the upload started sending it (f595aab), so their text reaches document search and PDF
// receipts.
//
// Batched and idempotent:
// - the candidates are read as kept_owner (no tenant's policies apply to it), `batch` at a time
//   in file-id order: PDFs in a live location with no `file_text` row and no `pdf-text` job
//   waiting, running or completed for them, so a second run queues nothing the first did;
// - each is queued as a tenant job, as the upload does (files/upload.ts): on a kept_app
//   transaction scoped to someone who may write in the file's location, since the job re-reads
//   the file under row-level security and ends when its user may not (pdf-text.ts). That is the
//   uploader while they still may write there; else, for a file attached to something (which
//   every member then sees), the owner, else an admin or member. An unattached file is seen only
//   by its uploader (files' `app_select`), so once they may not write, no job could read it: it
//   is counted, not queued. The scope's second factor is the location's `require_2fa`: the
//   upload itself needed one there;
// - a PDF whose job completed without a row (a scan, an encrypted or unreadable file) is not
//   queued again while pg-boss keeps that completed job; after it is deleted, a run reads it
//   again and changes nothing. A failed job (the blob store or the database failing) is queued
//   again.

export type PdfBackfillDeps = {
  /** A kept_owner connection: reads the candidates across every location. */
  owner: pg.Pool | pg.ClientBase;
  /** kept_app: the scoped transactions the jobs are sent on. */
  app: pg.Pool;
  queue: Pick<JobQueue, 'sendTenant'>;
};

export type PdfBackfillOptions = {
  /** Files read and queued per batch. */
  batch: number;
  /** Count only; queue nothing. */
  dryRun?: boolean;
};

export type PdfBackfillReport = {
  /** PDFs found with no text and no job. */
  found: number;
  /** Jobs sent (0 on a dry run). */
  queued: number;
  /** PDFs no one who may write in their location can see (an unattached file whose uploader
   * may no longer write there): no job could read them. */
  noWriter: number;
  batches: number;
};

/** Batch sizes the command accepts. */
export const BACKFILL_BATCH_MAX = 1000;
export const BACKFILL_BATCH_DEFAULT = 200;

type Candidate = {
  id: string;
  location_id: string;
  writer: string | null;
  require_2fa: boolean;
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

async function candidates(
  owner: PdfBackfillDeps['owner'],
  after: string,
  limit: number,
): Promise<Candidate[]> {
  const { rows } = await owner.query<Candidate>(
    `SELECT f.id, f.location_id, l.require_2fa,
            (SELECT m.user_id FROM public.memberships m
              WHERE m.location_id = f.location_id
                AND m.role IN ('owner', 'admin', 'member')
                AND (m.expires_at IS NULL OR m.expires_at > now())
                AND (m.user_id = f.created_by
                     OR EXISTS (SELECT 1 FROM public.attachments a WHERE a.file_id = f.id))
              ORDER BY (m.user_id = f.created_by) DESC,
                       CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                       m.user_id
              LIMIT 1) AS writer
       FROM public.files f
       JOIN public.locations l ON l.id = f.location_id
      WHERE f.id > $1::uuid
        AND f.mime = 'application/pdf'
        AND l.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.file_text x WHERE x.file_id = f.id)
        AND NOT EXISTS (
              SELECT 1 FROM pgboss.job j
               WHERE j.name = $3
                 AND j.state IN ('created', 'retry', 'active', 'completed')
                 AND j.data -> 'data' ->> 'fileId' = f.id::text)
      ORDER BY f.id
      LIMIT $2`,
    [after, limit, PDF_TEXT_JOB],
  );
  return rows;
}

/** Queues `pdf-text` for every PDF with no text, `opts.batch` at a time. */
export async function backfillPdfText(
  deps: PdfBackfillDeps,
  opts: PdfBackfillOptions,
  say: (line: string) => void = () => {},
): Promise<PdfBackfillReport> {
  if (!Number.isInteger(opts.batch) || opts.batch < 1 || opts.batch > BACKFILL_BATCH_MAX) {
    throw new RangeError(`batch must be a whole number from 1 to ${BACKFILL_BATCH_MAX}`);
  }
  const report: PdfBackfillReport = { found: 0, queued: 0, noWriter: 0, batches: 0 };
  let after = NIL_UUID;
  for (;;) {
    const rows = await candidates(deps.owner, after, opts.batch);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]?.id ?? after;
    report.batches += 1;
    report.found += rows.length;

    // One scoped transaction per sender in the batch; the jobs exist only if it commits.
    const bySender = new Map<string, { userId: string; mfa: boolean; fileIds: string[] }>();
    for (const row of rows) {
      if (!row.writer) {
        report.noWriter += 1;
        continue;
      }
      const key = `${row.writer}:${row.require_2fa}`;
      const group = bySender.get(key) ?? { userId: row.writer, mfa: row.require_2fa, fileIds: [] };
      group.fileIds.push(row.id);
      bySender.set(key, group);
    }
    let queued = 0;
    if (!opts.dryRun) {
      for (const group of bySender.values()) {
        await withScope(deps.app, { userId: group.userId, mfa: group.mfa }, async (_tx, client) => {
          for (const fileId of group.fileIds) {
            await deps.queue.sendTenant(client, PDF_TEXT_JOB, { fileId });
          }
        });
        queued += group.fileIds.length;
      }
    }
    report.queued += queued;
    say(
      opts.dryRun
        ? `Batch ${report.batches}: ${rows.length} PDFs with no text (dry run, nothing queued).`
        : `Batch ${report.batches}: queued ${queued} of ${rows.length} PDFs with no text.`,
    );
    if (rows.length < opts.batch) break;
  }
  return report;
}
