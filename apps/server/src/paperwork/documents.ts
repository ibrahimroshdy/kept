import { DOCUMENT_KINDS, type DocumentKind, newId } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { checkVersion, pageOf } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { moneyOff, requireCurrencies } from '../things/validate.js';
import {
  DOCUMENT_COLUMNS,
  DOCUMENT_STATES,
  type DocumentRow,
  documentStateSql,
  documentView,
  documentViews,
  type ExpiringDocument,
  locationTodaySql,
  lockDocumentRow,
  readDocumentRow,
} from './view.js';

// Expiring documents (plan T12; D39, D155, D172; engineering spec §1.6; plan Q5, Q25, Q31): a
// registration, an insurance policy, a lease, on a thing, a place or the location itself, with
// the date it runs out. The agenda (0053) turns each current one into a reminder (Paperwork's,
// Q5). Renewing makes a new row and points the old one at it, so the old term stays (D172).
//
// Writers are those who may edit things (`things.edit`: members and above); the route gates the
// Paperwork module (config.module). Every write is audited `document.<verb>` on entity
// `expiring_document`, with the thing as the event's subject when the document is on one (its
// history shows it, D45). Updates, deletes and renewals are undoable (undo.ts); a delete is hard
// (Q25) and its event holds the whole row, its files and the renewals it ended.
//
// Step 5 (T12; D26, D52; Q5, step 4's Q5):
// - a document has an issue date and a cost (`issuedOn`, `cost` + `currency`): a renewal's cost
//   counts in its issue month on the vehicle's Costs tab (vehicles/costs.ts). The cost is money:
//   written only where the caller's gate shows it (409 `module_off`), in an enabled currency (the
//   location's unless the body names one), and read through the gate (`moneyHidden`);
// - a document on a vehicle (`kept.is_vehicle_type`) works with Paperwork **or** Vehicles on, so
//   a household with Vehicles and no Paperwork still keeps its car's licence (the agenda's rule,
//   0066). The routes gate it here, not in their config (a route names one module);
// - GET /documents takes `thingId`: a vehicle's Documents tab.

export const DocumentSubjectInput = z.union([
  z.strictObject({ thingId: z.uuid() }),
  z.strictObject({ placeId: z.uuid() }),
  z.strictObject({ locationId: z.uuid() }),
]);
export type DocumentSubjectInput = z.infer<typeof DocumentSubjectInput>;

const DateOnly = z.iso.date();
const LeadDays = z.number().int().min(0).max(365);
const Title = z.string().trim().max(120);
const Money = z.string().regex(/^\d{1,12}(\.\d{1,4})?$/, 'a cost of 0 or more, e.g. 1200');
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((c) => c.toUpperCase());

/** Step 5's fields on a create, an edit and a renewal (Q5). */
const CostFields = {
  issuedOn: DateOnly.nullable().optional(),
  cost: Money.nullable().optional(),
  currency: Currency.nullable().optional(),
};

export const CreateDocumentBody = z.strictObject({
  id: z.uuid().optional(),
  subject: DocumentSubjectInput,
  kind: z.enum(DOCUMENT_KINDS),
  title: Title.optional(),
  expiresOn: DateOnly,
  leadDays: LeadDays.optional(),
  ...CostFields,
});
export type CreateDocumentBody = z.infer<typeof CreateDocumentBody>;

export const UpdateDocumentBody = z
  .strictObject({
    kind: z.enum(DOCUMENT_KINDS).optional(),
    title: Title.nullable().optional(),
    expiresOn: DateOnly.optional(),
    leadDays: LeadDays.optional(),
    ...CostFields,
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Say what to change.',
  });
export type UpdateDocumentBody = z.infer<typeof UpdateDocumentBody>;

export const RenewDocumentBody = z.strictObject({
  id: z.uuid().optional(),
  expiresOn: DateOnly,
  leadDays: LeadDays.optional(),
  ...CostFields,
});
export type RenewDocumentBody = z.infer<typeof RenewDocumentBody>;

/** "1"/"0" (the web's), "true"/"false". */
const Flag = z
  .enum(['1', '0', 'true', 'false'])
  .transform((v) => v === '1' || v === 'true')
  .optional();

