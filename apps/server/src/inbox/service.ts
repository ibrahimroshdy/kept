import {
  aliasSuggestionLanguage,
  DOCUMENT_KINDS,
  MarkSeenPayload,
  MovePayload,
  NotHerePayload,
  newId,
  normalize,
  type OpKind,
  type Role,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { actorOf } from '../audit/actor.js';
import { audited, undoableEventIds } from '../audit/audited.js';
import { lastChangedBy } from '../audit/undo.js';
import type { Scope, Tx } from '../db/scope.js';
import { createAttachment } from '../files/attachments.js';
import { checkVersion } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound, pgErrorOf } from '../http/errors.js';
import { locationModuleSet } from '../http/modules.js';
import type { JobQueue } from '../jobs/queue.js';
import { requireCan, requireMembership } from '../locations/access.js';
import { moveProofToReading } from '../meters/proofs.js';
import {
  acceptReading,
  createReading,
  deleteReading,
  recordReplacement,
  updateReading,
} from '../meters/service.js';
import { createDocument } from '../paperwork/documents.js';
import { restorePlace } from '../places/service.js';
import { updatePurchase } from '../purchases/service.js';
import { type PatchBody, purchaseRow } from '../purchases/view.js';
import { enqueueReindex } from '../search/jobs.js';
import { gateFor } from '../serialize/gates.js';
import type { FileStorage } from '../storage/blob-store.js';
import { moveThings } from '../things/move.js';
import { markNotHere, markSeen, updateThing, writableThing } from '../things/service.js';
import { UpdateBody } from '../things/validate.js';
import { restoreThing, trashThing } from '../trash/service.js';
import { type InboxItem, ITEM_COLUMNS, type ItemRow, itemsOf, LIVE_SUBJECT } from './view.js';

// The inbox's one-item actions (plan T15; D18, D19, D35, D36, D52, D112, D150, D189; screens §5,
// §8). Every one takes the item's `rowVersion` as If-Match (412 when it moved on), runs as the
// caller on kept_app, and is audited: the change it makes through the step-2 service that owns
// it (`thing.update`, `thing.trash`, `purchase.update`, `reading.accept`, …), and the item's
// resolution as `inbox.resolve` {kind, resolution}.
//
// An item is addressed only while it is open and its subject is live (view.ts LIVE_SUBJECT):
// anything else, and anything in a location the caller can't write (inbox_items' policy), is
// the same 404 as a random id.
//
// - accept (draft): the accepted suggestions and `set` are one `thing.update` (undoable, D150)
//   with `review_state = 'confirmed'` and the field provenance in the same event, so undoing it
//   puts the draft back. A vehicle card's `document` suggestion (step 5, Q15) becomes an
//   expiring document with the card's photo (acceptDocument). A thing needs a name: 400 without one. The auto-applied fields become
//   `confirmed`, the accepted ones `confirmed`, and what `set` typed `manual`. Rejected and
//   accepted suggestions leave the payload; the item resolves `edited` with a `set`, otherwise
//   `accepted`.
// - discard (draft): the draft goes to the trash (`thing.trash`, undoable). The item is left
//   open behind it, hidden like any item whose draft is in the trash, so the Undo toast brings
//   both back; it goes with the draft when the trash is purged.
// - currency: the draft purchase's currency, then the amounts AI read that waited for it (§7.8).
// - merge (duplicate): `into` is the survivor, either side of the pair; the other is merged into
//   it by kept.merge_things() (D36, Q16), audited `thing.merge` with both as subjects.
//   not-duplicate resolves `dismissed`.
// - reading: Keep, Edit, Discard and "Meter replaced" are step 2's reading actions (D52, D112).
//   A reading AI couldn't read (`needs_value`) is kept by typing its value.
// - restore (sync drop, D35): the trashed target comes back (step 2's restore), then the dropped
//   op is applied again through its replayer; `{outcome}`.
// - dismiss: a label claim keeps its pending ID; a sync drop accepts the drop. A draft can't be
//   dismissed: it is accepted or discarded.

export type Ctx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  jobs: JobQueue | null;
  files: FileStorage | null;
};

