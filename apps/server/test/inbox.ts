import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import type { TestApp } from './app.js';
import type { TestDb } from './db.js';
import { call, type Person } from './people.js';
import { createThing, type Loc, own } from './things.js';

// Fixtures for the inbox tests (step-3 T15): open items as capture (T13) and extraction (T10)
// leave them, written as kept_owner, and small wrappers for the inbox routes.

/** A file row (no blob) attached to a thing or purchase; answers the attachment id. */
export async function attachment(
  db: TestDb,
  loc: Loc,
  by: Person,
  subject: { thingId: string } | { purchaseId: string },
  role = 'photo',
): Promise<string> {
  const file = newId();
  await own(
    db,
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by)
     VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
    [
      file,
      loc.id,
      `f/${loc.id}/${file}`,
      createHash('sha256').update(file).digest('hex'),
      by.userId,
    ],
  );
  const rows = await own<{ id: string }>(
    db,
    `INSERT INTO public.attachments (location_id, file_id, thing_id, purchase_id, role, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      loc.id,
      file,
      'thingId' in subject ? subject.thingId : null,
      'purchaseId' in subject ? subject.purchaseId : null,
      role,
      by.userId,
    ],
  );
  return rows[0]?.id as string;
}

/** A succeeded extraction of `attachmentId`; answers its id. */
export async function extraction(
  db: TestDb,
  loc: Loc,
  by: Person,
  a: { attachmentId: string; thingId?: string; purchaseId?: string; mode: string },
  result: Record<string, unknown> | null = null,
): Promise<string> {
  const id = newId();
  await own(
    db,
    `INSERT INTO public.extractions (id, location_id, attachment_id, thing_id, purchase_id, mode,
                                     status, result, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'succeeded', $7, $8)`,
    [
      id,
      loc.id,
      a.attachmentId,
      a.thingId ?? null,
      a.purchaseId ?? null,
      a.mode,
      result ? JSON.stringify(result) : null,
      by.userId,
    ],
  );
  return id;
}

/** An open inbox item, as capture and extraction open them; answers its id. */
export async function inboxItem(
  db: TestDb,
  loc: Loc,
  by: Person,
  item: {
    kind: string;
    thingId?: string;
    purchaseId?: string;
    meterReadingId?: string;
    otherThingId?: string;
    extractionId?: string;
    code?: string;
    batchId?: string | null;
    payload?: Record<string, unknown>;
    createdAt?: Date;
  },
): Promise<string> {
  const id = newId();
  await own(
    db,
    `INSERT INTO public.inbox_items (id, location_id, kind, thing_id, purchase_id, meter_reading_id,
                                     other_thing_id, extraction_id, code, batch_id, created_by,
                                     payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13, now()))`,
    [
      id,
      loc.id,
      item.kind,
      item.thingId ?? null,
      item.purchaseId ?? null,
      item.meterReadingId ?? null,
      item.otherThingId ?? null,
      item.extractionId ?? null,
      item.code ?? null,
      item.batchId ?? null,
      by.userId,
      JSON.stringify(item.payload ?? {}),
      item.createdAt ?? null,
    ],
  );
  return id;
}

export type Draft = { thingId: string; itemId: string; batchId: string };

/**
 * A draft as a capture leaves it once AI named it: made through the front door (so it has its
 * code), then turned into an unreviewed draft of `batchId` with the name as AI's, and its open
 * `draft` item.
 */
export async function draft(
  t: TestApp,
  db: TestDb,
  as: Person,
  loc: Loc,
  opts: {
    name?: string | null;
    batchId?: string;
    body?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    fieldStatus?: Record<string, unknown>;
    createdAt?: Date;
  } = {},
): Promise<Draft> {
  const batchId = opts.batchId ?? newId();
  const thing = await createThing(t, as, loc, { name: opts.name ?? 'Draft', ...opts.body });
  await own(
    db,
    `UPDATE public.things SET review_state = 'draft', name = $2, capture_batch_id = $3,
            field_status = $4
      WHERE id = $1`,
    [
      thing.id,
      opts.name === null ? null : (opts.name ?? 'Draft'),
      batchId,
      JSON.stringify(
        opts.fieldStatus ??
          (opts.name === null ? {} : { name: { state: 'extracted', confidence: 0.9 } }),
      ),
    ],
  );
  const itemId = await inboxItem(db, loc, as, {
    kind: 'draft',
    thingId: thing.id,
    batchId,
    payload: opts.payload ?? {},
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
  return { thingId: thing.id, itemId, batchId };
}

/** A draft purchase as a RECEIPT capture leaves it, with its lines; answers its id. */
export async function draftPurchase(
  db: TestDb,
  loc: Loc,
  lines: { description: string; quantity?: string; unitPrice?: string | null }[],
  money: { currency?: string | null; total?: string | null } = {},
): Promise<string> {
  const id = newId();
  await own(
    db,
    `INSERT INTO public.purchases (id, location_id, purchased_on, currency, total, review_state)
     VALUES ($1, $2, NULL, $3, $4, 'draft')`,
    [id, loc.id, money.currency ?? null, money.total ?? null],
  );
  for (const [sort, l] of lines.entries()) {
    await own(
      db,
      `INSERT INTO public.purchase_lines (location_id, purchase_id, description, quantity,
                                          unit_price, sort)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [loc.id, id, l.description, l.quantity ?? '1', l.unitPrice ?? null, sort],
    );
  }
  return id;
}

export type InboxItemJson = {
  id: string;
  kind: string;
  rowVersion: number;
  locationId: string;
  batch: { id: string; capturedAt: string; count: number } | null;
  thing?: { id: string; name: string | null; serial: string | null; fieldStatus: object };
  suggestions?: { field: string; value: unknown }[];
  receipt?: Record<string, unknown> & { lines: Record<string, unknown>[] };
  reading?: Record<string, unknown>;
  duplicate?: { other: { id: string }; reason: string };
  claim?: { code: string; claimedFor: { id: string; name: string } };
  currency?: { seen: string; options: string[] };
  syncDrop?: Record<string, unknown>;
};

export type InboxPageJson = {
  items: InboxItemJson[];
  counts: { byKind: Record<string, number>; mine: number; everyone: number };
  next_cursor: string | null;
};

/** GET /api/v1/inbox with `query`. */
export function inbox(t: TestApp, as: Person, query = ''): Promise<LightMyRequestResponse> {
  return call(t, `/api/v1/inbox${query ? `?${query}` : ''}`, { as });
}

/** POST /api/v1/inbox/:id/<verb> with If-Match (none when `version` is null). */
export function act(
  t: TestApp,
  as: Person,
  id: string,
  verb: string,
  body: unknown,
  version: number | null = 1,
): Promise<LightMyRequestResponse> {
  return call(t, `/api/v1/inbox/${id}/${verb}`, {
    as,
    body: body ?? {},
    headers: version === null ? {} : { 'if-match': String(version) },
  });
}

/** An item's stored row (as kept_owner). */
export async function itemRow(
  db: TestDb,
  id: string,
): Promise<
  | {
      resolution: string | null;
      resolved_by: string | null;
      payload: Record<string, unknown>;
      row_version: number;
    }
  | undefined
> {
  return (
    await own<{
      resolution: string | null;
      resolved_by: string | null;
      payload: Record<string, unknown>;
      row_version: number;
    }>(
      db,
      'SELECT resolution, resolved_by, payload, row_version FROM public.inbox_items WHERE id = $1',
      [id],
    )
  )[0];
}
