import { type FuelUnit, isDateFilterValue, newId, pricePerUnit } from '@kept/shared';
import type pg from 'pg';
import { actorOf } from '../audit/actor.js';
import { audited } from '../audit/audited.js';
import { lastChangedBy, undoableUntil } from '../audit/undo.js';
import { createAttachment } from '../files/attachments.js';
import { MONEY_ROLES } from '../files/views.js';
import { assertClientId, checkVersion, decodeCursor, encodeCursor } from '../http/conventions.js';
import { invalid, notFound } from '../http/errors.js';
import { attachProof } from '../meters/proofs.js';
import { createReading, updateReading } from '../meters/service.js';
import { whenDays } from '../meters/when.js';
import { createItem } from '../registries/service.js';
import type { Ctx } from '../schedules/service.js';
import { thumbKeysOf, thumbUrlOf } from '../search/service.js';
import { gateFor } from '../serialize/gates.js';
import { requireRole } from '../things/service.js';
import { moneyOff, requireCurrencies } from '../things/validate.js';
import { fillMeter, liveThingOf } from '../vehicles/meters.js';

// Fuel and charging (step-5 plan T11; D11, D28, D76, D112, D150, D170; Q3, Q6, Q7, Q11, Q14,
// Q22). A fill or a charge of a vehicle, in litres, kWh or US gallons as entered, with its cost,
// whether it filled up, whether a fill-up was missed before it, the station and its odometer.
// The route (fuel/routes.ts) and step 6's `log_fuel` tool (tools/handlers/vehicles.ts) both call
// logFuel(): one implementation (§2.5).
//
// - The module is `fuel` (which needs `vehicles`), gated by the route's config and the tool's
//   contract. Adding a fill is `logs.add`; changing or removing your own `logs.edit-own`, anyone's
//   `logs.edit-delete-others` (the policies say the same, 0065).
// - The odometer is a meter_readings row (`source = 'fuel'`) made through the meters' own entry
//   (meters/service.ts createReading) in the same transaction, on the thing's odometer unless the
//   body names another of its meters. A value that runs backwards is refused at entry, nothing
//   written: 409 `conflict` with `reason` and the neighbour, as the meters section refuses it
//   (step 4's code; plan notes: no `reading_refused`). The fill owns its reading (Q11): changed
//   through the fill, deleted with it.
// - Money (the cost) is written only by someone whose gate shows money (409 `module_off`), in an
//   enabled currency (the location's by default); the database checks only that the code exists.
//   Money leaves only through the gate: `moneyHidden: true` and no cost, price or receipt.
// - The station is a vendor of the location's account (D11): `{id}`, or `{name}`, reused when
//   the account already has a vendor by that name, else created inline with kind `station`.
// - Every write is undoable for 7 days (fuel/undo.ts): `fuel.create` (the fill and its reading
//   go), `fuel.update` (the fields and the reading go back), `fuel.delete` (both come back,
//   refused when the reading no longer fits).

export const FUEL_ENTITY = 'fuel_entry';
/** A fill's reading source (0017's meter_readings_source_chk has `fuel`). */
const FUEL_SOURCE = 'fuel' as const;

const actor = (ctx: Pick<Ctx, 'scope'>) => actorOf(ctx.scope);

// ---------------------------------------------------------------------------------------------
// Views (apps/web/src/api/vehicles/types.ts FuelRow)
// ---------------------------------------------------------------------------------------------

export type FuelRow = {
  id: string;
  takenAt: string;
  amount: string;
  unit: FuelUnit;
  isFull: boolean;
  missedBefore: boolean;
  cost?: string;
  currency?: string;
  moneyHidden?: true;
  pricePerUnit?: string;
  vendor?: { id: string; name: string };
  reading?: { id: string; value: string; state: 'accepted' | 'needs_review' };
  receipt?: { attachmentId: string; fileId: string; thumbUrl: string | null };
  loggedBy: { displayName: string };
  rowVersion: number;
};