export const DocumentsQuery = z.object({
  locationId: z.uuid().optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  subjectType: z.enum(['thing', 'place', 'location']).optional(),
  /** A thing's or place's id, or a location's (its own documents, D155). */
  subjectId: z.uuid().optional(),
  state: z.enum(DOCUMENT_STATES).optional(),
  includeSuperseded: Flag,
  /** Step 5 (T12): one thing's documents, a vehicle's Documents tab. */
  thingId: z.uuid().optional(),
});
export type DocumentsQuery = z.infer<typeof DocumentsQuery>;

/** Empty is none; `other` needs a title (Q31: "Building inspection" can't read as "Other"). */
function titleFor(kind: DocumentKind, title: string | null | undefined): string | null {
  const t = title?.trim() ? title.trim() : null;
  if (kind === 'other' && !t) throw invalid('Name a document of kind other (title).');
  return t;
}

/** The subject's location, as the caller sees it: a live thing or place, or a location. */
export async function subjectLocation(
  client: pg.ClientBase,
  subject: DocumentSubjectInput,
): Promise<string | null> {
  if ('thingId' in subject) {
    const { rows } = await client.query<{ location_id: string }>(
      'SELECT location_id FROM public.things WHERE id = $1 AND deleted_at IS NULL',
      [subject.thingId.toLowerCase()],
    );
    return rows[0]?.location_id ?? null;
  }
  if ('placeId' in subject) {
    const { rows } = await client.query<{ location_id: string }>(
      'SELECT location_id FROM public.places WHERE id = $1 AND deleted_at IS NULL',
      [subject.placeId.toLowerCase()],
    );
    return rows[0]?.location_id ?? null;
  }
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM public.locations WHERE id = $1 AND deleted_at IS NULL',
    [subject.locationId.toLowerCase()],
  );
  return rows[0]?.id ?? null;
}

/** The audit image of a document: its columns as stored. */
export const imageOf = (r: DocumentRow) => ({
  thing_id: r.thing_id,
  place_id: r.place_id,
  kind: r.kind,
  title: r.title,
  expires_on: r.expires_on,
  lead_days: r.lead_days,
  superseded_by_id: r.superseded_by_id,
  issued_on: r.issued_on,
  cost: r.cost,
  currency: r.currency,
});

const thingOf = (r: { thing_id: string | null }) => (r.thing_id ? [r.thing_id] : []);

/**
 * The module a document needs (step 4's Q5, step 5's T12): Paperwork, or, for a document on a
 * vehicle, Vehicles. 404 `module_off` to read, 409 to write; a location the caller can't see is a
 * plain 404 (gateFor).
 */
export async function requireDocumentModule(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  locationId: string,
  thingId: string | null,
  mode: 'read' | 'write',
): Promise<void> {
  const gate = await gateFor(tx, locationId, scope);
  if (gate.modules.has('paperwork')) return;
  if (thingId && gate.modules.has('vehicles')) {
    const { rows } = await client.query<{ vehicle: boolean }>(
      'SELECT kept.is_vehicle_type(t.type_id) AS vehicle FROM public.things t WHERE t.id = $1',
      [thingId],
    );
    if (rows[0]?.vehicle) return;
  }
  throw new AppError('module_off', mode === 'read' ? 404 : 409);
}

/** SQL: document `d`'s module is on (Paperwork, or Vehicles for one on a vehicle). */
const documentModuleSql = (d: string) => `(kept.module_on(${d}.location_id, 'paperwork')
    OR (${d}.thing_id IS NOT NULL AND kept.module_on(${d}.location_id, 'vehicles')
        AND EXISTS (SELECT 1 FROM public.things vt
                     WHERE vt.id = ${d}.thing_id AND kept.is_vehicle_type(vt.type_id))))`;

type CostInput = {
  issuedOn?: string | null | undefined;
  cost?: string | null | undefined;
  currency?: string | null | undefined;
};

/** The issue date, cost and currency a write stores. A cost is money: written only where the
 * caller's gate shows it, in an enabled currency (the location's unless the body names one). An
 * issue date after the expiry is refused. */