export type ActionResult = { item?: InboxItem; undo?: { eventId: string; until: string } };

const actor = (scope: Scope) => actorOf(scope);

// ---------------------------------------------------------------------------------------------
// The item
// ---------------------------------------------------------------------------------------------

export type OpenItem = ItemRow & { role: Role };

/** The open item `id` the caller may review, locked; 404 otherwise. `expected` is If-Match. */
export async function openItem(
  client: pg.ClientBase,
  id: string,
  expected: number | null,
  opts: { lock?: boolean } = {},
): Promise<OpenItem> {
  const { rows } = await client.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS}, up.display_name AS created_by_name
       FROM public.inbox_items i
       LEFT JOIN public.user_profiles up ON up.user_id = i.created_by
      WHERE i.id = $1 AND ${LIVE_SUBJECT}
      ${opts.lock === false ? '' : 'FOR UPDATE OF i'}`,
    [id],
  );
  const item = rows[0];
  if (!item) throw notFound();
  const { role } = await requireMembership(client, item.location_id);
  requireCan(role, 'things.edit', 'Viewers have no inbox.');
  if (expected !== null && item.row_version !== expected) {
    const who = await lastChangedBy(client, item.location_id, { type: 'inbox_item', id });
    checkVersion({ rowVersion: item.row_version }, expected, [], who ? { displayName: who } : null);
  }
  return { ...item, role };
}

/** 409 unless the item is of one of `kinds`. */
function requireKind(item: ItemRow, ...kinds: ItemRow['kind'][]): void {
  if (!kinds.includes(item.kind)) {
    throw conflict(`This action doesn't apply to a ${item.kind.replace('_', ' ')} item.`);
  }
}

/** Resolves the item, audited `inbox.resolve`. */
export async function resolveItem(
  ctx: Pick<Ctx, 'tx' | 'client' | 'scope' | 'requestId'>,
  item: ItemRow,
  resolution: 'accepted' | 'edited' | 'discarded' | 'merged' | 'linked' | 'restored' | 'dismissed',
  undoable: Date | null = null,
): Promise<void> {
  await ctx.client.query(
    `UPDATE public.inbox_items
        SET resolved_at = now(), resolved_by = kept.current_user_id(), resolution = $2
      WHERE id = $1`,
    [item.id, resolution],
  );
  await audited(ctx.tx, {
    locationId: item.location_id,
    actor: actor(ctx.scope),
    action: 'inbox.resolve',
    entity: { type: 'inbox_item', id: item.id },
    before: { kind: item.kind, resolution: null },
    after: { kind: item.kind, resolution },
    requestId: ctx.requestId,
    undoableUntil: undoable,
  });
}

/** Sets payload keys of an open item (its row version moves on). */
async function patchPayload(
  client: pg.ClientBase,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await client.query('UPDATE public.inbox_items SET payload = payload || $2::jsonb WHERE id = $1', [
    id,
    JSON.stringify(patch),
  ]);
}

/** The item as it is now, for an action that leaves it open. */
async function nowOf(ctx: Ctx, id: string): Promise<InboxItem | undefined> {
  const { rows } = await ctx.client.query<ItemRow>(
    `SELECT ${ITEM_COLUMNS}, up.display_name AS created_by_name
       FROM public.inbox_items i
       LEFT JOIN public.user_profiles up ON up.user_id = i.created_by
      WHERE i.id = $1 AND ${LIVE_SUBJECT}`,
    [id],
  );
  const [item] = await itemsOf(ctx.tx, ctx.client, ctx.scope, ctx.files, rows);
  return item;
}

/** The undo reference of the undoable event this transaction wrote last. */
async function undoRef(ctx: Ctx): Promise<ActionResult['undo']> {
  const eventId = undoableEventIds(ctx.tx).at(-1);
  if (!eventId) return undefined;
  const { rows } = await ctx.client.query<{ until: Date | null }>(
    'SELECT undoable_until AS until FROM public.audit_events WHERE id = $1',
    [eventId],
  );
  const until = rows[0]?.until;
  return until ? { eventId, until: until.toISOString() } : undefined;
}