export type EntryRecord = {
  id: string;
  location_id: string;
  thing_id: string;
  taken_at: Date;
  amount: string;
  unit: FuelUnit;
  is_full: boolean;
  missed_before: boolean;
  cost: string | null;
  currency: string | null;
  vendor_id: string | null;
  vendor_name: string | null;
  meter_reading_id: string | null;
  reading_value: string | null;
  reading_state: 'accepted' | 'needs_review' | null;
  reading_meter_id: string | null;
  note: string | null;
  logged_by: string;
  logged_by_name: string | null;
  row_version: number;
  receipt_id: string | null;
  receipt_file_id: string | null;
};

export const ENTRY_SELECT = `SELECT f.id, f.location_id, f.thing_id, f.taken_at,
       trim_scale(f.amount)::text AS amount, f.unit, f.is_full, f.missed_before,
       trim_scale(f.cost)::text AS cost, f.currency, f.vendor_id, v.name AS vendor_name,
       f.meter_reading_id, trim_scale(r.value)::text AS reading_value, r.state AS reading_state,
       r.meter_id AS reading_meter_id, f.note, f.logged_by, up.display_name AS logged_by_name,
       f.row_version, rc.id AS receipt_id, rc.file_id AS receipt_file_id
  FROM public.fuel_entries f
  LEFT JOIN public.vendors v ON v.id = f.vendor_id
  LEFT JOIN public.meter_readings r ON r.id = f.meter_reading_id
  LEFT JOIN public.user_profiles up ON up.user_id = f.logged_by
  LEFT JOIN LATERAL (
    SELECT a.id, a.file_id FROM public.attachments a
     WHERE a.fuel_entry_id = f.id AND a.role = 'receipt' AND a.file_id IS NOT NULL
     ORDER BY a.sort, a.created_at, a.id LIMIT 1) rc ON true`;

export async function entryRecord(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<EntryRecord> {
  if (lock) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM public.fuel_entries WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!rowCount) throw notFound();
  }
  const { rows } = await client.query<EntryRecord>(`${ENTRY_SELECT} WHERE f.id = $1`, [id]);
  const row = rows[0];
  if (!row) throw notFound();
  return row;
}

/** Rows as the caller may see them: money (cost, price, the receipt) only through the gate. */
export async function fuelRowsOf(
  ctx: Pick<Ctx, 'tx' | 'client' | 'scope' | 'files'>,
  records: readonly EntryRecord[],
): Promise<FuelRow[]> {
  const shows = new Map<string, boolean>();
  for (const loc of new Set(records.map((r) => r.location_id))) {
    shows.set(loc, (await gateFor(ctx.tx, loc, ctx.scope)).showMoney);
  }
  const receipts = records.flatMap((r) =>
    shows.get(r.location_id) && r.receipt_file_id ? [r.receipt_file_id] : [],
  );
  const keys = await thumbKeysOf(ctx.client, ctx.files ? receipts : []);
  const out: FuelRow[] = [];
  for (const r of records) {
    const money = shows.get(r.location_id) === true;
    const price = money ? pricePerUnit(r) : null;
    out.push({
      id: r.id,
      takenAt: r.taken_at.toISOString(),
      amount: r.amount,
      unit: r.unit,
      isFull: r.is_full,
      missedBefore: r.missed_before,
      ...(money
        ? r.cost !== null && r.currency !== null
          ? { cost: r.cost, currency: r.currency }
          : {}
        : { moneyHidden: true as const }),
      ...(price ? { pricePerUnit: price.amount } : {}),
      ...(r.vendor_id && r.vendor_name !== null
        ? { vendor: { id: r.vendor_id, name: r.vendor_name } }
        : {}),
      ...(r.meter_reading_id && r.reading_value !== null && r.reading_state
        ? { reading: { id: r.meter_reading_id, value: r.reading_value, state: r.reading_state } }
        : {}),
      ...(money && r.receipt_id && r.receipt_file_id
        ? {
            receipt: {
              attachmentId: r.receipt_id,
              fileId: r.receipt_file_id,
              thumbUrl: await thumbUrlOf(ctx.files, keys, r.receipt_file_id),
            },
          }
        : {}),
      loggedBy: { displayName: r.logged_by_name ?? '' },
      rowVersion: r.row_version,
    });
  }
  return out;
}

export async function fuelRow(ctx: Ctx, id: string): Promise<FuelRow> {
  const [row] = await fuelRowsOf(ctx, [await entryRecord(ctx.client, id)]);
  if (!row) throw notFound();
  return row;
}