async function costFor(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  locationId: string,
  body: CostInput,
  current: { issued_on: string | null; cost: string | null; currency: string | null },
  expiresOn: string,
): Promise<{ issued_on: string | null; cost: string | null; currency: string | null }> {
  const issued = body.issuedOn !== undefined ? body.issuedOn : current.issued_on;
  if (issued && issued > expiresOn) {
    throw invalid('Check body.issuedOn: on or before the day it expires.');
  }
  const touched =
    body.cost !== undefined ||
    (body.currency !== undefined && body.currency !== null && current.cost !== null);
  if (!touched) return { issued_on: issued, cost: current.cost, currency: current.currency };
  if (!(await gateFor(tx, locationId, scope)).showMoney) throw moneyOff();
  const cost = body.cost !== undefined ? body.cost : current.cost;
  if (cost === null) return { issued_on: issued, cost: null, currency: null };
  let currency = body.currency ?? current.currency;
  if (!currency) {
    const { rows } = await client.query<{ currency: string }>(
      'SELECT currency FROM public.locations WHERE id = $1',
      [locationId],
    );
    currency = rows[0]?.currency ?? null;
  }
  if (!currency) throw invalid('Send body.currency with the cost.');
  await requireCurrencies(client, [currency], 'body.currency');
  return { issued_on: issued, cost, currency };
}

async function requireWriter(client: pg.ClientBase, locationId: string): Promise<void> {
  const me = await requireMembership(client, locationId);
  requireCan(me.role, 'things.edit', 'Viewers can read documents but not change them.');
}

async function stale(client: pg.ClientBase, row: DocumentRow, expected: number, fields: string[]) {
  if (row.row_version === expected) return;
  const by = await lastChangedBy(client, row.location_id, {
    type: 'expiring_document',
    id: row.id,
  });
  checkVersion({ rowVersion: row.row_version }, expected, fields, by ? { displayName: by } : null);
}

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

type ListKey = [string, string];
const ListKeySchema = z.tuple([z.string(), z.uuid()]);

/**
 * GET /api/v1/documents: across the caller's locations with Paperwork on, soonest first. Current
 * documents only unless `includeSuperseded`. A document whose thing or place is in the trash
 * rests with it (as in the agenda).
 */
export async function listDocuments(
  tx: Tx,
  client: pg.ClientBase,
  files: FileStorage | null,
  scope: Scope,
  q: DocumentsQuery,
  page: { limit: number; after: unknown },
): Promise<{ items: ExpiringDocument[]; next_cursor: string | null }> {
  let after: ListKey | null = null;
  if (page.after !== null) {
    const parsed = ListKeySchema.safeParse(page.after);
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    after = parsed.data;
  }
  const values: unknown[] = [];
  const add = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = [
    documentModuleSql('d'),
    `(d.thing_id IS NULL OR EXISTS (SELECT 1 FROM public.things x
                                     WHERE x.id = d.thing_id AND x.deleted_at IS NULL))`,
    `(d.place_id IS NULL OR EXISTS (SELECT 1 FROM public.places x
                                     WHERE x.id = d.place_id AND x.deleted_at IS NULL))`,
  ];
  if (!q.includeSuperseded) where.push('d.superseded_by_id IS NULL');
  if (q.locationId) where.push(`d.location_id = ${add(q.locationId.toLowerCase())}::uuid`);
  if (q.kind) where.push(`d.kind = ${add(q.kind)}`);
  if (q.subjectType === 'thing') where.push('d.thing_id IS NOT NULL');
  if (q.subjectType === 'place') where.push('d.place_id IS NOT NULL');
  if (q.subjectType === 'location') where.push('d.thing_id IS NULL AND d.place_id IS NULL');
  if (q.thingId) {
    // A vehicle's Documents tab: a thing the caller can't see is a 404, and one whose module is
    // off answers as a gated route does.
    const thingId = q.thingId.toLowerCase();
    const { rows: seen } = await client.query<{ location_id: string }>(
      'SELECT location_id FROM public.things WHERE id = $1 AND deleted_at IS NULL',
      [thingId],
    );
    const loc = seen[0]?.location_id;
    if (!loc) throw notFound();
    await requireDocumentModule(tx, client, scope, loc, thingId, 'read');
    where.push(`d.thing_id = ${add(thingId)}::uuid`);
  }
  if (q.subjectId) {
    const id = add(q.subjectId.toLowerCase());
    where.push(`(d.thing_id = ${id}::uuid OR d.place_id = ${id}::uuid
                 OR (d.location_id = ${id}::uuid AND d.thing_id IS NULL AND d.place_id IS NULL))`);
  }
  if (q.state) {
    where.push(
      `${documentStateSql('d', locationTodaySql('d.location_id'))} = ${add(q.state)}::text`,
    );
  }
  if (after) {
    where.push(`(d.expires_on, d.id) > (${add(after[0])}::date, ${add(after[1])}::uuid)`);
  }
  const { rows } = await client.query<DocumentRow>(
    `SELECT ${DOCUMENT_COLUMNS('d')} FROM public.expiring_documents d
      WHERE ${where.join('\n AND ')}
      ORDER BY d.expires_on, d.id
      LIMIT ${add(page.limit + 1)}`,
    values,
  );
  const paged = pageOf(rows, page.limit, (r): ListKey => [r.expires_on, r.id]);
  return {
    items: await documentViews(tx, client, files, scope, paged.items),
    next_cursor: paged.next_cursor,
  };
}

