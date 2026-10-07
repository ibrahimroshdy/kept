import { newId } from '@kept/shared';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import {
  changedSince,
  lastChangedBy,
  notUndoable,
  registerUndo,
  type UndoArgs,
  undoConflict,
} from '../audit/undo.js';
import {
  aiCaptureState,
  dedupedFileIds,
  NO_PROVIDER,
  requireUsableFiles,
  resendOwnWaiting,
} from '../capture/service.js';
import { createAttachment } from '../files/attachments.js';
import { assertClientId } from '../http/conventions.js';
import { conflict, invalid } from '../http/errors.js';
import { type Ctx, type SubjectInput, subjectOfInput, todayIn } from '../schedules/service.js';
import { serviceImage, serviceRow, serviceView } from '../schedules/services.js';
import type { ServiceRecord } from '../schedules/view.js';
import { gateFor } from '../serialize/gates.js';
import { requireRole } from '../things/service.js';
import { moneyOff } from '../things/validate.js';

// Service drafts from an invoice (step 5, T9; screens §5 "Log a service"; D19, D26, D29, D94,
// D131; plan Q12). Step 4's POST /api/v1/service-records stays the one way a service is logged
// in one go; attaching an invoice first makes a **draft**:
//
// - a `service_records` row with `review_state = 'draft'` on the thing or place, dated today in
//   the location's zone until the form says otherwise, with the invoice pages as its `invoice`
//   attachments (a money role: refused where the caller's gate hides money, files/attachments.ts);
// - when AI capture is effective in the location and the caller may `ai.capture`
//   (capture/service.ts aiCaptureState), one `extractions` row reading the first page
//   (`mode = 'receipt'`, `service_record_id` set) and its `extract` job, sent on this same
//   transaction (D94): a rolled-back draft leaves no job. With AI on but no provider resolving,
//   the row waits as `waiting_provider` / `no_provider`, as a capture's does, and no job is sent.
//   extraction/job.ts runs it with the service-invoice prompt; nothing is applied, the vendor,
//   date, total, currency and lines become the draft's `suggestions` (schedules/view.ts).
//
// A draft counts nowhere (0063: anchors; the agenda reads no service record; the costs and the
// reports read confirmed records only) and has no lines, money or completions of its own until
// POST …/confirm (schedules/services.ts confirmService) writes the form's. Its logger, or an
// admin, deletes it at any time, with its read (step 4's DELETE, not undoable for a draft).

const actor = (ctx: Ctx) => actorOf(ctx.scope);

export type CreateDraftInput = {
  id: string;
  subject: SubjectInput;
  invoiceFileIds: string[];
};

export type CreateDraftResult = {
  serviceRecord: ServiceRecord;
  extraction?: { id: string; status: 'queued' | 'waiting_provider' };
};

/** The most pages a draft's invoice has (the route's limit too). */
export const MAX_INVOICE_PAGES = 10;

/**
 * POST /api/v1/service-records/drafts (`logs.add`; Idempotency-Key required by the route) → 201
 * {serviceRecord, extraction?}. 404 for a subject or a file the caller can't see (or a file that
 * isn't theirs to attach, capture/service.ts requireUsableFiles); 403 for a viewer; 409
 * `module_off` where money is hidden from them (an invoice is money).
 */
