/**
 * The `extract` tenant job (plan T10; D19, D94, D121, D166, D206; engineering spec §7.8, §7.15;
 * Q4, Q12, Q13). One per capture (a receipt's per purchase, Q13), sent by the capture service in
 * its own transaction with `{extractionId}` only, and run in the capturing person's scope: the
 * handler re-reads everything under row-level security (the rule in jobs/boss.ts), so a job
 * naming someone else's extraction finds nothing and ends.
 *
 * 1. **Claim** (one short transaction): the extraction, locked; gone or no longer writable → done.
 *    Only `queued`, `paused_budget`, `waiting_provider` (a re-sent pause) and a `running` one left
 *    behind by a crashed worker (untouched for the job's 90 s expiry) run; anything else was
 *    superseded or replayed. AI capture must be effective in the location and allowed to the
 *    person (`ai.capture`), else `no_provider`: the capture stays an ordinary draft (D19). On, but
 *    with no provider resolving: `waiting_provider` / `no_provider` until one is connected. Then
 *    `running`, committed **before any AI work** (D166).
 * 2. **Parts** (image.ts, no transaction): GPS-free images, or a PDF receipt's text. A draft
 *    service record's invoice (step 5, Q12) is a RECEIPT read with the service-invoice prompt
 *    and schema (each line's kind), from the record's `invoice` pages; apply.ts only suggests.
 * 3. **The call** (`extract()`, T8): the mode's prompt and wire schema, the ledger task
 *    `extract_<mode>`, the prompt version, the job id as the request id and the retry as the
 *    attempt, and the links (extraction, thing, attachments). Resolution, pacing, the budgets and
 *    the ledger row are callModel's (ai/call.ts), each door in its own short transaction.
 * 4. **The outcome**, in one transaction:
 *    - ok → checks.ts, apply.ts, duplicates.ts, and `succeeded` with `result`, `applied` and
 *      `llm_call_id`; a receipt's paper crop (Q11) after it commits.
 *    - a cap → `paused_budget` until the cap's date, with the cap's reason, and the job is sent
 *      again for that time. A manual pause (`infinity`) waits for Resume, which re-sends it (T9).
 *    - the provider → `waiting_provider` (never shown as paused, D206) until its reset,
 *      retry-after or breaker time, and sent again then. A rejected key waits for a new one.
 *    - Neither pause spends an attempt: the re-sent job starts its own retries.
 *    - a retryable failure → `queued` and a throw, so pg-boss retries (JOB_POLICIES.extract);
 *      after the last retry, `failed`.
 *    - a final failure → `failed` with the outcome as the reason (`truncated`, `schema_invalid`,
 *      `refused`…): the inbox shows "Couldn't read this photo" with Retry (§5).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { type CaptureMode, can, type Role } from '@kept/shared';
import type pg from 'pg';
import sharp from 'sharp';
import { FOREVER } from '../ai/breaker.js';
import type { CallResult } from '../ai/call.js';
import { toDbTime } from '../ai/db-run.js';
import { type Extracted, extract } from '../ai/extract.js';
import type { AiDeps } from '../ai/routes.js';
import { audited } from '../audit/audited.js';
import { aiCaptureState, NO_PROVIDER } from '../capture/service.js';
import type { Pools } from '../db/pools.js';
import { type Scope, withScope } from '../db/scope.js';
import { lockBlobKeys } from '../files/blob-locks.js';
import { defineJob, type JobDefinition, type JobMeta } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import { derivativeKey, type FileStorage, originalKey } from '../storage/blob-store.js';
import { LIMIT_INPUT_PIXELS, VARIANT_SIZES } from '../storage/derivatives.js';
import { type ApplyResult, apply, type ExtractionRow } from './apply.js';
import { type CheckContext, type Checked, check } from './checks.js';
import { openDuplicate } from './duplicates.js';
import { MAX_RECEIPT_PAGES, partsFor, type SourceFile } from './image.js';
import { PROMPT_VERSIONS, promptFor } from './prompts/index.js';
import {
  PROMPT_VERSION as SERVICE_INVOICE_VERSION,
  serviceInvoicePrompt,
} from './prompts/service-invoice.js';

export const EXTRACT_JOB = 'extract';

/** How long a `running` extraction is left alone: the job's expiry (JOB_POLICIES.extract). */
const STALE_RUNNING_SECONDS = JOB_POLICIES.extract.expireInSeconds;