// ---------------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------------

export async function createDocument(
  tx: Tx,
  client: pg.ClientBase,
  files: FileStorage | null,
  scope: Scope,
  body: CreateDocumentBody & { id: string },
  requestId: string,
): Promise<ExpiringDocument> {
  const locationId = await subjectLocation(client, body.subject);
  if (!locationId) throw notFound();
  const s = body.subject;
  const thingId = 'thingId' in s ? s.thingId.toLowerCase() : null;
  await requireDocumentModule(tx, client, scope, locationId, thingId, 'write');
  await requireWriter(client, locationId);
  const title = titleFor(body.kind, body.title);
  const money = await costFor(
    tx,
    client,
    scope,
    locationId,
    body,
    { issued_on: null, cost: null, currency: null },
    body.expiresOn,
  );
  await client.query(
    `INSERT INTO public.expiring_documents
       (id, location_id, thing_id, place_id, kind, title, expires_on, lead_days, issued_on, cost,
        currency, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, kept.current_user_id())`,
    [
      body.id,
      locationId,
      thingId,
      'placeId' in s ? s.placeId.toLowerCase() : null,
      body.kind,
      title,
      body.expiresOn,
      body.leadDays ?? 30,
      money.issued_on,
      money.cost,
      money.currency,
    ],
  );
  const row = await readDocumentRow(client, body.id);
  await audited(tx, {
    locationId,
    actor: { type: 'user', id: scope.userId },
    action: 'document.create',
    entity: { type: 'expiring_document', id: row.id },
    after: imageOf(row),
    subjects: thingOf(row),
    rootThingId: row.thing_id,
    requestId,
  });
  return documentView(tx, client, files, scope, row.id);
}

const COLUMN_OF = {
  kind: 'kind',
  title: 'title',
  expiresOn: 'expires_on',
  leadDays: 'lead_days',
  issuedOn: 'issued_on',
  cost: 'cost',
  currency: 'currency',
} as const;

export async function updateDocument(
  tx: Tx,
  client: pg.ClientBase,
  files: FileStorage | null,
  scope: Scope,
  id: string,
  expected: number,
  body: UpdateDocumentBody,
  requestId: string,
): Promise<ExpiringDocument> {
  const seen = await readDocumentRow(client, id);
  await requireDocumentModule(tx, client, scope, seen.location_id, seen.thing_id, 'write');
  await requireWriter(client, seen.location_id);
  const before = await lockDocumentRow(client, id);
  const fields = (Object.keys(COLUMN_OF) as (keyof typeof COLUMN_OF)[]).filter(
    (k) => body[k] !== undefined,
  );
  await stale(client, before, expected, fields);
  const kind = body.kind ?? before.kind;
  const title = titleFor(kind, body.title === undefined ? before.title : body.title);
  const expiresOn = body.expiresOn ?? before.expires_on;
  const money = await costFor(tx, client, scope, before.location_id, body, before, expiresOn);
  const next = {
    kind,
    title,
    expires_on: expiresOn,
    lead_days: body.leadDays ?? before.lead_days,
  };
  await client.query(
    `UPDATE public.expiring_documents
        SET kind = $2, title = $3, expires_on = $4, lead_days = $5, issued_on = $6, cost = $7,
            currency = $8
      WHERE id = $1`,
    [
      id,
      next.kind,
      next.title,
      next.expires_on,
      next.lead_days,
      money.issued_on,
      money.cost,
      money.currency,
    ],
  );
  const after = await readDocumentRow(client, id);
  await audited(tx, {
    locationId: after.location_id,
    actor: { type: 'user', id: scope.userId },
    action: 'document.update',
    entity: { type: 'expiring_document', id },
    before: imageOf(before),
    after: imageOf(after),
    subjects: thingOf(after),
    rootThingId: after.thing_id,
    requestId,
    undoableUntil: undoableUntil(),
  });
  return documentView(tx, client, files, scope, id);
}

/** An attachment as a deleted document's event keeps it, for the undo to put it back. */
export type HeldAttachment = {
  id: string;
  file_id: string | null;
  url: string | null;
  role: string;
  sort: number;
};