/** A fill's audit image: its columns as stored, and its reading's value (Q11). */
export const imageOf = (r: EntryRecord) => ({
  thing_id: r.thing_id,
  taken_at: r.taken_at.toISOString(),
  amount: r.amount,
  unit: r.unit,
  cost: r.cost,
  currency: r.currency,
  is_full: r.is_full,
  missed_before: r.missed_before,
  vendor_id: r.vendor_id,
  meter_reading_id: r.meter_reading_id,
  reading_value: r.reading_value,
  note: r.note,
});
export type FuelImage = ReturnType<typeof imageOf>;

// ---------------------------------------------------------------------------------------------
// Pieces of a write
// ---------------------------------------------------------------------------------------------

/** D112: nothing is taken later than the server received it. */
const clampToNow = (at: Date, now = new Date()) => (at.getTime() > now.getTime() ? now : at);

export type StationInput = { id: string } | { name: string };

/** The station a body names: an existing vendor of the account (the guard refuses another
 * account's: a 404), else the account's vendor by that name, else a new one, kind `station`. */
async function stationFor(
  ctx: Ctx,
  locationId: string,
  input: StationInput | null | undefined,
): Promise<string | null> {
  if (!input) return null;
  if ('id' in input) return input.id.toLowerCase();
  const name = input.name.trim();
  const { rows } = await ctx.client.query<{ account_id: string; vendor_id: string | null }>(
    `SELECT l.owner_account_id AS account_id,
            (SELECT v.id FROM public.vendors v
              WHERE v.owner_account_id = l.owner_account_id
                AND kept.normalize(v.name) = kept.normalize($2)
              ORDER BY v.created_at, v.id LIMIT 1) AS vendor_id
       FROM public.locations l WHERE l.id = $1`,
    [locationId, name],
  );
  const found = rows[0];
  if (!found) throw notFound();
  if (found.vendor_id) return found.vendor_id;
  const created = await createItem(
    {
      tx: ctx.tx,
      client: ctx.client,
      userId: ctx.scope.userId,
      requestId: ctx.requestId,
      jobs: ctx.jobs,
    },
    'vendors',
    found.account_id,
    { name, kind: 'station' },
  );
  return created.item.id;
}

/** The cost and currency to store. A cost is written only where the caller sees money, in an
 * enabled currency (the location's unless the body names one); a currency alone changes nothing
 * on a fill without a cost. */
async function moneyFor(
  ctx: Ctx,
  locationId: string,
  body: { cost?: string | null | undefined; currency?: string | null | undefined },
  current: { cost: string | null; currency: string | null },
): Promise<{ cost: string | null; currency: string | null }> {
  const touched =
    body.cost !== undefined ||
    (body.currency !== undefined && body.currency !== null && current.cost !== null);
  if (!touched) return current;
  if (!(await gateFor(ctx.tx, locationId, ctx.scope)).showMoney) throw moneyOff();
  const cost = body.cost !== undefined ? body.cost : current.cost;
  if (cost === null) return { cost: null, currency: null };
  let currency = body.currency?.toUpperCase() ?? current.currency;
  if (!currency) {
    const { rows } = await ctx.client.query<{ currency: string }>(
      'SELECT currency FROM public.locations WHERE id = $1',
      [locationId],
    );
    currency = rows[0]?.currency ?? null;
  }
  if (!currency) throw invalid('Send body.currency with the cost.');
  await requireCurrencies(ctx.client, [currency], 'body.currency');
  return { cost, currency };
}

async function attach(
  ctx: Ctx,
  locationId: string,
  fileId: string,
  subject: { fuelEntryId: string },
  role: 'receipt',
): Promise<void> {
  await createAttachment(
    ctx.tx,
    ctx.client,
    ctx.files,
    (loc) => gateFor(ctx.tx, loc, ctx.scope),
    ctx.scope.userId,
    { id: newId(), locationId, fileId, subject, role },
    ctx.requestId,
  );
}

/**
 * A fill the caller may change, locked: 404 when they can't see it; their own needs
 * `logs.edit-own`, anyone else's `logs.edit-delete-others` (a 403). The role comes before the
 * lock: under RLS a refused FOR UPDATE finds nothing, which would turn the 403 into a 404.
 */