export type ExtractionJobDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  ai: AiDeps | null;
  files: FileStorage | null;
  /** Sends `extract` again for `startAfter`, on the given scoped transaction (a pause). */
  sendLater: (client: pg.ClientBase, extractionId: string, startAfter: Date) => Promise<void>;
  log: { info: (obj: object, msg: string) => void; error: (obj: object, msg: string) => void };
  /** Re-crop a receipt's display to the paper the model outlined (Q11). Off in the worker: a
   * real run (Groq, 2026-09-29) outlined [0, 0, 0.7, 0.6] for a receipt filling the photo, which
   * would crop the display wrongly. On once the evaluation set (T11) shows bboxes are right. */
  cropToPaper?: boolean;
};

/** What a run ended as (the tests read it; the job logs it). */
export type RunOutcome =
  | { status: 'skipped'; why: 'missing' | 'not_runnable' }
  | { status: 'no_provider' }
  | { status: 'succeeded'; callId: string; result: ApplyResult; checked: Checked }
  | { status: 'paused_budget' | 'waiting_provider'; until: Date; reason: string; resent: boolean }
  | { status: 'failed'; reason: string };

/** Waiting for a provider to be connected: no end of its own, and nothing is sent again. */
const waitingForProvider = (): RunOutcome => ({
  status: 'waiting_provider',
  until: FOREVER,
  reason: NO_PROVIDER,
  resent: false,
});

/** Thrown for pg-boss to retry the job; the extraction is back to `queued`. */
export class RetryExtraction extends Error {
  constructor(readonly reason: string) {
    super(`extraction will be retried: ${reason}`);
    this.name = 'RetryExtraction';
  }
}

const EXTRACTION_COLUMNS = `e.id, e.location_id, e.attachment_id, e.thing_id, e.purchase_id,
  e.meter_id, e.service_record_id, e.mode, e.attempt, e.status, e.requested_by, e.created_at`;

type Claimed = {
  ex: ExtractionRow;
  files: SourceFile[];
  texts: Map<string, string>;
  checkCtx: CheckContext;
  languages: string[];
  meter: { kind: string; unit: string } | null;
  thingId: string | null;
};

async function roleIn(client: pg.ClientBase, locationId: string): Promise<Role | null> {
  const { rows } = await client.query<{ role: Role }>(
    `SELECT role FROM public.memberships
      WHERE location_id = $1 AND user_id = kept.current_user_id()
        AND (expires_at IS NULL OR expires_at > now())`,
    [locationId],
  );
  return rows[0]?.role ?? null;
}

/** The location's languages (D41): its own list, else its owner's locale, else the person's,
 * else English. Base codes only. */