export async function deleteDocument(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  id: string,
  expected: number,
  requestId: string,
): Promise<void> {
  const seen = await readDocumentRow(client, id);
  await requireDocumentModule(tx, client, scope, seen.location_id, seen.thing_id, 'write');
  await requireWriter(client, seen.location_id);
  const row = await lockDocumentRow(client, id);
  await stale(client, row, expected, []);
  // Removing a cost the caller can't see would erase money they never saw.
  if (row.cost !== null && !(await gateFor(tx, row.location_id, scope)).showMoney) {
    throw moneyOff();
  }
  const { rows: attachments } = await client.query<HeldAttachment>(
    `SELECT id, file_id, url, role, sort FROM public.attachments
      WHERE expiring_document_id = $1 ORDER BY sort, created_at, id`,
    [id],
  );
  // The terms this one renewed: their superseded_by_id goes back to null with it (0053's
  // ON DELETE SET NULL), so the previous term is current again; the undo points them back.
  const { rows: renewed } = await client.query<{ id: string }>(
    'SELECT id FROM public.expiring_documents WHERE superseded_by_id = $1 ORDER BY id',
    [id],
  );
  await client.query('DELETE FROM public.expiring_documents WHERE id = $1', [id]);
  await audited(tx, {
    locationId: row.location_id,
    actor: { type: 'user', id: scope.userId },
    action: 'document.delete',
    entity: { type: 'expiring_document', id },
    before: {
      ...imageOf(row),
      attachments,
      renewed_from: renewed.map((r) => r.id),
    },
    after: null,
    subjects: thingOf(row),
    rootThingId: row.thing_id,
    requestId,
    undoableUntil: undoableUntil(),
  });
}

export async function renewDocument(
  tx: Tx,
  client: pg.ClientBase,
  files: FileStorage | null,
  scope: Scope,
  id: string,
  expected: number,
  body: RenewDocumentBody,
  requestId: string,
): Promise<{ renewed: ExpiringDocument; previous: ExpiringDocument }> {
  const seen = await readDocumentRow(client, id);
  await requireDocumentModule(tx, client, scope, seen.location_id, seen.thing_id, 'write');
  await requireWriter(client, seen.location_id);
  const old = await lockDocumentRow(client, id);
  await stale(client, old, expected, ['expiresOn']);
  if (old.superseded_by_id) throw conflict('This was already renewed; renew the current one.');
  const newIdValue = body.id ?? newId();
  // The new term's own issue date and cost (Q5): what this renewal cost, counted in its month.
  const money = await costFor(
    tx,
    client,
    scope,
    old.location_id,
    body,
    { issued_on: null, cost: null, currency: null },
    body.expiresOn,
  );
  await client.query(
    `INSERT INTO public.expiring_documents
       (id, location_id, thing_id, place_id, kind, title, expires_on, lead_days, issued_on, cost,
        currency, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, kept.current_user_id())`,
    [
      newIdValue,
      old.location_id,
      old.thing_id,
      old.place_id,
      old.kind,
      old.title,
      body.expiresOn,
      body.leadDays ?? old.lead_days,
      money.issued_on,
      money.cost,
      money.currency,
    ],
  );
  await client.query('UPDATE public.expiring_documents SET superseded_by_id = $2 WHERE id = $1', [
    id,
    newIdValue,
  ]);
  const renewed = await readDocumentRow(client, newIdValue);
  const previous = await readDocumentRow(client, id);
  await audited(tx, {
    locationId: old.location_id,
    actor: { type: 'user', id: scope.userId },
    action: 'document.renew',
    entity: { type: 'expiring_document', id },
    before: { superseded_by_id: null },
    after: {
      superseded_by_id: newIdValue,
      renewed_expires_on: renewed.expires_on,
      renewed_lead_days: renewed.lead_days,
      ...(renewed.issued_on ? { renewed_issued_on: renewed.issued_on } : {}),
      ...(renewed.cost !== null ? { renewed_cost: renewed.cost } : {}),
    },
    fieldClasses: { renewed_cost: 'money' },
    subjects: thingOf(old),
    rootThingId: old.thing_id,
    requestId,
    undoableUntil: undoableUntil(),
  });
  const [r, p] = await documentViews(tx, client, files, scope, [renewed, previous]);
  if (!r || !p) throw notFound();
  return { renewed: r, previous: p };
}