// ---------------------------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------------------------

export const AcceptBody = z.strictObject({
  accept: z.array(z.string().min(1).max(64)).max(50).optional(),
  reject: z.array(z.string().min(1).max(64)).max(50).optional(),
  set: z.record(z.string(), z.unknown()).optional(),
});
export type AcceptBody = z.infer<typeof AcceptBody>;

type Suggestion = {
  field: string;
  value: unknown;
  confidence?: number;
  source?: { extractionId?: string; attachmentId?: string };
};

/**
 * A suggested field as an edit of the thing (web contract `Suggestion`; T10's fields). An alias
 * (`alias_<lang>`, D214) joins the thing's own aliases in that language, `aliases` the thing's.
 */
function suggestedEdit(s: Suggestion, aliases: Record<string, string[]>): Record<string, unknown> {
  const v = s.value;
  const lang = aliasSuggestionLanguage(s.field);
  if (lang) {
    const have = aliases[lang] ?? [];
    const alias = String(v).trim();
    const known = have.some((a) => normalize(a) === normalize(alias));
    return { aliases: { [lang]: known ? have : [...have, alias] } };
  }
  switch (s.field) {
    case 'name':
    case 'model':
    case 'colour':
    case 'serial':
      return { [s.field]: String(v) };
    case 'quantity':
      return { quantity: Number(v) };
    case 'expires_on':
      return { expiresOn: String(v) };
    case 'vin':
    case 'plate':
    case 'manufactured_on':
      return { custom: { [s.field]: String(v) } };
    default:
      throw invalid(`Check accept: ${s.field} is set on the thing's page, not accepted here.`);
  }
}

/** The field_status key an edit's body key stands for. */
const STATUS_KEY: Readonly<Record<string, string>> = Object.freeze({
  name: 'name',
  brandId: 'brand',
  model: 'model',
  colour: 'colour',
  typeId: 'type',
  serial: 'serial',
  quantity: 'quantity',
  expiresOn: 'expires_on',
});

/** POST /api/v1/inbox/:id/accept. */
export async function accept(ctx: Ctx, id: string, expected: number, body: AcceptBody) {
  const item = await openItem(ctx.client, id, expected);
  requireKind(item, 'draft');
  if (!item.thing_id) throw notFound();
  const thing = await writableThing(ctx.client, item.thing_id, 'things.edit');
  const suggestions: Suggestion[] = Array.isArray(item.payload.suggestions)
    ? (item.payload.suggestions as Suggestion[]).filter((s) => typeof s?.field === 'string')
    : [];
  const byField = new Map(suggestions.map((s) => [s.field, s]));
  const accepted = [...new Set(body.accept ?? [])];
  const rejected = new Set(body.reject ?? []);
  for (const f of [...accepted, ...rejected]) {
    if (!byField.has(f)) throw invalid(`Check accept and reject: nothing suggests ${f}.`);
  }
  if (accepted.some((f) => rejected.has(f))) {
    throw invalid('Check accept and reject: a field is one or the other.');
  }

  const { rows } = await ctx.client.query<{
    field_status: Record<string, Record<string, unknown>>;
    aliases: Record<string, string[]> | null;
  }>('SELECT field_status, aliases FROM public.things WHERE id = $1', [thing.id]);

  // The edit: what `set` typed wins over a suggestion for the same field.
  const set = body.set ?? {};
  const edit: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  const aliases: Record<string, string[]> = {};
  for (const f of accepted) {
    // Step 5 (Q15): a vehicle's card becomes a document, below, not an edit of the thing.
    if (f === 'document') continue;
    const e = suggestedEdit(byField.get(f) as Suggestion, rows[0]?.aliases ?? {});
    if (e.custom) Object.assign(custom, e.custom);
    else if (e.aliases) Object.assign(aliases, e.aliases);
    else Object.assign(edit, e);
  }
  if (Object.keys(aliases).length > 0) edit.aliases = aliases;
  Object.assign(edit, set);
  if (Object.keys(custom).length > 0 || set.custom) {
    edit.custom = { ...custom, ...((set.custom as Record<string, unknown>) ?? {}) };
  }
  let patch: UpdateBody = {} as UpdateBody;
  if (Object.keys(edit).length > 0) {
    const parsed = UpdateBody.safeParse(edit);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw invalid(`Check ${['set', ...(issue?.path ?? [])].join('.')}: ${issue?.message ?? ''}`);
    }
    patch = parsed.data;
  }
  const name = patch.name ?? thing.name;
  if (!name?.trim()) throw invalid('A thing needs a name.');

  // Provenance: AI's values confirmed, the accepted ones confirmed, what was typed manual.
  const status: Record<string, Record<string, unknown>> = { ...(rows[0]?.field_status ?? {}) };
  for (const [field, st] of Object.entries(status)) {
    if (st?.state === 'extracted') status[field] = { ...st, state: 'confirmed' };
  }
  for (const f of accepted) {
    if (f === 'document') continue;
    const s = byField.get(f) as Suggestion;
    status[aliasSuggestionLanguage(f) ? 'aliases' : f] = {
      state: 'confirmed',
      ...(typeof s.confidence === 'number' ? { confidence: s.confidence } : {}),
      ...(s.source?.extractionId ? { extraction_id: s.source.extractionId } : {}),
    };
  }
  for (const key of Object.keys(set)) {
    const field = STATUS_KEY[key];
    if (field) status[field] = { state: 'manual' };
  }

  await updateThing(ctx, thing.id, thing.row_version, patch, 'thing.update', {
    reviewState: 'confirmed',
    fieldStatus: status,
  });
  if (accepted.includes('document')) {
    await acceptDocument(ctx, thing, byField.get('document') as Suggestion);
  }
  await patchPayload(ctx.client, item.id, {
    suggestions: suggestions.filter((s) => !accepted.includes(s.field) && !rejected.has(s.field)),
    decided: { accepted, rejected: [...rejected] },
  });
  await resolveItem(ctx, item, Object.keys(set).length > 0 ? 'edited' : 'accepted');
  return {};
}