async function changeableEntry(ctx: Ctx, id: string): Promise<EntryRecord> {
  const seen = await entryRecord(ctx.client, id);
  const mine = seen.logged_by === ctx.scope.userId;
  await requireRole(
    ctx.client,
    seen.location_id,
    mine ? 'logs.edit-own' : 'logs.edit-delete-others',
  );
  return entryRecord(ctx.client, id, true);
}

async function requireVersion(
  client: pg.ClientBase,
  row: EntryRecord,
  expected: number,
  fields: readonly string[],
): Promise<void> {
  if (row.row_version === expected) return;
  const by = await lastChangedBy(client, row.location_id, { type: FUEL_ENTITY, id: row.id });
  checkVersion({ rowVersion: row.row_version }, expected, fields, by ? { displayName: by } : null);
}

// ---------------------------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------------------------

export type CreateFuelInput = {
  id?: string | undefined;
  takenAt: string;
  amount: string;
  unit: FuelUnit;
  cost?: string | undefined;
  currency?: string | undefined;
  isFull: boolean;
  missedBefore?: boolean | undefined;
  vendor?: StationInput | undefined;
  reading?:
    | { meterId?: string | undefined; value: string; proofFileId?: string | undefined }
    | undefined;
  receiptFileId?: string | undefined;
  note?: string | undefined;
};

export type Undo = { eventId: string; until: string };

export type CreateFuelResult = {
  entry: FuelRow;
  reading?: { id: string; state: 'accepted' | 'needs_review'; reason?: string };
  undo: Undo;
};

/**
 * POST /api/v1/things/:id/fuel → 201 {entry, reading?, undo}, and step 6's `log_fuel`. The fill,
 * its reading (through the meters' entry: backwards is 409 with nothing written) and its
 * receipt, in one transaction, audited `fuel.create`, undoable.
 */
export async function logFuel(
  ctx: Ctx,
  thingId: string,
  body: CreateFuelInput,
): Promise<CreateFuelResult> {
  const { client } = ctx;
  const thing = await liveThingOf(client, thingId);
  const locationId = thing.location_id;
  await requireRole(client, locationId, 'logs.add');
  const id = body.id ? assertClientId(body.id) : newId();
  const takenAt = clampToNow(new Date(body.takenAt));
  const money = await moneyFor(ctx, locationId, body, { cost: null, currency: null });
  const vendorId = await stationFor(ctx, locationId, body.vendor);

  let reading: CreateFuelResult['reading'];
  if (body.reading) {
    const meter = await fillMeter(client, thing.id, body.reading.meterId);
    // The proof photo hangs on the reading it proves (D195, Q10; meters/proofs.ts).
    const made = await createReading(
      ctx,
      meter.id,
      {
        value: body.reading.value,
        takenAt: takenAt.toISOString(),
        proofFileId: body.reading.proofFileId,
      },
      FUEL_SOURCE,
    );
    reading = {
      id: made.reading.id,
      state: made.state,
      ...(made.reason ? { reason: made.reason } : {}),
    };
  }

  await client.query(
    `INSERT INTO public.fuel_entries (id, location_id, thing_id, taken_at, amount, unit, currency,
                                      cost, is_full, missed_before, vendor_id, meter_reading_id,
                                      note, logged_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, kept.current_user_id())`,
    [
      id,
      locationId,
      thing.id,
      takenAt,
      body.amount,
      body.unit,
      money.currency,
      money.cost,
      body.isFull,
      body.missedBefore ?? false,
      vendorId,
      reading?.id ?? null,
      body.note ?? null,
    ],
  );
  if (body.receiptFileId) {
    await attach(ctx, locationId, body.receiptFileId, { fuelEntryId: id }, 'receipt');
  }
  const after = imageOf(await entryRecord(client, id));
  const until = undoableUntil();
  const event = await audited(ctx.tx, {
    locationId,
    actor: actor(ctx),
    action: 'fuel.create',
    entity: { type: FUEL_ENTITY, id },
    after: { ...after, reading_created: reading !== undefined },
    subjects: [thing.id],
    rootThingId: thing.id,
    requestId: ctx.requestId,
    undoableUntil: until,
  });
  return {
    entry: await fuelRow(ctx, id),
    ...(reading ? { reading } : {}),
    undo: { eventId: event.id, until: until.toISOString() },
  };
}

