import {
  ATTACHMENT_ROLES,
  type AttachmentRole,
  type CaptureMode,
  CreateThingPayload,
  can,
  newId,
  type Role,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited, undoableEventIds } from '../audit/audited.js';
import { undoableUntil } from '../audit/undo.js';
import type { Tx } from '../db/scope.js';
import { assertClientId } from '../http/conventions.js';
import { invalid, notFound } from '../http/errors.js';
import { locationModuleSet } from '../http/modules.js';
import type { SendDedupe } from '../jobs/queue.js';
import { claimForCapture } from '../labels/claim.js';
import { METER_VALUE } from '../meters/check.js';
import { attachProof } from '../meters/proofs.js';
import { createReading } from '../meters/service.js';
import { unplacedOf } from '../places/view.js';
import { applyTemplate } from '../templates/service.js';
import { type Ctx, insertThing, requireRole, targetOf, writableThing } from '../things/service.js';
import { rowsOf, type ThingRow } from '../things/view.js';

// The capture service (plan T13; D17, D18, D19, D34, D36, D117, D140, D175; engineering spec
// §7.8; Q10, Q13, Q14, Q23). The one implementation behind `POST /api/v1/captures` and the sync
// op `create_thing` (T14): both call capture() in the caller's scoped transaction.
//
// What a capture makes, by mode (T25's contract: only THING and LABEL without attachToThingId or
// pageOf make a thing):
// - THING, LABEL: a thing, named and `confirmed` when a name came with it, else an unnamed
//   `draft` with an inbox `draft` item (Q14). Its short ID is allocated now, at sync (D112), with
//   the type's default meter (createThing's path). The files are its `photo` attachments.
//   "+ photo to this thing" (`attachToThingId`, D175) adds the files to that thing instead, and in
//   LABEL mode queues a label extraction on it.
// - RECEIPT: a draft purchase (`purchased_on` null, `review_state='draft'`, Q10) whose id is the
//   capture's id, the files as its `receipt` pages, and an inbox `receipt` item. With
//   `attachToThingId`, the receipt joins the purchase of that thing's purchase line when it has
//   one; otherwise the new draft purchase gets one line, and the thing is linked to it. `pageOf`
//   (a later page, screens §8 "Receipt pages") adds pages to the receipt that capture made: the
//   first page's attachment carries that capture's id, so the page finds it again.
// - READING: the thing whose meter was read (`attachToThingId`, the meter's thing for `meterId`,
//   or the target container), which must have exactly one meter unless `meterId` names one. A
//   typed `readingValue` (online only, AI off) goes through the meters service with source
//   `photo`, and the files are that reading's `proof` attachments (step 5, Q10). Otherwise they
//   are the thing's `proof` attachments while AI reads it (T10, never applied, D19), or, with no
//   AI, an inbox `reading` item asks for the value.
//
// Files: each must be one the caller uploaded to this location, or one already attached there
// that they can see (a file of another location, or one out of sight, is the same 404 as none).
// Uploading bytes the location already holds makes no new file: the upload answers the existing
// one (`deduplicatedFrom`, D177), so a queued capture names an id that never became a file. With
// the original's `sha256`, that id is looked up by hash among the location's files the caller can
// see, and the capture takes the existing file (plan T14). The role is the mode's (ROLE_BY_MODE);
// a different role is refused. `displayFileId` is the phone's own bookkeeping (its display copy
// goes to PUT /files/<original>/display before the op, T24) and is ignored here.
//
// AI: when the location's `ai_capture` module is effective (a provider resolves, http/modules.ts)
// and the caller may `ai.capture`, an `extractions` row is queued and the `extract` tenant job is
// sent on this same transaction (D94): a rolled-back capture leaves no job. A receipt's job waits
// 20 s, one per purchase, so later pages arrive first (Q13). T10 runs it. Nothing here calls AI.
// When the module is on but no provider resolves yet, the row is written `waiting_provider` with
// the reason `no_provider` and no job: it waits in the inbox ("Waiting for an AI provider") and is
// sent when a provider is connected (ai/api.ts on a key's save or test; the capturer's own next
// capture here). Photos captured before Groq was connected were never named (the maintainer's
// iPhone, 2026-09-29): no row was written, so connecting a key found nothing to do.
//
// Audit: one event, as the caller. A new thing's is `thing.capture` in place of `thing.create`,
// undoable for 7 days (Q23: undoing it trashes the capture); photos added to a thing are
// `thing.capture` too, not undoable; a receipt is `purchase.capture`. A typed reading also writes
// the meters service's own `reading.create`.