const DocumentValue = z.object({ kind: z.enum(DOCUMENT_KINDS), expiresOn: z.iso.date() });

/**
 * Step 5 (T10; D52; Q15): a vehicle's registration, insurance, licence or inspection card read
 * in LABEL mode, accepted, becomes an expiring document on the thing (step 4's create,
 * paperwork/documents.ts, audited `document.create`), and the card's photo is attached to it as
 * `registration` (audited `attachment.create`). The photo stays the thing's too: the label's
 * extraction reads it, and removing it would take the extraction with it. A document on a
 * vehicle needs Paperwork or Vehicles on (409 `module_off`).
 */
async function acceptDocument(
  ctx: Ctx,
  thing: { id: string; location_id: string },
  s: Suggestion,
): Promise<void> {
  const parsed = DocumentValue.safeParse(s.value);
  if (!parsed.success) throw invalid('Check accept: this document suggestion is not valid.');
  const modules = await locationModuleSet(ctx.tx, thing.location_id);
  if (!modules?.has('paperwork') && !modules?.has('vehicles')) {
    throw new AppError('module_off', 409, 'Turn on Paperwork or Vehicles to keep this document.');
  }
  const doc = await createDocument(
    ctx.tx,
    ctx.client,
    ctx.files,
    ctx.scope,
    {
      id: newId(),
      subject: { thingId: thing.id },
      kind: parsed.data.kind,
      expiresOn: parsed.data.expiresOn,
    },
    ctx.requestId,
  );
  const attachmentId = s.source?.attachmentId;
  if (!attachmentId) return;
  const { rows } = await ctx.client.query<{ file_id: string | null }>(
    'SELECT file_id FROM public.attachments WHERE id = $1 AND location_id = $2',
    [attachmentId, thing.location_id],
  );
  const fileId = rows[0]?.file_id;
  if (!fileId) return;
  await createAttachment(
    ctx.tx,
    ctx.client,
    ctx.files,
    (loc) => gateFor(ctx.tx, loc, ctx.scope),
    ctx.scope.userId,
    {
      id: newId(),
      locationId: thing.location_id,
      fileId,
      subject: { expiringDocumentId: doc.id },
      role: 'registration',
    },
    ctx.requestId,
  );
}