// ---------------------------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------------------------

/** PATCH's body: the POST's fields but `id`; `cost` and `note` may also be cleared (null). */
export type UpdateFuelInput = Partial<Omit<CreateFuelInput, 'id' | 'cost' | 'note'>> & {
  cost?: string | null | undefined;
  note?: string | null | undefined;
};

const FIELDS: readonly (keyof UpdateFuelInput)[] = [
  'takenAt',
  'amount',
  'unit',
  'cost',
  'currency',
  'isFull',
  'missedBefore',
  'vendor',
  'reading',
  'receiptFileId',
  'note',
];

/**
 * PATCH /api/v1/fuel/:id (If-Match) → FuelRow. A changed odometer or time re-places the fill's
 * own reading through the meters' check (409 when it runs backwards; Q11: the fill is how its
 * reading changes). A new receipt replaces the old one. Audited `fuel.update`, undoable.
 */
export async function updateFuel(
  ctx: Ctx,
  id: string,
  expected: number,
  body: UpdateFuelInput,
): Promise<FuelRow> {
  const { client } = ctx;
  const row = await changeableEntry(ctx, id);
  const fields = FIELDS.filter((k) => body[k] !== undefined);
  await requireVersion(client, row, expected, fields);
  if (fields.length === 0) return fuelRow(ctx, id);
  const before = imageOf(row);
  const locationId = row.location_id;
  const money = await moneyFor(ctx, locationId, body, { cost: row.cost, currency: row.currency });
  const vendorId =
    body.vendor === undefined ? row.vendor_id : await stationFor(ctx, locationId, body.vendor);
  const takenAt =
    body.takenAt !== undefined ? clampToNow(new Date(body.takenAt)) : new Date(row.taken_at);

  let readingId = row.meter_reading_id;
  let readingCreated = false;
  if (body.reading) {
    const meter = await fillMeter(
      client,
      row.thing_id,
      body.reading.meterId ?? row.reading_meter_id,
    );
    if (readingId && row.reading_meter_id && meter.id !== row.reading_meter_id) {
      throw invalid("Check body.reading.meterId: a fill's reading stays on its meter.");
    }
    if (readingId) {
      // The fill owns its reading (Q11): changed here, through its owner, placed again.
      await updateReading(
        ctx,
        readingId,
        { value: body.reading.value, takenAt: takenAt.toISOString() },
        null,
        { owned: 'allow' },
      );
    } else {
      const made = await createReading(
        ctx,
        meter.id,
        { value: body.reading.value, takenAt: takenAt.toISOString() },
        FUEL_SOURCE,
      );
      readingId = made.reading.id;
      readingCreated = true;
    }
    if (body.reading.proofFileId) {
      await attachProof(client, locationId, readingId, body.reading.proofFileId);
    }
  } else if (body.takenAt !== undefined && readingId) {
    await updateReading(ctx, readingId, { takenAt: takenAt.toISOString() }, null, {
      owned: 'allow',
    });
  }

  await client.query(
    `UPDATE public.fuel_entries
        SET taken_at = $2, amount = $3, unit = $4, currency = $5, cost = $6, is_full = $7,
            missed_before = $8, vendor_id = $9, meter_reading_id = $10,
            note = CASE WHEN $11 THEN $12 ELSE note END
      WHERE id = $1`,
    [
      id,
      takenAt,
      body.amount ?? row.amount,
      body.unit ?? row.unit,
      money.currency,
      money.cost,
      body.isFull ?? row.is_full,
      body.missedBefore ?? row.missed_before,
      vendorId,
      readingId,
      body.note !== undefined,
      body.note ?? null,
    ],
  );
  if (body.receiptFileId !== undefined) {
    // A receipt is money: replacing it is a money write (createAttachment refuses it where money
    // is hidden, and so does this).
    if (!(await gateFor(ctx.tx, locationId, ctx.scope)).showMoney) throw moneyOff();
    await client.query(
      `DELETE FROM public.attachments WHERE fuel_entry_id = $1 AND role = 'receipt'`,
      [id],
    );
    await attach(ctx, locationId, body.receiptFileId, { fuelEntryId: id }, 'receipt');
  }
  const after = imageOf(await entryRecord(client, id));
  await audited(ctx.tx, {
    locationId,
    actor: actor(ctx),
    action: 'fuel.update',
    entity: { type: FUEL_ENTITY, id },
    before,
    after: { ...after, ...(readingCreated ? { reading_created: true } : {}) },
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    undoableUntil: undoableUntil(),
  });
  return fuelRow(ctx, id);
}