export async function languagesOf(client: pg.ClientBase, locationId: string): Promise<string[]> {
  const { rows } = await client.query<{ languages: string[]; owner_locale: string | null }>(
    `SELECT l.languages,
            (SELECT up.locale FROM public.memberships m
               JOIN public.user_profiles up ON up.user_id = m.user_id
              WHERE m.location_id = l.id AND m.role = 'owner' LIMIT 1) AS owner_locale
       FROM public.locations l WHERE l.id = $1`,
    [locationId],
  );
  const r = rows[0];
  const base = (code: string) => code.toLowerCase().split('-')[0] as string;
  const own = [...new Set((r?.languages ?? []).map(base).filter((c) => /^[a-z]{2,3}$/.test(c)))];
  if (own.length > 0) return own;
  if (r?.owner_locale) return [base(r.owner_locale)];
  const { rows: me } = await client.query<{ locale: string }>(
    'SELECT locale FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  return [me[0]?.locale ? base(me[0].locale) : 'en'];
}

/** The attachments to send: the extraction's own, or its receipt's pages, that one first (Q13);
 * a service invoice's pages likewise (step 5, Q12). */
async function sourcesOf(client: pg.ClientBase, ex: ExtractionRow): Promise<SourceFile[]> {
  if (ex.mode === 'receipt' && ex.service_record_id !== null) {
    const { rows } = await client.query<{
      attachment_id: string;
      file_id: string;
      location_id: string;
      mime: string;
    }>(
      `SELECT a.id AS attachment_id, f.id AS file_id, f.location_id, f.mime
         FROM public.attachments a JOIN public.files f ON f.id = a.file_id
        WHERE a.service_record_id = $2 AND a.role = 'invoice'
        ORDER BY (a.id = $1) DESC, a.sort, a.created_at, a.id
        LIMIT ${MAX_RECEIPT_PAGES}`,
      [ex.attachment_id, ex.service_record_id],
    );
    return rows.map((r) => ({
      attachmentId: r.attachment_id,
      fileId: r.file_id,
      locationId: r.location_id,
      mime: r.mime,
    }));
  }
  const receipt = ex.mode === 'receipt' && ex.purchase_id !== null;
  const { rows } = await client.query<{
    attachment_id: string;
    file_id: string;
    location_id: string;
    mime: string;
  }>(
    receipt
      ? `SELECT a.id AS attachment_id, f.id AS file_id, f.location_id, f.mime
           FROM public.attachments a JOIN public.files f ON f.id = a.file_id
          WHERE a.purchase_id = $2 AND a.role = 'receipt'
          ORDER BY (a.id = $1) DESC, a.created_at, a.sort, a.id
          LIMIT ${MAX_RECEIPT_PAGES}`
      : `SELECT a.id AS attachment_id, f.id AS file_id, f.location_id, f.mime
           FROM public.attachments a JOIN public.files f ON f.id = a.file_id
          WHERE a.id = $1`,
    receipt ? [ex.attachment_id, ex.purchase_id] : [ex.attachment_id],
  );
  return rows.map((r) => ({
    attachmentId: r.attachment_id,
    fileId: r.file_id,
    locationId: r.location_id,
    mime: r.mime,
  }));
}

type StatusUpdate = {
  status: string;
  reason?: string | null;
  until?: Date | null;
  callId?: string | null;
  result?: unknown;
  applied?: unknown;
};

/** Sets the extraction's status (and what goes with it) unless a re-run superseded it. */
async function setStatus(client: pg.ClientBase, id: string, u: StatusUpdate): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE public.extractions
        SET status = $2, status_reason = $3, paused_until = $4::timestamptz,
            llm_call_id = coalesce($5::uuid, llm_call_id),
            result = coalesce($6::jsonb, result), applied = coalesce($7::jsonb, applied)
      WHERE id = $1 AND status <> 'superseded'`,
    [
      id,
      u.status,
      u.reason ? u.reason.slice(0, 60) : null,
      u.until ? toDbTime(u.until) : null,
      u.callId ?? null,
      u.result === undefined ? null : JSON.stringify(u.result),
      u.applied === undefined ? null : JSON.stringify(u.applied),
    ],
  );
  return (rowCount ?? 0) > 0;
}

/** Step 1: the extraction, if it should run now, marked `running` and committed. */
async function claim(
  deps: ExtractionJobDeps,
  scope: Scope,
  extractionId: string,
): Promise<Claimed | RunOutcome> {
  return withScope(deps.pools.app, scope, async (tx, client) => {
    // FOR UPDATE passes only rows the UPDATE policy allows: a location the person can no longer
    // write in reads as missing, like one they never could.
    const { rows } = await client.query<ExtractionRow & { stale: boolean }>(
      `SELECT ${EXTRACTION_COLUMNS},
              e.updated_at < now() - make_interval(secs => $2) AS stale
         FROM public.extractions e WHERE e.id = $1 FOR UPDATE`,
      [extractionId, STALE_RUNNING_SECONDS],
    );
    const ex = rows[0];
    if (!ex) return { status: 'skipped', why: 'missing' } as const;
    const runnable =
      ['queued', 'paused_budget', 'waiting_provider'].includes(ex.status) ||
      (ex.status === 'running' && ex.stale);
    if (!runnable) return { status: 'skipped', why: 'not_runnable' } as const;

    // A capture undone into the trash before its photo was read (a waiting one, sent when a key
    // is saved) isn't read: the name would have nowhere to go. It ends as a plain draft, which
    // the inbox's "Name N unnamed photos" offers to name if the thing is restored.
    if (ex.thing_id) {
      const { rows: t } = await client.query<{ trashed: boolean }>(
        'SELECT deleted_at IS NOT NULL AS trashed FROM public.things WHERE id = $1',
        [ex.thing_id],
      );
      if (t[0]?.trashed) {
        await setStatus(client, ex.id, { status: 'no_provider' });
        return { status: 'no_provider' } as const;
      }
    }

    const role = await roleIn(client, ex.location_id);
    const state =
      role !== null && can(role, 'ai.capture') && deps.ai !== null
        ? await aiCaptureState(tx, client, ex.location_id, role)
        : 'off';
    if (state === 'waiting') {
      // AI capture is on here but no provider resolves (yet, or any more): it waits for one to
      // be connected, which sends it again (ai/api.ts), rather than ending as a plain draft.
      await setStatus(client, ex.id, { status: 'waiting_provider', reason: NO_PROVIDER });
      return waitingForProvider();
    }
    if (state === 'off') {
      await setStatus(client, ex.id, { status: 'no_provider' });
      return { status: 'no_provider' } as const;
    }
    await setStatus(client, ex.id, { status: 'running' });

    const files = await sourcesOf(client, ex);
    const texts = new Map<string, string>();
    const pdfs = files.filter((f) => f.mime === 'application/pdf').map((f) => f.fileId);
    if (pdfs.length > 0) {
      const { rows: t } = await client.query<{ file_id: string; text: string }>(
        'SELECT file_id, text FROM public.file_text WHERE file_id = ANY ($1::uuid[])',
        [pdfs],
      );
      for (const r of t) texts.set(r.file_id, r.text);
    }
    const { rows: loc } = await client.query<{ timezone: string }>(
      'SELECT timezone FROM public.locations WHERE id = $1',
      [ex.location_id],
    );
    const { rows: cur } = await client.query<{ code: string }>(
      'SELECT code FROM public.currencies WHERE enabled ORDER BY code',
    );
    let meter: Claimed['meter'] = null;
    let thingId = ex.thing_id;
    if (ex.meter_id) {
      const { rows: m } = await client.query<{ kind: string; unit: string; thing_id: string }>(
        'SELECT kind, unit, thing_id FROM public.meters WHERE id = $1',
        [ex.meter_id],
      );
      if (m[0]) {
        meter = { kind: m[0].kind, unit: m[0].unit };
        thingId ??= m[0].thing_id;
      }
    }
    if (ex.service_record_id) {
      const { rows: r } = await client.query<{ thing_id: string | null }>(
        'SELECT thing_id FROM public.service_records WHERE id = $1',
        [ex.service_record_id],
      );
      thingId ??= r[0]?.thing_id ?? null;
    }
    const languages = await languagesOf(client, ex.location_id);
    return {
      ex,
      files,
      texts,
      languages,
      meter,
      thingId,
      checkCtx: {
        timezone: loc[0]?.timezone ?? 'UTC',
        languages,
        enabledCurrencies: cur.map((c) => c.code.trim()),
      },
    };
  });
}

/** Whether pg-boss runs this job again after a throw. */
const retriesLeft = (job: JobMeta | undefined) =>
  job !== undefined && job.retryCount < job.retryLimit;

/** Step 4 for a failure: back to `queued` and a throw while retries remain, else `failed`. */
async function fail(
  deps: ExtractionJobDeps,
  scope: Scope,
  id: string,
  reason: string,
  retryable: boolean,
  job: JobMeta | undefined,
  callId: string | null,
): Promise<RunOutcome> {
  const again = retryable && retriesLeft(job);
  await withScope(deps.pools.app, scope, (_tx, client) =>
    setStatus(client, id, { status: again ? 'queued' : 'failed', reason, callId }),
  );
  if (again) throw new RetryExtraction(reason);
  return { status: 'failed', reason };
}

async function readBlob(files: FileStorage, key: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await files.blobs.stream(key)) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  return Buffer.concat(chunks);
}

/**
 * Q11: the display and thumb made again from the original, upright and cropped to the paper
 * (the original itself stays byte-identical, D196). Best effort: the extraction has succeeded
 * whatever happens here.
 */
async function cropToPaper(
  deps: ExtractionJobDeps,
  scope: Scope,
  locationId: string,
  crop: NonNullable<ApplyResult['crop']>,
): Promise<void> {
  const files = deps.files;
  if (!files) return;
  const [x, y, w, h] = crop.bbox;
  if (w < 0.2 || h < 0.2 || (w > 0.97 && h > 0.97)) return; // nothing worth cropping
  const upright = await sharp(await readBlob(files, originalKey(locationId, crop.fileId)), {
    limitInputPixels: LIMIT_INPUT_PIXELS,
    autoOrient: true,
  }).toBuffer({ resolveWithObject: true });
  const W = upright.info.width;
  const H = upright.info.height;
  const left = Math.min(W - 1, Math.max(0, Math.floor(x * W)));
  const top = Math.min(H - 1, Math.max(0, Math.floor(y * H)));
  const width = Math.min(W - left, Math.ceil(w * W));
  const height = Math.min(H - top, Math.ceil(h * H));
  if (width < 16 || height < 16) return;
  const dir = await mkdtemp(path.join(files.tmpDir, 'crop-'));
  const variants: { variant: 'display' | 'thumb'; width: number; height: number; bytes: number }[] =
    [];
  try {
    for (const variant of ['display', 'thumb'] as const) {
      const side = VARIANT_SIZES[variant];
      const out = path.join(dir, `${variant}.jpg`);
      const info = await sharp(upright.data, { limitInputPixels: LIMIT_INPUT_PIXELS })
        .extract({ left, top, width, height })
        .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 82 })
        .toFile(out);
      await files.blobs.put(derivativeKey(crop.fileId, variant), out, {
        contentType: 'image/jpeg',
        bytes: info.size,
      });
      variants.push({ variant, width: info.width, height: info.height, bytes: info.size });
    }
    await withScope(deps.pools.app, scope, async (tx, client) => {
      await lockBlobKeys(client, [
        originalKey(locationId, crop.fileId),
        ...variants.map((v) => derivativeKey(crop.fileId, v.variant)),
      ]);
      await client.query('SELECT kept.set_file_display($1, $2)', [
        crop.fileId,
        JSON.stringify(variants),
      ]);
      await audited(tx, {
        locationId,
        actor: { type: 'user', id: scope.userId },
        action: 'file.crop',
        entity: { type: 'file', id: crop.fileId },
        after: { bbox: crop.bbox, variants: variants.map((v) => v.variant) },
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** One run of the job for `extractionId`, in `scope`. */
export async function runExtraction(
  deps: ExtractionJobDeps,
  scope: Scope,
  extractionId: string,
  job?: JobMeta,
): Promise<RunOutcome> {
  const claimed = await claim(deps, scope, extractionId);
  if ('status' in claimed) return claimed;
  const { ex } = claimed;
  const ai = deps.ai as AiDeps;
  const mode: CaptureMode = ex.mode;
  // Step 5 (Q12): a draft service record's invoice, read on the RECEIPT path.
  const invoice = mode === 'receipt' && ex.service_record_id !== null;

  let result: CallResult<Extracted<CaptureMode>> | { status: 'no_provider' };
  let sent: { attachmentIds: string[]; fromDisplay: boolean[] };
  try {
    if (!deps.files) throw new Error('extraction: the worker has no file storage');
    const parts = await partsFor(mode, claimed.files, {
      blobs: deps.files.blobs,
      textOf: async (fileId) => claimed.texts.get(fileId) ?? null,
    });
    if (parts.images.length === 0 && parts.documentText === undefined) {
      // Nothing to send. A PDF whose text isn't read yet (T21) may have it on a retry.
      const pdfWaiting = claimed.files.some((f) => f.mime === 'application/pdf');
      return await fail(
        deps,
        scope,
        ex.id,
        pdfWaiting ? 'no_text' : 'no_image',
        pdfWaiting,
        job,
        null,
      );
    }
    sent = {
      attachmentIds: parts.images.flatMap((i) => (i.attachmentId ? [i.attachmentId] : [])),
      fromDisplay: parts.fromDisplay,
    };
    const promptCtx = {
      languages: claimed.languages,
      pages: parts.images.length,
      ...(parts.documentText !== undefined ? { documentText: parts.documentText } : {}),
      meter: claimed.meter,
    };
    const prompt = invoice ? serviceInvoicePrompt(promptCtx) : promptFor(mode, promptCtx);
    const rt = await ai.runtime(scope);
    result = await extract(rt, {
      mode,
      images: parts.images,
      prompt,
      locationId: ex.location_id,
      userId: scope.userId,
      links: { extractionId: ex.id, ...(claimed.thingId ? { thingId: claimed.thingId } : {}) },
      requestId: (job?.id ?? `extract:${ex.id}`).slice(0, 64),
      attempt: Math.min(20, (job?.retryCount ?? 0) + 1),
      jobId: job?.id ?? ex.id,
      ...(invoice ? { schema: 'service-invoice' as const } : {}),
    });
  } catch (e) {
    if (e instanceof RetryExtraction) throw e;
    deps.log.error({ err: e, extractionId: ex.id }, 'extraction failed before a result');
    // Back to `queued` for pg-boss's retry, or `failed` after the last one; then rethrow so the
    // job's failure is recorded either way.
    await fail(deps, scope, ex.id, 'internal', true, job, null).catch(() => {});
    throw e;
  }

  switch (result.status) {
    case 'no_provider':
      // The provider went between the claim and the call (removed, or its key rejected): the
      // photo waits for the next one, as a capture with none does (claim).
      await withScope(deps.pools.app, scope, (_tx, client) =>
        setStatus(client, ex.id, { status: 'waiting_provider', reason: NO_PROVIDER }),
      );
      return waitingForProvider();
    case 'paused': {
      const status = result.kind === 'cap' ? 'paused_budget' : 'waiting_provider';
      // A manual pause or a rejected key has no end: Resume (T9) or a new key re-sends it.
      const endless = result.until.getTime() >= FOREVER.getTime();
      const paused = result;
      await withScope(deps.pools.app, scope, async (_tx, client) => {
        const ours = await setStatus(client, ex.id, {
          status,
          reason: paused.reason,
          until: paused.until,
          callId: paused.callId ?? null,
        });
        if (ours && !endless) await deps.sendLater(client, ex.id, paused.until);
      });
      return { status, until: result.until, reason: result.reason, resent: !endless };
    }
    case 'failed':
      return fail(deps, scope, ex.id, result.outcome, result.retryable, job, result.callId);
    case 'ok':
      break;
  }

  const ok = result;
  const done = await withScope(deps.pools.app, scope, async (tx, client) => {
    // A re-run may have superseded this attempt while the model was reading.
    const { rows } = await client.query<{ status: string }>(
      'SELECT status FROM public.extractions WHERE id = $1 FOR UPDATE',
      [ex.id],
    );
    if (rows[0]?.status !== 'running') return null;
    const checked = check(mode, ok.value.value as never, ok.value.dropped, claimed.checkCtx);
    const applyCtx = { tx, client, scope, requestId: job?.id ?? ex.id };
    const applied = await apply(applyCtx, ex, checked, sent);
    if ((checked.mode === 'thing' || checked.mode === 'label') && ex.thing_id) {
      const serial = applied.suggestions.find((s) => s.field === 'serial');
      const { rows: t } = await client.query<{ capture_batch_id: string | null }>(
        'SELECT capture_batch_id FROM public.things WHERE id = $1',
        [ex.thing_id],
      );
      const dup = await openDuplicate(
        client,
        { id: ex.thing_id, locationId: ex.location_id, batchId: t[0]?.capture_batch_id ?? null },
        ex.id,
        serial ? String(serial.value) : null,
      );
      if (dup) applied.inbox.push(dup);
    }
    await setStatus(client, ex.id, {
      status: 'succeeded',
      callId: ok.callId,
      result: {
        mode,
        promptVersion: invoice ? SERVICE_INVOICE_VERSION : PROMPT_VERSIONS[mode],
        attachmentIds: sent.attachmentIds,
        fields: checked.fields,
        dropped: checked.dropped,
        suggestions: applied.suggestions,
        ...(applied.flags ? { flags: applied.flags } : {}),
      },
      applied: applied.applied,
    });
    return { checked, applied };
  });
  if (!done) return { status: 'skipped', why: 'not_runnable' };
  if (done.applied.crop && deps.cropToPaper) {
    try {
      await cropToPaper(deps, scope, ex.location_id, done.applied.crop);
    } catch (e) {
      deps.log.error({ err: e, extractionId: ex.id }, 'receipt crop failed');
    }
  }
  return { status: 'succeeded', callId: ok.callId, result: done.applied, checked: done.checked };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `extract` job. Aggregated by jobs/capture.ts; without `deps.ai` every extraction it runs
 * ends `no_provider`. */
export function extractionJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: EXTRACT_JOB,
      kind: 'tenant',
      policy: JOB_POLICIES.extract,
      handler: async ({ data, scope, client, job }) => {
        const extractionId = (data as { extractionId?: unknown } | null)?.extractionId;
        if (typeof extractionId !== 'string' || !UUID.test(extractionId)) {
          throw new Error('extract job: data names no extraction');
        }
        const app = deps.pools.app;
        if (!app) throw new Error('extract job: the worker has no kept_app pool');
        // runJob() holds this scoped transaction open, unused, while each step commits on its
        // own connection; the model call may take up to 80 s (§3.5).
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '180s'`);
        const send = deps.sendTenant;
        const outcome = await runExtraction(
          {
            pools: { app, system: deps.pools.system },
            ai: deps.ai ?? null,
            files: deps.files ?? null,
            sendLater: async (c, id, startAfter) => {
              if (!send) throw new Error('extract job: the worker cannot send jobs');
              await send(c, EXTRACT_JOB, { extractionId: id }, { startAfter });
            },
            log: deps.log,
          },
          scope,
          extractionId.toLowerCase(),
          job,
        );
        deps.log.info({ extractionId, outcome: outcome.status }, 'extraction ran');
      },
    }),
  ];
}