// ---------------------------------------------------------------------------------------------
// discard, dismiss, not a duplicate
// ---------------------------------------------------------------------------------------------

/** POST /api/v1/inbox/:id/discard: the draft to the trash; the item waits hidden behind it. */
export async function discard(ctx: Ctx, id: string, expected: number): Promise<ActionResult> {
  const item = await openItem(ctx.client, id, expected);
  requireKind(item, 'draft');
  if (!item.thing_id) throw notFound();
  await trashThing(ctx, item.thing_id, {});
  await audited(ctx.tx, {
    locationId: item.location_id,
    actor: actor(ctx.scope),
    action: 'inbox.discard',
    entity: { type: 'inbox_item', id: item.id },
    after: { kind: item.kind, thing_id: item.thing_id },
    requestId: ctx.requestId,
  });
  const undo = await undoRef(ctx);
  return undo ? { undo } : {};
}

/** POST /api/v1/inbox/:id/dismiss. */
export async function dismiss(ctx: Ctx, id: string, expected: number): Promise<ActionResult> {
  const item = await openItem(ctx.client, id, expected);
  if (item.kind === 'draft') {
    throw conflict('Accept this draft, or discard it.');
  }
  await resolveItem(ctx, item, 'dismissed');
  return {};
}

/** POST /api/v1/inbox/:id/not-duplicate. */
export async function notDuplicate(ctx: Ctx, id: string, expected: number): Promise<ActionResult> {
  const item = await openItem(ctx.client, id, expected);
  requireKind(item, 'duplicate');
  await resolveItem(ctx, item, 'dismissed');
  return {};
}

// ---------------------------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------------------------

export const MergeBody = z.strictObject({ into: z.uuid() });

const MERGE_CONFLICTS: Readonly<Record<string, string>> = Object.freeze({
  things_no_loop: "A thing can't be merged into one that is inside it.",
  things_merge_meters: 'Both things have meters. Remove one first.',
  things_quantity_one: 'A thing with a meter has a quantity of 1.',
});

/** POST /api/v1/inbox/:id/merge. */
export async function merge(
  ctx: Ctx,
  id: string,
  expected: number,
  body: z.infer<typeof MergeBody>,
): Promise<ActionResult> {
  const item = await openItem(ctx.client, id, expected);
  requireKind(item, 'duplicate');
  const into = body.into.toLowerCase();
  const pair = [item.thing_id, item.other_thing_id].filter((x): x is string => !!x);
  if (pair.length !== 2 || !pair.includes(into)) throw notFound();
  const from = pair.find((x) => x !== into) as string;
  await writableThing(ctx.client, into, 'things.edit');
  await writableThing(ctx.client, from, 'things.trash');
  let moved = 0;
  try {
    await ctx.client.query('SAVEPOINT inbox_merge');
    const { rows } = await ctx.client.query<{ n: number }>(
      'SELECT kept.merge_things($1, $2) AS n',
      [from, into],
    );
    await ctx.client.query('RELEASE SAVEPOINT inbox_merge');
    moved = rows[0]?.n ?? 0;
  } catch (err) {
    await ctx.client.query('ROLLBACK TO SAVEPOINT inbox_merge');
    const pg = pgErrorOf(err);
    if (pg?.code === '42501') throw notFound();
    const hint = pg?.constraint ? MERGE_CONFLICTS[pg.constraint] : undefined;
    if (hint) throw conflict(hint);
    throw err;
  }
  const { rows: gone } = await ctx.client.query<{ deleted_at: Date }>(
    'SELECT deleted_at FROM public.things WHERE id = $1',
    [from],
  );
  await audited(ctx.tx, {
    locationId: item.location_id,
    actor: actor(ctx.scope),
    action: 'thing.merge',
    entity: { type: 'thing', id: from },
    before: { deleted_at: null, merged_into_id: null },
    after: { deleted_at: gone[0]?.deleted_at ?? null, merged_into_id: into, moved },
    rootThingId: into,
    subjects: [from, into],
    requestId: ctx.requestId,
  });
  // Contents, codes and names moved: the search documents and breadcrumbs follow (T20).
  await enqueueReindex(ctx.jobs, ctx.client, item.location_id);
  await resolveItem(ctx, item, 'merged');
  return {};
}