export async function createDraft(ctx: Ctx, body: CreateDraftInput): Promise<CreateDraftResult> {
  const { client, tx } = ctx;
  const subject = await subjectOfInput(client, body.subject);
  const locationId = subject.locationId;
  const role = await requireRole(client, locationId, 'logs.add');
  const id = assertClientId(body.id);
  const fileIds = await dedupedFileIds(
    client,
    locationId,
    body.invoiceFileIds.map((fileId) => ({ fileId })),
  );
  if (fileIds.length === 0 || fileIds.length > MAX_INVOICE_PAGES) {
    throw invalid(`Check body.invoiceFileIds: 1 to ${MAX_INVOICE_PAGES} files.`);
  }
  await requireUsableFiles(client, locationId, fileIds);
  if (!(await gateFor(tx, locationId, ctx.scope)).showMoney) throw moneyOff();

  const servicedOn = await todayIn(client, locationId);
  await client.query(
    `INSERT INTO public.service_records (id, location_id, thing_id, place_id, serviced_on,
                                         review_state, logged_by)
     VALUES ($1, $2, $3, $4, $5, 'draft', kept.current_user_id())`,
    [id, locationId, subject.thingId, subject.placeId, servicedOn],
  );
  const attachmentIds: string[] = [];
  for (const [sort, fileId] of fileIds.entries()) {
    const view = await createAttachment(
      tx,
      client,
      ctx.files,
      (loc) => gateFor(tx, loc, ctx.scope),
      ctx.scope.userId,
      { id: newId(), locationId, fileId, subject: { serviceRecordId: id }, role: 'invoice', sort },
      ctx.requestId,
    );
    attachmentIds.push(view.id);
  }

  let extraction: CreateDraftResult['extraction'];
  const ai = await aiCaptureState(tx, client, locationId, role);
  const first = attachmentIds[0];
  if (ai !== 'off' && first) extraction = await queueRead(ctx, locationId, id, first, ai);

  await audited(tx, {
    locationId,
    actor: actor(ctx),
    action: 'service_record.draft',
    entity: { type: 'service_record', id },
    after: {
      thing_id: subject.thingId,
      place_id: subject.placeId,
      serviced_on: servicedOn,
      review_state: 'draft',
      invoice_ids: attachmentIds,
      ...(extraction ? { extraction_id: extraction.id } : {}),
    },
    subjects: subject.thingId ? [subject.thingId] : [],
    rootThingId: subject.thingId,
    requestId: ctx.requestId,
  });
  return {
    serviceRecord: await serviceView(ctx, id),
    ...(extraction ? { extraction } : {}),
  };
}

/** The invoice's read: an `extractions` row and its `extract` job on this transaction (D94);
 * with no provider yet, the row waits and no job is sent (capture/service.ts queueExtraction). */
async function queueRead(
  ctx: Ctx,
  locationId: string,
  serviceRecordId: string,
  attachmentId: string,
  ai: 'on' | 'waiting',
): Promise<{ id: string; status: 'queued' | 'waiting_provider' }> {
  const id = newId();
  const status = ai === 'on' ? 'queued' : 'waiting_provider';
  await ctx.client.query(
    `INSERT INTO public.extractions (id, location_id, attachment_id, service_record_id, mode,
                                     requested_by, status, status_reason)
     VALUES ($1, $2, $3, $4, 'receipt', kept.current_user_id(), $5, $6)`,
    [id, locationId, attachmentId, serviceRecordId, status, ai === 'on' ? null : NO_PROVIDER],
  );
  if (ai === 'on') {
    await ctx.jobs?.sendTenant(ctx.client, 'extract', { extractionId: id });
    await resendOwnWaiting(ctx, locationId, id);
  }
  return { id, status };
}

// ---------------------------------------------------------------------------------------------
// Undo: a confirmed draft is a draft again
// ---------------------------------------------------------------------------------------------

type Diff = UndoArgs['event']['diff'];
const beforeOf = (diff: Diff): Record<string, unknown> =>
  Object.fromEntries(Object.entries(diff).map(([k, c]) => [k, c.before ?? null]));
const afterOf = (diff: Diff): Record<string, unknown> =>
  Object.fromEntries(Object.entries(diff).map(([k, c]) => [k, c.after ?? null]));

type Cleared = {
  id: string;
  snoozed_until: string | null;
  snoozed_until_value: string | null;
  skip_next: boolean;
};

type LineImage = {
  id: string;
  kind: string;
  description: string;
  quantity: string | null;
  unit_cost: string | null;
  sort: number;
};

/** The event's own bookkeeping, never compared with the record. */
const BOOKKEEPING = new Set(['reading_created', 'cleared_schedules', 'review_state']);