/** The attachment role of each mode's files (T25's contract). */
export const ROLE_BY_MODE: Readonly<Record<CaptureMode, AttachmentRole>> = Object.freeze({
  thing: 'photo',
  receipt: 'receipt',
  label: 'photo',
  reading: 'proof',
});

/** A capture's file on the wire: the op requires `role`, the online route lets it default. */
export const CaptureFile = z.strictObject({
  fileId: z.uuid(),
  role: z.enum(ATTACHMENT_ROLES).optional(),
  displayFileId: z.uuid().optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/**
 * POST /api/v1/captures: the `create_thing` op's payload (@kept/shared) plus `locationId`, and
 * `readingValue` (READING with AI off: the value the person typed).
 */
export const CaptureBody = CreateThingPayload.extend({
  locationId: z.uuid(),
  files: z.array(CaptureFile).max(20),
  readingValue: z.string().regex(METER_VALUE).optional(),
});
export type CaptureInput = z.infer<typeof CaptureBody>;

export type CaptureOptions = {
  /** `op` (T14) has checked the client id against its own 90-day window (Q2); `online` checks
   * it here (±7 days, §7.7). */
  via: 'online' | 'op';
};

export type CaptureResult = {
  thing?: ThingRow;
  purchaseId?: string;
  extraction?: { id: string; status: 'queued' | 'waiting_provider' };
  inboxItemId?: string;
  /** The Undo toast's event (D150, T20): only a new thing's capture is undoable. */
  undo?: { eventId: string; until: string };
};

const actor = (userId: string) => ({ type: 'user' as const, id: userId });

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

/** The reason on an extraction that waits for a provider to be connected. */
export const NO_PROVIDER = 'no_provider';

/**
 * Whether AI capture runs for this capture. `on`: the module is effective in the location (a
 * provider resolves for the caller, kept.ai_provider_resolved) and the role may `ai.capture`.
 * `waiting`: it would be, but no provider resolves yet. `off`: the module or the role says no.
 */
export async function aiCaptureState(
  tx: Tx,
  client: pg.ClientBase,
  locationId: string,
  role: Role,
): Promise<'on' | 'waiting' | 'off'> {
  if (!can(role, 'ai.capture')) return 'off';
  let resolved = false;
  // The modules as they would be with a provider; whether one resolves is kept aside.
  const modules = await locationModuleSet(tx, locationId, async (_tx, loc) => {
    const { rows } = await client.query<{ ok: boolean }>(
      'SELECT kept.ai_provider_resolved($1) AS ok',
      [loc],
    );
    resolved = rows[0]?.ok === true;
    return true;
  });
  if (!modules?.has('ai_capture')) return 'off';
  return resolved ? 'on' : 'waiting';
}

/** AI capture runs now (aiCaptureState is `on`). */
export async function aiCaptureOn(
  tx: Tx,
  client: pg.ClientBase,
  locationId: string,
  role: Role,
): Promise<boolean> {
  return (await aiCaptureState(tx, client, locationId, role)) === 'on';
}

/**
 * 404 unless every file is in this location and the caller's to attach: their own upload, or a
 * file already attached there that they can see (a dedupe hit, D177; RLS decides what is seen).
 */
export async function requireUsableFiles(
  client: pg.ClientBase,
  locationId: string,
  fileIds: readonly string[],
): Promise<void> {
  if (fileIds.length === 0) return;
  const { rows } = await client.query<{ id: string }>(
    `SELECT f.id FROM public.files f
      WHERE f.id = ANY ($1::uuid[]) AND f.location_id = $2
        AND (f.created_by = kept.current_user_id()
             OR EXISTS (SELECT 1 FROM public.attachments a WHERE a.file_id = f.id))`,
    [[...fileIds], locationId],
  );
  if (rows.length !== new Set(fileIds).size) throw notFound();
}

/**
 * The file each capture file names: its own id when that file exists in the location, else, with
 * a `sha256`, the location's file with those bytes that the caller can see (the one the upload
 * answered with `deduplicatedFrom`). Anything else keeps its id, for requireUsableFiles' 404.
 * Two files that turn out to be the same bytes are one.
 */
export async function dedupedFileIds(
  client: pg.ClientBase,
  locationId: string,
  files: readonly { fileId: string; sha256?: string | undefined }[],
): Promise<string[]> {
  const ids = files.map((f) => f.fileId.toLowerCase());
  if (ids.length === 0) return ids;
  const { rows: found } = await client.query<{ id: string }>(
    'SELECT f.id FROM public.files f WHERE f.id = ANY ($1::uuid[]) AND f.location_id = $2',
    [ids, locationId],
  );
  const present = new Set(found.map((r) => r.id));
  const out: string[] = [];
  for (const [i, f] of files.entries()) {
    const id = ids[i] as string;
    if (present.has(id) || !f.sha256) {
      out.push(id);
      continue;
    }
    const { rows } = await client.query<{ id: string }>(
      `SELECT f.id FROM public.files f WHERE f.location_id = $1 AND f.sha256 = $2
        ORDER BY (f.created_by = kept.current_user_id()) DESC, f.created_at, f.id LIMIT 1`,
      [locationId, f.sha256],
    );
    out.push(rows[0]?.id ?? id);
  }
  return [...new Set(out)];
}

type Subject = { thingId: string } | { purchaseId: string };

/** Inserts one attachment per file, after the subject's existing ones; the first may take a
 * given id. Answers the attachment ids in file order. */
export async function attachFiles(
  client: pg.ClientBase,
  locationId: string,
  subject: Subject,
  role: AttachmentRole,
  fileIds: readonly string[],
  firstId?: string,
): Promise<string[]> {
  const thingId = 'thingId' in subject ? subject.thingId : null;
  const purchaseId = 'purchaseId' in subject ? subject.purchaseId : null;
  const { rows: after } = await client.query<{ next: number }>(
    `SELECT coalesce(max(a.sort) + 1, 0)::int AS next FROM public.attachments a
      WHERE ($1::uuid IS NOT NULL AND a.thing_id = $1::uuid)
         OR ($2::uuid IS NOT NULL AND a.purchase_id = $2::uuid)`,
    [thingId, purchaseId],
  );
  const start = after[0]?.next ?? 0;
  const ids: string[] = [];
  for (const [i, fileId] of fileIds.entries()) {
    const id = i === 0 && firstId ? firstId : newId();
    await client.query(
      `INSERT INTO public.attachments (id, location_id, file_id, thing_id, purchase_id, role, sort,
                                       created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, kept.current_user_id())`,
      [id, locationId, fileId, thingId, purchaseId, role, start + i],
    );
    ids.push(id);
  }
  return ids;
}

type ExtractionTarget = {
  locationId: string;
  attachmentId: string;
  mode: CaptureMode;
  thingId?: string;
  purchaseId?: string;
  meterId?: string;
};

/**
 * A queued extraction and its `extract` job, on this transaction (D94). With no provider yet
 * (`waiting`), the row waits as `waiting_provider` / `no_provider` and no job is sent.
 */
async function queueExtraction(
  ctx: Ctx,
  t: ExtractionTarget,
  ai: 'on' | 'waiting',
  dedupe?: SendDedupe,
): Promise<{ id: string; status: 'queued' | 'waiting_provider' }> {
  const id = newId();
  const status = ai === 'on' ? 'queued' : 'waiting_provider';
  await ctx.client.query(
    `INSERT INTO public.extractions (id, location_id, attachment_id, thing_id, purchase_id,
                                     meter_id, mode, requested_by, status, status_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, kept.current_user_id(), $8, $9)`,
    [
      id,
      t.locationId,
      t.attachmentId,
      t.thingId ?? null,
      t.purchaseId ?? null,
      t.meterId ?? null,
      t.mode,
      status,
      ai === 'on' ? null : NO_PROVIDER,
    ],
  );
  if (ai === 'on') {
    await ctx.jobs?.sendTenant(ctx.client, 'extract', { extractionId: id }, dedupe);
    // A provider resolves here now: the caller's own captures that waited for one go too.
    await resendOwnWaiting(ctx, t.locationId, id);
  }
  return { id, status };
}

/**
 * The caller's own extractions in this location that waited for a provider (`no_provider`),
 * sent now that one resolves, oldest first. Theirs only, in their own scope: someone else's are
 * sent by a key's save or test, or from that person's inbox (Name N unnamed photos).
 */
export async function resendOwnWaiting(
  ctx: Pick<Ctx, 'client' | 'jobs'>,
  locationId: string,
  except?: string,
): Promise<number> {
  if (!ctx.jobs) return 0;
  const { rows } = await ctx.client.query<{ id: string; created_at: Date }>(
    `UPDATE public.extractions SET status = 'queued', status_reason = NULL, paused_until = NULL
      WHERE location_id = $1 AND requested_by = kept.current_user_id()
        AND status = 'waiting_provider' AND status_reason = $2 AND id <> $3::uuid
      RETURNING id, created_at`,
    [locationId, NO_PROVIDER, except ?? '00000000-0000-0000-0000-000000000000'],
  );
  rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  for (const r of rows) await ctx.jobs.sendTenant(ctx.client, 'extract', { extractionId: r.id });
  return rows.length;
}

type InboxInsert = {
  locationId: string;
  kind: 'draft' | 'receipt' | 'reading';
  thingId?: string;
  purchaseId?: string;
  extractionId?: string;
  batchId: string;
  payload?: Record<string, unknown>;
};

/** Opens an inbox item, unless one is already open for the same subject (inbox_open_subject_uq):
 * answers its id, or null when one was open already. */
async function openInboxItem(client: pg.ClientBase, item: InboxInsert): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO public.inbox_items (id, location_id, kind, thing_id, purchase_id, extraction_id,
                                     batch_id, created_by, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, kept.current_user_id(), $8)
     ON CONFLICT DO NOTHING RETURNING id`,
    [
      newId(),
      item.locationId,
      item.kind,
      item.thingId ?? null,
      item.purchaseId ?? null,
      item.extractionId ?? null,
      item.batchId,
      JSON.stringify(item.payload ?? {}),
    ],
  );
  return rows[0]?.id ?? null;
}

/** The capture's file ids, checked against the mode's role. */
function filesOf(input: CaptureInput): string[] {
  const role = ROLE_BY_MODE[input.mode];
  for (const f of input.files) {
    if (f.role && f.role !== role) {
      throw invalid(`files: a ${input.mode} capture's files are ${role} attachments.`);
    }
  }
  const ids = input.files.map((f) => f.fileId.toLowerCase());
  if (new Set(ids).size !== ids.length) throw invalid('files: each file once.');
  return ids;
}