// ---------------------------------------------------------------------------------------------
// currency
// ---------------------------------------------------------------------------------------------

export const CurrencyBody = z.strictObject({ currency: z.string().trim().min(1).max(8) });

type ReadFields = {
  total?: { value?: unknown };
  tax?: { value?: unknown };
  lines?: {
    unitPrice?: { value?: unknown };
    lineTotal?: { value?: unknown };
    quantity?: { value?: unknown };
  }[];
};

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const money4 = (n: number) => (Math.round(n * 10_000) / 10_000).toFixed(4);

/** What AI read of a receipt: the item's latest attempt's fields. */
async function readFields(client: pg.ClientBase, item: ItemRow): Promise<ReadFields> {
  const exId =
    typeof item.payload.extractionId === 'string' ? item.payload.extractionId : item.extraction_id;
  if (!exId) return {};
  const { rows } = await client.query<{ result: { mode?: string; fields?: ReadFields } | null }>(
    `SELECT result FROM public.extractions WHERE id = $1 AND status = 'succeeded'`,
    [exId],
  );
  const r = rows[0]?.result;
  return r?.mode === 'receipt' ? (r.fields ?? {}) : {};
}

const purchaseCtx = (ctx: Ctx) => ({
  tx: ctx.tx,
  client: ctx.client,
  scope: ctx.scope,
  requestId: ctx.requestId,
  files: ctx.files,
});

/** POST /api/v1/inbox/:id/currency: the currency, then the amounts that waited for it. */
export async function setCurrency(
  ctx: Ctx,
  id: string,
  expected: number,
  body: z.infer<typeof CurrencyBody>,
): Promise<ActionResult> {
  const item = await openItem(ctx.client, id, expected);
  requireKind(item, 'currency', 'receipt');
  if (!item.purchase_id) throw notFound();
  const p = await purchaseRow(ctx.client, item.purchase_id);
  const read = await readFields(ctx.client, item);
  const patch: PatchBody = { currency: body.currency };
  const total = num(read.total?.value);
  const tax = num(read.tax?.value);
  if (p.total === null && total !== null) patch.total = money4(total);
  if (p.tax === null && tax !== null) patch.tax = money4(tax);
  const { rows: lines } = await ctx.client.query<{ id: string; unit_price: string | null }>(
    `SELECT id, unit_price::text AS unit_price FROM public.purchase_lines
      WHERE purchase_id = $1 ORDER BY sort, id`,
    [item.purchase_id],
  );
  if (lines.some((l) => l.unit_price === null) && read.lines?.length) {
    // Every line is named, or the PATCH would remove it; a price only where none is stored.
    patch.lines = lines.map((l, i) => {
      const r = read.lines?.[i];
      const unit = num(r?.unitPrice?.value);
      const lineTotal = num(r?.lineTotal?.value);
      const q = num(r?.quantity?.value) || 1;
      const price = unit ?? (lineTotal !== null ? lineTotal / q : null);
      return l.unit_price === null && price !== null
        ? { id: l.id, unitPrice: money4(price) }
        : { id: l.id };
    });
  }
  await updatePurchase(purchaseCtx(ctx), item.purchase_id, p.row_version, patch);
  if (item.kind === 'currency') {
    await resolveItem(ctx, item, 'accepted');
    return {};
  }
  return { item: await nowOf(ctx, item.id) };
}

// ---------------------------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------------------------

const Decimal = z
  .string()
  .trim()
  .regex(/^\d{1,11}(\.\d{1,3})?$/, 'a number, e.g. 52340');

export const ReadingBody = z.strictObject({
  action: z.enum(['keep', 'edit', 'discard', 'meter_replaced']),
  value: Decimal.optional(),
  takenAt: z.iso.datetime({ offset: true }).optional(),
  offset: z
    .string()
    .trim()
    .regex(/^-?\d{1,11}(\.\d{1,3})?$/, 'a number, e.g. 120000')
    .optional(),
});
export type ReadingBody = z.infer<typeof ReadingBody>;