// ---------------------------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------------------------

/** An attachment as a deleted fill's event keeps it, for the undo to put it back. */
export type HeldAttachment = {
  id: string;
  file_id: string | null;
  url: string | null;
  role: string;
  sort: number;
};

/** A deleted fill's reading, as its event keeps it (Q14). */
export type HeldReading = {
  id: string;
  meter_id: string;
  value: string;
  taken_at: string;
  state: string;
  review_reason: string | null;
  note: string | null;
  proofs: HeldAttachment[];
};

/**
 * DELETE /api/v1/fuel/:id (If-Match) → {undo}. A real delete (Q14): its reading and receipt go
 * with it; the event holds all three, and undo puts them back (refused when the reading no longer
 * fits the series). Removing a cost or a receipt the caller can't see is refused (409).
 */
export async function deleteFuel(ctx: Ctx, id: string, expected: number): Promise<{ undo: Undo }> {
  const { client } = ctx;
  const row = await changeableEntry(ctx, id);
  await requireVersion(client, row, expected, []);
  const image = imageOf(row);
  const held = async (column: 'fuel_entry_id' | 'meter_reading_id', subject: string) =>
    (
      await client.query<HeldAttachment>(
        `SELECT id, file_id, url, role, sort FROM public.attachments WHERE ${column} = $1
          ORDER BY sort, created_at, id`,
        [subject],
      )
    ).rows;
  const attachments = await held('fuel_entry_id', id);
  if (row.cost !== null || attachments.some((a) => (MONEY_ROLES as string[]).includes(a.role))) {
    if (!(await gateFor(ctx.tx, row.location_id, ctx.scope)).showMoney) throw moneyOff();
  }
  let reading: HeldReading | null = null;
  if (row.meter_reading_id) {
    const { rows } = await client.query<
      Omit<HeldReading, 'proofs' | 'taken_at'> & { taken_at: Date }
    >(
      `SELECT id, meter_id, trim_scale(value)::text AS value, taken_at, state, review_reason, note
         FROM public.meter_readings WHERE id = $1`,
      [row.meter_reading_id],
    );
    const r = rows[0];
    if (r) {
      reading = {
        ...r,
        taken_at: r.taken_at.toISOString(),
        proofs: await held('meter_reading_id', r.id),
      };
    }
  }
  await client.query('DELETE FROM public.fuel_entries WHERE id = $1', [id]);
  if (reading) {
    await client.query('DELETE FROM public.meter_readings WHERE id = $1', [reading.id]);
  }
  const until = undoableUntil();
  const event = await audited(ctx.tx, {
    locationId: row.location_id,
    actor: actor(ctx),
    action: 'fuel.delete',
    entity: { type: FUEL_ENTITY, id },
    before: { ...image, attachments, reading },
    after: null,
    subjects: [row.thing_id],
    rootThingId: row.thing_id,
    requestId: ctx.requestId,
    undoableUntil: until,
  });
  return { undo: { eventId: event.id, until: until.toISOString() } };
}

// ---------------------------------------------------------------------------------------------
// The list (the `fuel` surface, D205, D211)
// ---------------------------------------------------------------------------------------------

export type FuelListQuery = {
  limit: number;
  cursor?: string | undefined;
  'f.when'?: string | undefined;
  'f.unit'?: FuelUnit[] | undefined;
  'f.vendor'?: string[] | undefined;
  /** `1`: full fills; `0`: partial. */
  'f.full'?: '0' | '1' | undefined;
  not?: ('when' | 'unit' | 'vendor' | 'full')[] | undefined;
  sort?: 'takenAt' | 'amount' | 'cost' | undefined;
  dir?: 'asc' | 'desc' | undefined;
};

/**
 * GET /api/v1/things/:id/fuel → `{items, next_cursor}`: newest first unless `dir=asc`, or by
 * amount, or by cost where the caller sees money (an order is money too; else by date). `f.when`
 * is in the location's days.
 */