// ---------------------------------------------------------------------------------------------
// The capture
// ---------------------------------------------------------------------------------------------

export async function capture(
  ctx: Ctx,
  input: CaptureInput,
  opts: CaptureOptions,
): Promise<CaptureResult> {
  const { client, tx, scope } = ctx;
  const locationId = input.locationId.toLowerCase();
  const id = opts.via === 'online' ? assertClientId(input.id) : input.id.toLowerCase();
  const batchId = input.batchId.toLowerCase();
  // 1. Who: 404 for a location the caller can't see, 403 for a viewer.
  const role = await requireRole(client, locationId, 'things.edit');

  // 2. What (D19): at least one file or a name; the evidence modes need a photo.
  filesOf(input);
  const fileIds = await dedupedFileIds(client, locationId, input.files);
  const name = input.name?.trim() || null;
  // Quick add (T19): a new thing from a template may come with neither; its name is the template's.
  const fromTemplate = !!input.templateId && !input.attachToThingId;
  if (fileIds.length === 0 && !name && !fromTemplate) {
    throw invalid('A capture needs a photo or a name.');
  }
  if ((input.mode === 'receipt' || input.mode === 'reading') && fileIds.length === 0) {
    throw invalid(`A ${input.mode} capture needs a photo.`);
  }
  if (input.pageOf && input.mode !== 'receipt') throw invalid('pageOf is for receipt pages.');
  if (input.pageOf && input.attachToThingId) {
    throw invalid('A receipt page goes with its receipt or with a thing, not both.');
  }
  if (input.readingValue !== undefined && input.mode !== 'reading') {
    throw invalid('readingValue is for reading captures.');
  }
  if (input.meterId && input.mode !== 'reading') throw invalid('meterId is for readings.');
  await requireUsableFiles(client, locationId, fileIds);

  // 3. Where: the location's Unplaced area (D118), a place, or a container the caller can see.
  const target =
    'unplaced' in input.target
      ? { placeId: await unplacedOf(client, locationId), containerId: null }
      : await targetOf(client, locationId, input.target);

  const ai = fileIds.length > 0 ? await aiCaptureState(tx, client, locationId, role) : 'off';
  const base = { mode: input.mode, batch_id: batchId, file_ids: fileIds };

  switch (input.mode) {
    case 'receipt':
      return captureReceipt(ctx, input, { id, locationId, batchId, fileIds, ai, base });
    case 'reading':
      return captureReading(ctx, input, { id, locationId, batchId, fileIds, ai, base, target });
    default:
      break;
  }

  // THING and LABEL.
  if (input.attachToThingId) {
    const thing = await writableThing(client, input.attachToThingId.toLowerCase(), 'things.edit');
    if (thing.location_id !== locationId) throw notFound();
    const attachments = await attachFiles(
      client,
      locationId,
      { thingId: thing.id },
      'photo',
      fileIds,
    );
    await audited(tx, {
      locationId,
      actor: actor(scope.userId),
      action: 'thing.capture',
      entity: { type: 'thing', id: thing.id },
      after: { ...base, capture_id: id, attachment_ids: attachments },
      rootThingId: thing.id,
      subjects: [thing.id],
      requestId: ctx.requestId,
    });
    const result: CaptureResult = {};
    // D175: a label photo "+ photo to this thing" fills its brand, model and serial.
    const first = attachments[0];
    if (ai !== 'off' && input.mode === 'label' && first) {
      result.extraction = await queueExtraction(
        ctx,
        { locationId, attachmentId: first, mode: 'label', thingId: thing.id },
        ai,
      );
    }
    const [row] = await rowsOf(client, ctx.files, [thing.id]);
    if (row) result.thing = row;
    return result;
  }

  // 5. A new thing (createThing's path: short ID now, D112; the default meter; created_by).
  // Quick add (T19): a template shared with this location is the base, and what was sent wins;
  // a capture with no name takes the template's (templates/service.ts applyTemplate).
  const sent = {
    name,
    ...(input.typeId ? { typeId: input.typeId.toLowerCase() } : {}),
    ...(input.quantity ? { quantity: Number(input.quantity) } : {}),
    ...(input.note ? { notes: input.note } : {}),
  };
  const fields = input.templateId
    ? await applyTemplate(client, input.templateId, locationId, sent)
    : sent;
  const named = fields.name ?? null;
  const until = undoableUntil();
  await insertThing(
    ctx,
    {
      id,
      locationId,
      ...(target.containerId ? { containerId: target.containerId } : {}),
      ...(target.placeId ? { placeId: target.placeId } : {}),
      ...fields,
      name: named,
      ...(input.barcode ? { barcode: input.barcode } : {}),
    },
    {
      draft: named === null,
      captureBatchId: batchId,
      fieldStatus: name ? { name: { state: 'manual' } } : {},
      idChecked: true,
      audit: { action: 'thing.capture', after: base, undoableUntil: until },
    },
  );
  const eventId = undoableEventIds(tx).at(-1);
  const attachments = await attachFiles(client, locationId, { thingId: id }, 'photo', fileIds);
  const result: CaptureResult = {};
  // A blank label scanned during capture (D43): claimed for the new thing, whose code it becomes
  // (labels/claim.ts). Claimed first elsewhere: a `label_claim` inbox item; not claimable at all:
  // nothing said, as for a random code. The capture stands either way.
  if (input.claimCode) {
    const claim = await claimForCapture(ctx, input.claimCode, { id, locationId, batchId });
    if (claim.inboxItemId) result.inboxItemId = claim.inboxItemId;
  }
  const first = attachments[0];
  if (ai !== 'off' && first) {
    result.extraction = await queueExtraction(
      ctx,
      { locationId, attachmentId: first, mode: input.mode, thingId: id },
      ai,
    );
  }
  // Q14: an unnamed draft waits in the inbox ("unnamed photo to finish later", §4.18); a named
  // capture doesn't, unless AI later leaves suggestions (T10).
  if (named === null) {
    const item = await openInboxItem(client, {
      locationId,
      kind: 'draft',
      thingId: id,
      batchId,
      ...(result.extraction ? { extractionId: result.extraction.id } : {}),
    });
    if (item) result.inboxItemId = item;
  }
  const [row] = await rowsOf(client, ctx.files, [id]);
  if (row) result.thing = row;
  if (eventId) result.undo = { eventId, until: until.toISOString() };
  return result;
}