/**
 * `service_record.confirm`: the record is a draft again, as it was before (its fields, no lines
 * or completions of the confirm's, the reading the confirm made removed, the schedules' snooze
 * and skip back), unless it changed since (409 `undo_refused` `changed_since`). The anchors fall
 * back as the completions go (0053, 0063).
 */
async function undoConfirm(args: UndoArgs): Promise<void> {
  const { event, client } = args;
  const id = event.entityId;
  if (event.entityType !== 'service_record' || !id) throw notUndoable();
  if (Object.values(event.diff).some((c) => c.class === 'money')) {
    if (!(await gateFor(args.tx, event.locationId, args.scope)).showMoney) throw moneyOff();
  }
  let row: Awaited<ReturnType<typeof serviceRow>>;
  try {
    row = await serviceRow(client, id, true);
  } catch {
    throw conflict("Can't undo: that service no longer exists.");
  }
  if (row.location_id !== event.locationId) throw notUndoable();
  if (row.review_state !== 'confirmed') throw undoConflict(['review_state']);
  const image = (await serviceImage(client, row)) as unknown as Record<string, unknown>;
  const diff = Object.fromEntries(Object.entries(event.diff).filter(([f]) => !BOOKKEEPING.has(f)));
  const conflicts = changedSince(diff, image);
  if (conflicts.length > 0) {
    throw undoConflict(
      conflicts,
      await lastChangedBy(client, event.locationId, { type: 'service_record', id }, event.at),
    );
  }
  const back = { ...image, ...beforeOf(diff) };
  const after = afterOf(event.diff);
  await client.query(
    `UPDATE public.service_records
        SET serviced_on = $2, meter_reading_id = $3, vendor_id = $4, total = $5, currency = $6,
            notes = $7, review_state = 'draft'
      WHERE id = $1`,
    [
      id,
      back.serviced_on,
      back.meter_reading_id,
      back.vendor_id,
      back.total,
      back.currency,
      back.notes,
    ],
  );
  if (after.reading_created === true && typeof after.meter_reading_id === 'string') {
    await client.query(
      `DELETE FROM public.meter_readings d WHERE d.id = $1
          AND NOT EXISTS (SELECT 1 FROM public.service_records r WHERE r.meter_reading_id = d.id)`,
      [after.meter_reading_id],
    );
  }
  await client.query('DELETE FROM public.service_completions WHERE service_record_id = $1', [id]);
  await client.query('DELETE FROM public.service_lines WHERE service_record_id = $1', [id]);
  for (const l of (back.lines as LineImage[] | null) ?? []) {
    await client.query(
      `INSERT INTO public.service_lines (id, location_id, service_record_id, kind, description,
                                         quantity, unit_cost, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [l.id, event.locationId, id, l.kind, l.description, l.quantity, l.unit_cost, l.sort],
    );
  }
  const cleared = (event.diff.cleared_schedules?.before as Cleared[] | null | undefined) ?? [];
  for (const c of cleared) {
    await client.query(
      `UPDATE public.schedules
          SET snoozed_until = $2, snoozed_until_value = $3, skip_next = $4
        WHERE id = $1`,
      [c.id, c.snoozed_until, c.snoozed_until_value, c.skip_next],
    );
  }
  const now = await serviceImage(client, await serviceRow(client, id));
  await args.audit({
    action: 'service_record.confirm',
    entity: { type: 'service_record', id },
    before: { ...image, review_state: 'confirmed' },
    after: { ...now, review_state: 'draft' },
    fieldClasses: { total: 'money', lines: 'money' },
    subjects: row.thing_id ? [row.thing_id] : [],
    rootThingId: row.thing_id,
  });
}

let registered = false;

/** Registers the confirm's undo (idempotent; services/routes.ts). */
export function registerDraftUndo(): void {
  if (registered) return;
  registered = true;
  registerUndo('service_record.confirm', undoConfirm);
}