/** POST /api/v1/inbox/:id/reading. */
export async function reading(
  ctx: Ctx,
  id: string,
  expected: number,
  body: ReadingBody,
): Promise<ActionResult> {
  const item = await openItem(ctx.client, id, expected);
  requireKind(item, 'reading');
  const rctx = { tx: ctx.tx, client: ctx.client, scope: ctx.scope, requestId: ctx.requestId };

  // A reading AI couldn't read: kept by typing its value, or discarded.
  if (!item.meter_reading_id) {
    const meterId = typeof item.payload.meterId === 'string' ? item.payload.meterId : null;
    if (body.action === 'discard') {
      await resolveItem(ctx, item, 'discarded');
      return {};
    }
    if (!meterId) throw notFound();
    if (body.action === 'meter_replaced' || !body.value) {
      throw invalid('Check value: type what the meter shows.');
    }
    const takenAt =
      body.takenAt ??
      (typeof item.payload.takenAt === 'string' ? item.payload.takenAt : null) ??
      item.created_at.toISOString();
    const made = await createReading(rctx, meterId, { value: body.value, takenAt }, 'photo');
    // Step 5 (Q10, D195): the photo it was read from proves that reading now.
    if (typeof item.payload.attachmentId === 'string') {
      await moveProofToReading(ctx.client, item.payload.attachmentId, made.reading.id);
    }
    await resolveItem(ctx, item, 'edited');
    return {};
  }

  const readingId = item.meter_reading_id;
  switch (body.action) {
    case 'keep': {
      await acceptReading(rctx, readingId);
      await resolveItem(ctx, item, 'accepted');
      return {};
    }
    case 'discard': {
      // The reading's delete takes its item with it (inbox_items_meter_reading_fk): resolve first,
      // so the audit says how it left.
      await resolveItem(ctx, item, 'discarded');
      // A fill's or a service's reading that landed here is its owner's; the owner follows (Q11).
      await deleteReading(rctx, readingId, { owned: 'allow' });
      return {};
    }
    case 'edit': {
      if (body.value === undefined && body.takenAt === undefined) {
        throw invalid('Check value: send the value, or when it was taken.');
      }
      const r = await updateReading(
        rctx,
        readingId,
        {
          ...(body.value !== undefined ? { value: body.value } : {}),
          ...(body.takenAt !== undefined ? { takenAt: body.takenAt } : {}),
        },
        null,
        { owned: 'allow' },
      );
      if (r.state === 'accepted') {
        await resolveItem(ctx, item, 'edited');
        return {};
      }
      // Still out of line (a jump): it keeps waiting, with the new verdict.
      await patchPayload(ctx.client, item.id, {
        value: r.value,
        takenAt: r.takenAt,
        reason: r.reviewReason ?? 'ai_read',
      });
      return { item: await nowOf(ctx, item.id) };
    }
    case 'meter_replaced': {
      if (body.offset === undefined) {
        throw invalid('Check offset: what the new meter counted from.');
      }
      const { rows } = await ctx.client.query<{ meter_id: string; value: string; taken_at: Date }>(
        `SELECT meter_id, trim_scale(value)::text AS value, taken_at FROM public.meter_readings
          WHERE id = $1`,
        [readingId],
      );
      const r = rows[0];
      if (!r) throw notFound();
      // Replaced just before this reading was taken, unless the person says when.
      const at = body.takenAt ?? new Date(r.taken_at.getTime() - 1000).toISOString();
      await recordReplacement(rctx, r.meter_id, { at, offset: body.offset }, null);
      const placed = await updateReading(
        rctx,
        readingId,
        { value: r.value, takenAt: r.taken_at.toISOString() },
        null,
        { owned: 'allow' },
      );
      if (placed.state !== 'accepted') await acceptReading(rctx, readingId);
      await resolveItem(ctx, item, 'accepted');
      return {};
    }
  }
}

// ---------------------------------------------------------------------------------------------
// restore (a sync drop)
// ---------------------------------------------------------------------------------------------