type Common = {
  id: string;
  locationId: string;
  batchId: string;
  fileIds: string[];
  /** aiCaptureState: a READING waits for no provider (it asks for the value instead). */
  ai: 'on' | 'waiting' | 'off';
  base: Record<string, unknown>;
};

/** RECEIPT: a draft purchase with the pages, or more pages of one (Q10, Q13; screens §8). */
async function captureReceipt(ctx: Ctx, input: CaptureInput, c: Common): Promise<CaptureResult> {
  const { client, tx, scope } = ctx;
  const note = input.note ?? null;
  const result: CaptureResult = {};

  if (input.pageOf) {
    // The first page of that capture carries its id (below): the receipt it went to.
    const { rows } = await client.query<{ purchase_id: string }>(
      `SELECT a.purchase_id FROM public.attachments a
        WHERE a.id = $1 AND a.location_id = $2 AND a.purchase_id IS NOT NULL`,
      [input.pageOf.toLowerCase(), c.locationId],
    );
    const purchaseId = rows[0]?.purchase_id;
    if (!purchaseId) throw notFound();
    const pages = await attachFiles(client, c.locationId, { purchaseId }, 'receipt', c.fileIds);
    await audited(tx, {
      locationId: c.locationId,
      actor: actor(scope.userId),
      action: 'purchase.capture',
      entity: { type: 'purchase', id: purchaseId },
      after: { ...c.base, capture_id: c.id, page_of: input.pageOf.toLowerCase(), pages },
      requestId: ctx.requestId,
    });
    // Pages added after the extraction ran are re-extracted on request (Q13).
    result.purchaseId = purchaseId;
    return result;
  }

  let purchaseId = c.id;
  let thingId: string | null = null;
  let created = true;
  if (input.attachToThingId) {
    const thing = await writableThing(client, input.attachToThingId.toLowerCase(), 'things.edit');
    if (thing.location_id !== c.locationId) throw notFound();
    thingId = thing.id;
    const { rows } = await client.query<{ purchase_id: string }>(
      `SELECT pl.purchase_id FROM public.things t
         JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
        WHERE t.id = $1 AND pl.location_id = t.location_id`,
      [thing.id],
    );
    if (rows[0]) {
      purchaseId = rows[0].purchase_id;
      created = false;
    }
  }
  if (created) {
    await client.query(
      `INSERT INTO public.purchases (id, location_id, purchased_on, notes, review_state)
       VALUES ($1, $2, NULL, $3, 'draft')`,
      [purchaseId, c.locationId, note],
    );
    if (thingId) {
      // A new draft line waits for the receipt's lines (T10, T15), with the thing on it.
      const lineId = newId();
      const { rows } = await client.query<{ name: string | null }>(
        'SELECT name FROM public.things WHERE id = $1',
        [thingId],
      );
      await client.query(
        `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, quantity)
         VALUES ($1, $2, $3, $4, 1)`,
        [lineId, c.locationId, purchaseId, (rows[0]?.name ?? 'Receipt').slice(0, 300)],
      );
      await client.query('UPDATE public.things SET purchase_line_id = $2 WHERE id = $1', [
        thingId,
        lineId,
      ]);
    }
  }
  // The first page's attachment takes the capture's id, so a later page (`pageOf`) finds it.
  const pages = await attachFiles(client, c.locationId, { purchaseId }, 'receipt', c.fileIds, c.id);
  await audited(tx, {
    locationId: c.locationId,
    actor: actor(scope.userId),
    action: 'purchase.capture',
    entity: { type: 'purchase', id: purchaseId },
    after: {
      ...c.base,
      capture_id: c.id,
      review_state: 'draft',
      created,
      pages,
      ...(thingId ? { thing_id: thingId } : {}),
    },
    ...(thingId ? { rootThingId: thingId, subjects: [thingId] } : {}),
    requestId: ctx.requestId,
  });
  result.purchaseId = purchaseId;
  const first = pages[0];
  if (c.ai !== 'off' && first) {
    // One extraction per purchase, keyed to its first page, 20 s after the last send (Q13).
    const dedupe: SendDedupe = {
      singletonKey: `extract:receipt:${purchaseId}`,
      singletonSeconds: 20,
      startAfter: 20,
    };
    result.extraction = await queueExtraction(
      ctx,
      { locationId: c.locationId, attachmentId: first, mode: 'receipt', purchaseId },
      c.ai,
      dedupe,
    );
  }
  const item = await openInboxItem(client, {
    locationId: c.locationId,
    kind: 'receipt',
    purchaseId,
    batchId: c.batchId,
    ...(result.extraction ? { extractionId: result.extraction.id } : {}),
    ...(thingId ? { payload: { thingId } } : {}),
  });
  if (item) result.inboxItemId = item;
  return result;
}