export async function listFuel(
  ctx: Ctx,
  thingId: string,
  page: FuelListQuery,
): Promise<{ items: FuelRow[]; next_cursor: string | null }> {
  const { client } = ctx;
  const thing = await liveThingOf(client, thingId);
  const byCost =
    page.sort === 'cost' && (await gateFor(ctx.tx, thing.location_id, ctx.scope)).showMoney;
  const sort = page.sort === 'amount' ? 'amount' : byCost ? 'cost' : 'takenAt';
  const key =
    sort === 'amount' ? 'f.amount' : sort === 'cost' ? 'coalesce(f.cost, 0)' : 'f.taken_at';
  const keyText =
    sort === 'takenAt'
      ? `to_char(f.taken_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      : `trim_scale(${key})::text`;
  const cast = sort === 'takenAt' ? 'timestamptz' : 'numeric';
  let after: [string, string] | null = null;
  if (page.cursor) {
    const raw = decodeCursor<unknown>(page.cursor);
    if (
      !Array.isArray(raw) ||
      raw.length !== 2 ||
      typeof raw[0] !== 'string' ||
      typeof raw[1] !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(raw[1]) ||
      !(sort === 'takenAt' ? /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/ : /^\d{1,12}(\.\d{1,4})?$/).test(raw[0])
    ) {
      throw invalid('The cursor is not valid; start again from the first page.');
    }
    after = raw as [string, string];
  }
  const args: unknown[] = [thing.id];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  const not = new Set<string>(page.not ?? []);
  const where = ['f.thing_id = $1'];
  const filter = (name: string, cond: string) =>
    where.push(not.has(name) ? `NOT coalesce(${cond}, false)` : cond);
  const when = page['f.when'];
  if (when) {
    if (!isDateFilterValue(when)) {
      throw invalid('f.when is today, week, month, year or YYYY-MM-DD..YYYY-MM-DD.');
    }
    const { rows: tz } = await client.query<{ timezone: string; today: string }>(
      `SELECT timezone, (now() AT TIME ZONE timezone)::date::text AS today
         FROM public.locations WHERE id = $1`,
      [thing.location_id],
    );
    const zone = tz[0]?.timezone ?? 'UTC';
    const { from, to } = whenDays(when, tz[0]?.today ?? new Date().toISOString().slice(0, 10));
    const z = arg(zone);
    const parts = [
      ...(from ? [`f.taken_at >= (${arg(from)}::date::timestamp AT TIME ZONE ${z})`] : []),
      ...(to ? [`f.taken_at < ((${arg(to)}::date + 1)::timestamp AT TIME ZONE ${z})`] : []),
    ];
    if (parts.length > 0) filter('when', `(${parts.join(' AND ')})`);
  }
  if (page['f.unit']?.length) filter('unit', `f.unit = ANY (${arg(page['f.unit'])}::text[])`);
  if (page['f.vendor']?.length) {
    const ids = page['f.vendor'].map((v) => v.toLowerCase());
    filter('vendor', `f.vendor_id = ANY (${arg(ids)}::uuid[])`);
  }
  if (page['f.full']) filter('full', `f.is_full = ${page['f.full'] === '1' ? 'true' : 'false'}`);
  const asc = page.dir === 'asc';
  if (after) {
    where.push(
      `(${key}, f.id) ${asc ? '>' : '<'} (${arg(after[0])}::${cast}, ${arg(after[1])}::uuid)`,
    );
  }
  const dir = asc ? 'ASC' : 'DESC';
  const { rows } = await client.query<EntryRecord & { sort_key: string }>(
    `${ENTRY_SELECT.replace('SELECT f.id,', `SELECT ${keyText} AS sort_key, f.id,`)}
      WHERE ${where.join(' AND ')}
      ORDER BY ${key} ${dir}, f.id ${dir}
      LIMIT ${arg(page.limit + 1)}`,
    args,
  );
  const items = rows.slice(0, page.limit);
  const last = items.at(-1);
  return {
    items: await fuelRowsOf(ctx, items),
    next_cursor: rows.length > page.limit && last ? encodeCursor([last.sort_key, last.id]) : null,
  };
}