export type ReplayOutcome = 'applied' | 'needs_review' | 'dropped';

/**
 * Applies a dropped op again (D35 "one-tap restore"), after its target is back. Keyed by op kind;
 * T14 registers the kinds it applies (its own handlers, sync/handlers/index.ts), replacing the
 * defaults below. `meta.locationId` is the item's location: the op's own, which some payloads
 * (a capture into the Unplaced area) don't name.
 */
export type OpReplayer = (
  ctx: Ctx,
  payload: unknown,
  meta: { locationId: string },
) => Promise<ReplayOutcome>;

const REPLAYERS = new Map<OpKind, OpReplayer>();

/** Registers (or replaces) the replayer of an op kind. */
export function registerOpReplayer(op: OpKind, fn: OpReplayer): void {
  REPLAYERS.set(op, fn);
}

// The ops a trashed target can drop that step 2's services apply as they are.
registerOpReplayer('move', async (ctx, payload) => {
  const p = MovePayload.safeParse(payload);
  if (!p.success) return 'dropped';
  await moveThings(ctx, {
    thingIds: p.data.thingIds,
    to: p.data.to,
    ...(p.data.quantity !== undefined ? { quantity: Number(p.data.quantity) } : {}),
  });
  return 'applied';
});
registerOpReplayer('mark_seen', async (ctx, payload) => {
  const p = MarkSeenPayload.safeParse(payload);
  if (!p.success) return 'dropped';
  await markSeen(ctx, p.data.thingId);
  return 'applied';
});
registerOpReplayer('not_here', async (ctx, payload) => {
  const p = NotHerePayload.safeParse(payload);
  if (!p.success) return 'dropped';
  await markNotHere(ctx, p.data.thingId);
  return 'applied';
});

/**
 * POST /api/v1/inbox/:id/restore. The item's payload (T14 writes it): `{op: {op, payload},
 * reason, entity?: {type: 'thing' | 'place', id, name}, by?: {displayName}}`.
 */
export async function restore(
  ctx: Ctx,
  id: string,
  expected: number,
): Promise<{ outcome: ReplayOutcome }> {
  const item = await openItem(ctx.client, id, expected);
  requireKind(item, 'sync_drop');
  const entity = (item.payload.entity ?? {}) as { type?: unknown; id?: unknown };
  const tctx = { ...ctx };
  if (typeof entity.id === 'string' && (entity.type === 'thing' || entity.type === 'place')) {
    const table = entity.type === 'thing' ? 'things' : 'places';
    const { rows } = await ctx.client.query<{ deleted: boolean }>(
      `SELECT deleted_at IS NOT NULL AS deleted FROM public.${table} WHERE id = $1`,
      [entity.id],
    );
    if (rows[0]?.deleted) {
      if (entity.type === 'thing') await restoreThing(tctx, entity.id);
      else await restorePlace(tctx, entity.id);
    }
  }
  const op = (item.payload.op ?? {}) as { op?: unknown; payload?: unknown };
  const replay = typeof op.op === 'string' ? REPLAYERS.get(op.op as OpKind) : undefined;
  let outcome: ReplayOutcome = 'dropped';
  if (replay) {
    await ctx.client.query('SAVEPOINT inbox_replay');
    try {
      outcome = await replay(ctx, op.payload, { locationId: item.location_id });
      await ctx.client.query('RELEASE SAVEPOINT inbox_replay');
    } catch (err) {
      // Refused again (gone, not allowed, a conflict): the drop stands and the item stays.
      await ctx.client.query('ROLLBACK TO SAVEPOINT inbox_replay');
      if (!(err instanceof AppError) && !pgErrorOf(err)) throw err;
      outcome = 'dropped';
    }
  }
  if (outcome === 'dropped') {
    await audited(ctx.tx, {
      locationId: item.location_id,
      actor: actor(ctx.scope),
      action: 'inbox.restore',
      entity: { type: 'inbox_item', id: item.id },
      after: { kind: item.kind, outcome },
      requestId: ctx.requestId,
    });
  } else {
    await resolveItem(ctx, item, 'restored');
  }
  return { outcome };
}