/** READING: the proof photo on the metered thing, then the value typed, read by AI, or asked for
 * in the inbox (D19: a reading is never applied from AI). */
async function captureReading(
  ctx: Ctx,
  input: CaptureInput,
  c: Common & { target: { placeId: string | null; containerId: string | null } },
): Promise<CaptureResult> {
  const { client, tx, scope } = ctx;
  let thingId: string | null = input.attachToThingId?.toLowerCase() ?? null;
  let meterId: string | null = input.meterId?.toLowerCase() ?? null;
  if (!thingId && meterId) {
    const { rows } = await client.query<{ thing_id: string }>(
      'SELECT thing_id FROM public.meters WHERE id = $1 AND location_id = $2',
      [meterId, c.locationId],
    );
    thingId = rows[0]?.thing_id ?? null;
    if (!thingId) throw notFound();
  }
  thingId ??= c.target.containerId;
  if (!thingId) throw invalid('Choose the thing whose meter this is.');
  const thing = await writableThing(client, thingId, 'logs.add');
  if (thing.location_id !== c.locationId) throw notFound();
  const { rows: meters } = await client.query<{ id: string }>(
    'SELECT id FROM public.meters WHERE thing_id = $1 ORDER BY created_at, id',
    [thing.id],
  );
  if (meterId) {
    if (!meters.some((m) => m.id === meterId)) throw notFound();
  } else if (meters.length === 1) {
    meterId = (meters[0] as { id: string }).id;
  } else {
    throw invalid(
      meters.length === 0 ? 'This thing has no meter to read.' : 'Choose which meter this is.',
    );
  }
  // Typed at capture (AI off): the meters service checks it against its neighbours (D112), and
  // the photos prove that reading (step 5, Q10, D195: on the reading, not the thing). Otherwise
  // they wait on the thing until a reading exists (AI's, or the inbox's).
  let readingId: string | null = null;
  const attachments: string[] = [];
  if (input.readingValue !== undefined) {
    const made = await createReading(
      ctx,
      meterId,
      {
        id: c.id,
        value: input.readingValue,
        takenAt: new Date().toISOString(),
        ...(input.note ? { note: input.note } : {}),
      },
      'photo',
    );
    readingId = made.reading.id;
    for (const fileId of c.fileIds) {
      attachments.push(await attachProof(client, c.locationId, readingId, fileId));
    }
  } else {
    attachments.push(
      ...(await attachFiles(client, c.locationId, { thingId: thing.id }, 'proof', c.fileIds)),
    );
  }
  await audited(tx, {
    locationId: c.locationId,
    actor: actor(scope.userId),
    action: 'thing.capture',
    entity: { type: 'thing', id: thing.id },
    after: {
      ...c.base,
      capture_id: c.id,
      meter_id: meterId,
      attachment_ids: attachments,
      ...(readingId ? { reading_id: readingId } : {}),
    },
    rootThingId: thing.id,
    subjects: [thing.id],
    requestId: ctx.requestId,
  });
  const result: CaptureResult = {};
  const first = attachments[0] as string;
  if (!readingId && c.ai === 'on') {
    result.extraction = await queueExtraction(
      ctx,
      { locationId: c.locationId, attachmentId: first, mode: 'reading', meterId },
      'on',
    );
  } else if (!readingId) {
    // No AI and no value: the inbox asks for it, with the photo (§5).
    const item = await openInboxItem(client, {
      locationId: c.locationId,
      kind: 'reading',
      thingId: thing.id,
      batchId: c.batchId,
      payload: {
        reason: 'needs_value',
        meterId,
        attachmentId: first,
        ...(input.note ? { note: input.note } : {}),
      },
    });
    if (item) result.inboxItemId = item;
  }
  const [row] = await rowsOf(client, ctx.files, [thing.id]);
  if (row) result.thing = row;
  return result;
}
