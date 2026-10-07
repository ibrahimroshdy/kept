import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';
import { renderAudit } from '../audit/render.js';
import { withScope } from '../db/scope.js';

// Task 12 through the front door: purchases with lines, their links to things, and money gating
// (D13, D110, D115, D136, D168, D189; plan Q2), as the web contract has them
// (apps/web/src/api/inventory/types.ts, "currencies and purchases").
//
// The household: Bob owns "Bob home" and "Bob cabin" (household preset: money on) and "Bob shed"
// (essentials: money off). In the home Adam is an admin, Mel a member and Vic a viewer; Mel is
// also a member of the shed; Cal is a member of the cabin only. Ann has her own account and sees
// nothing of Bob's. Rows the routes don't create are seeded as kept_owner.

let db: TestDb;
let t: TestApp;
let ann: Person;
let bob: Person;
let adam: Person;
let mel: Person;
let vic: Person;
let cal: Person;
let home: string;
let cabin: string;
let shed: string;
let vendor: string;
let annVendor: string;

type Line = {
  id: string;
  description: string;
  quantity: number;
  unitPrice?: string;
  moneyHidden?: true;
  thing: { id: string; name: string } | null;
};
type Purchase = {
  id: string;
  locationId: string;
  vendor: { id: string; name: string } | null;
  purchasedOn: string;
  currency: string | null;
  total?: string;
  tax?: string;
  moneyHidden?: true;
  notes: string | null;
  lines: Line[];
  receipts: { id: string; role: string; subject: { purchaseId?: string } }[];
  flagged: boolean;
  rowVersion: number;
};

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

async function createLocation(as: Person, name: string, preset: string): Promise<string> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: { name, kind: 'home', preset, timezone: 'Africa/Cairo', currency: 'EGP', rooms: [] },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

/** A live thing in the location's Unplaced area, seeded as kept_owner. */
async function thing(locationId: string, name = 'Thing'): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name)
     VALUES ($1, $2, (SELECT id FROM public.places WHERE location_id = $2 AND is_unplaced), $3)`,
    [id, locationId, name],
  );
  return id;
}

async function lineOf(thingId: string): Promise<string | null> {
  const [row] = await own<{ purchase_line_id: string | null }>(
    'SELECT purchase_line_id FROM public.things WHERE id = $1',
    [thingId],
  );
  return row?.purchase_line_id ?? null;
}

/** The audit rows of an entity, oldest first. */
function auditOf(entityId: string) {
  return own<{
    action: string;
    location_id: string | null;
    actor_id: string;
    diff: Record<string, Record<string, unknown>>;
  }>(
    `SELECT action, location_id, actor_id, diff FROM public.audit_events
      WHERE entity_id = $1 ORDER BY at, id`,
    [entityId],
  );
}

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());

async function create(as: Person, body: object): Promise<Purchase> {
  const res = await call(t, '/api/v1/purchases', { as, body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Purchase;
}

async function get(as: Person, id: string): Promise<Purchase> {
  const res = await call(t, `/api/v1/purchases/${id}`, { as });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Purchase;
}

const patch = (as: Person, id: string, version: number | null, body: object) =>
  call(t, `/api/v1/purchases/${id}`, {
    as,
    method: 'PATCH',
    body,
    ...(version === null ? {} : { headers: { 'if-match': String(version) } }),
  });

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  adam = await person(t, db, 'adam');
  mel = await person(t, db, 'mel');
  vic = await person(t, db, 'vic');
  cal = await person(t, db, 'cal');
  home = await createLocation(bob, 'Bob home', 'household');
  cabin = await createLocation(bob, 'Bob cabin', 'household');
  shed = await createLocation(bob, 'Bob shed', 'essentials');
  await join(db, home, adam.userId, 'admin');
  await join(db, home, mel.userId, 'member');
  await join(db, home, vic.userId, 'viewer');
  await join(db, shed, mel.userId, 'member');
  await join(db, cabin, cal.userId, 'member');
  vendor = newId();
  annVendor = newId();
  await own(
    `INSERT INTO public.vendors (id, owner_account_id, name)
     VALUES ($1, (SELECT owner_account_id FROM public.locations WHERE id = $2), 'Carrefour'),
            ($3, (SELECT owner_account_id FROM public.locations WHERE id = $4), 'Ann shop')`,
    [vendor, home, annVendor, ann.personalLocationId],
  );
});

describe('POST /api/v1/purchases', () => {
  // catalogue: POST /api/v1/purchases
  it('records a purchase with lines, links a thing, and audits money as money', async () => {
    const kettle = await thing(home, 'Kettle');
    const p = await create(mel, {
      locationId: home,
      vendorId: vendor,
      purchasedOn: today(),
      currency: 'egp',
      total: '1250.50',
      tax: '150',
      notes: 'Summer sale',
      lines: [
        { description: 'Kettle', quantity: 1, unitPrice: '1100.5', thingId: kettle },
        { description: 'Descaler', quantity: 2 },
      ],
    });
    expect(p).toMatchObject({
      locationId: home,
      vendor: { id: vendor, name: 'Carrefour' },
      purchasedOn: today(),
      currency: 'EGP',
      total: '1250.5',
      tax: '150',
      notes: 'Summer sale',
      flagged: false,
      rowVersion: expect.any(Number),
      receipts: [],
    });
    expect(p).not.toHaveProperty('moneyHidden');
    expect(p.lines).toEqual([
      {
        id: expect.any(String),
        description: 'Kettle',
        quantity: 1,
        unitPrice: '1100.5',
        thing: { id: kettle, name: 'Kettle' },
      },
      { id: expect.any(String), description: 'Descaler', quantity: 2, thing: null },
    ]);
    expect(await lineOf(kettle)).toBe(p.lines[0]?.id);

    const [created] = await auditOf(p.id);
    expect(created?.action).toBe('purchase.create');
    expect(created?.location_id).toBe(home);
    expect(created?.actor_id).toBe(mel.userId);
    expect(created?.diff.total).toEqual({ before: null, after: '1250.5', class: 'money' });
    expect(created?.diff.tax).toEqual({ before: null, after: '150', class: 'money' });
    expect(created?.diff.currency).toEqual({ before: null, after: 'EGP', class: 'plain' });
    const [line] = await auditOf(p.lines[0]?.id as string);
    expect(line?.action).toBe('purchase_line.create');
    expect(line?.diff.unit_price).toEqual({ before: null, after: '1100.5', class: 'money' });
    const linked = await auditOf(kettle);
    expect(linked.map((e) => e.action)).toEqual(['thing.purchase_link']);
    expect(linked[0]?.diff.purchase_line_id).toMatchObject({ after: p.lines[0]?.id });
  });

  it('reads amounts in Eastern Arabic digits and stores the canonical form (D172)', async () => {
    const p = await create(mel, {
      locationId: home,
      purchasedOn: today(),
      currency: 'USD',
      total: '١٬٢٣٤٫٥٠',
      lines: [{ description: 'مكواة', quantity: 1, unitPrice: '۱۲۳۴٫۵' }],
    });
    expect(p.total).toBe('1234.5');
    expect(p.lines[0]?.unitPrice).toBe('1234.5');
    const [row] = await own<{ total: string }>(
      'SELECT total::text AS total FROM public.purchases WHERE id = $1',
      [p.id],
    );
    expect(row?.total).toBe('1234.5000');
    const bad = await call(t, '/api/v1/purchases', {
      as: mel,
      body: { locationId: home, purchasedOn: today(), currency: 'USD', total: '1.23456' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().hint).toMatch(/body\.total/);
  });

  it('never picks a currency: amounts need one, "$" is refused, and it must be on', async () => {
    const base = { locationId: home, purchasedOn: today() };
    const none = await call(t, '/api/v1/purchases', { as: mel, body: { ...base, total: '10' } });
    expect(none.statusCode).toBe(400);
    expect(none.json().hint).toMatch(/currency/);
    const price = await call(t, '/api/v1/purchases', {
      as: mel,
      body: { ...base, lines: [{ description: 'Pen', quantity: 1, unitPrice: '3' }] },
    });
    expect(price.statusCode).toBe(400);
    const dollar = await call(t, '/api/v1/purchases', {
      as: mel,
      body: { ...base, currency: '$', total: '10' },
    });
    expect(dollar.statusCode).toBe(400);
    expect(dollar.json().hint).toMatch(/USD or CAD/);
    const off = await call(t, '/api/v1/purchases', {
      as: mel,
      body: { ...base, currency: 'TRY', total: '10' },
    });
    expect(off.statusCode).toBe(400);
    expect(off.json().hint).toMatch(/turned on/);
    // No amounts, no currency: fine.
    const plain = await create(mel, { ...base, lines: [{ description: 'Gift', quantity: 1 }] });
    expect(plain.currency).toBeNull();
    expect(plain).not.toHaveProperty('total');
  });

  it('refuses a purchase dated after today in the location’s time zone', async () => {
    const tomorrow = new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
    const res = await call(t, '/api/v1/purchases', {
      as: mel,
      body: { locationId: home, purchasedOn: tomorrow },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().hint).toMatch(/purchasedOn/);
  });

  it('flags lines that miss the total by more than 1%, with or without the tax', async () => {
    const lines = [{ description: 'Chair', quantity: 2, unitPrice: '100' }];
    const base = { locationId: home, purchasedOn: today(), currency: 'EUR', lines };
    expect((await create(mel, { ...base, total: '250' })).flagged).toBe(true);
    expect((await create(mel, { ...base, total: '202' })).flagged).toBe(false);
    expect((await create(mel, { ...base, total: '214', tax: '14' })).flagged).toBe(false);
    expect((await create(mel, { ...base, total: '230', tax: '14' })).flagged).toBe(true);
    // A line without a price can't be reconciled: never flagged.
    const partial = [...lines, { description: 'Cushion', quantity: 1 }];
    expect((await create(mel, { ...base, lines: partial, total: '999' })).flagged).toBe(false);
  });

  it('checks the vendor, the things and the caller', async () => {
    const base = { locationId: home, purchasedOn: today() };
    const foreign = await call(t, '/api/v1/purchases', {
      as: mel,
      body: { ...base, vendorId: annVendor },
    });
    expect(foreign.statusCode).toBe(400);
    const elsewhere = await thing(cabin, 'Cabin lamp');
    const cross = await call(t, '/api/v1/purchases', {
      as: bob,
      body: { ...base, lines: [{ description: 'Lamp', quantity: 1, thingId: elsewhere }] },
    });
    expect(cross.statusCode).toBe(400);
    expect(cross.json().hint).toMatch(/lines\[0\]\.thingId/);
    expect(await lineOf(elsewhere)).toBeNull();
    expect((await call(t, '/api/v1/purchases', { as: vic, body: base })).statusCode).toBe(403);
    expect((await call(t, '/api/v1/purchases', { as: ann, body: base })).statusCode).toBe(404);
  });
});

describe('money gating (§7.1, D13, D110)', () => {
  let bought: Purchase;
  let fridge: string;

  beforeAll(async () => {
    fridge = await thing(home, 'Fridge');
    bought = await create(bob, {
      locationId: home,
      vendorId: vendor,
      purchasedOn: today(),
      currency: 'GBP',
      total: '900',
      tax: '150',
      lines: [{ description: 'Fridge', quantity: 1, unitPrice: '900', thingId: fridge }],
    });
    const file = newId();
    const sha = createHash('sha256').update(file).digest('hex');
    await own(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 10, 'application/pdf', 'document', 'not_applicable', $5)`,
      [file, home, `f/${home}/${file}`, sha, bob.userId],
    );
    await own(
      `INSERT INTO public.attachments (location_id, file_id, purchase_id, role, created_by)
       VALUES ($1, $2, $3, 'receipt', $4)`,
      [home, file, bought.id, bob.userId],
    );
  });

  const setViewerToggle = (on: boolean) =>
    own('UPDATE public.locations SET money_visible_to_viewers = $2 WHERE id = $1', [home, on]);

  it('shows a member the whole purchase', async () => {
    const p = await get(mel, bought.id);
    expect(p).toMatchObject({ total: '900', tax: '150', flagged: false });
    expect(p.lines[0]?.unitPrice).toBe('900');
    expect(p.receipts).toHaveLength(1);
  });

  it('hides money from a viewer, and shows it while the location allows it (both ways)', async () => {
    const hidden = await get(vic, bought.id);
    expect(hidden).not.toHaveProperty('total');
    expect(hidden).not.toHaveProperty('tax');
    expect(hidden.moneyHidden).toBe(true);
    expect(hidden.lines[0]).not.toHaveProperty('unitPrice');
    expect(hidden.lines[0]?.moneyHidden).toBe(true);
    expect(hidden).toMatchObject({
      vendor: { id: vendor, name: 'Carrefour' },
      purchasedOn: today(),
      currency: 'GBP',
      flagged: false,
    });
    // A receipt shows the price: it goes with the amounts (security review #10).
    expect(hidden.receipts).toEqual([]);

    await setViewerToggle(true);
    const shown = await get(vic, bought.id);
    expect(shown).toMatchObject({ total: '900', tax: '150' });
    expect(shown.receipts).toHaveLength(1);
    expect(shown.lines[0]?.unitPrice).toBe('900');
    expect(shown).not.toHaveProperty('moneyHidden');

    await setViewerToggle(false);
    const again = await get(vic, bought.id);
    expect(again).not.toHaveProperty('total');
    expect(again.moneyHidden).toBe(true);
  });

  it('keeps money out of the audit for a viewer (renderAudit)', async () => {
    const rows = await own<Parameters<typeof renderAudit>[0] & Record<string, unknown>>(
      `SELECT id, at, location_id AS "locationId", owner_account_id AS "ownerAccountId",
              actor_type AS "actorType", actor_id AS "actorId", action,
              entity_type AS "entityType", entity_id AS "entityId", root_thing_id AS "rootThingId",
              diff, request_id AS "requestId", undo_of AS "undoOf",
              undoable_until AS "undoableUntil"
         FROM public.audit_events WHERE entity_id = $1 AND action = 'purchase.create'`,
      [bought.id],
    );
    const event = rows[0] as Parameters<typeof renderAudit>[0];
    const forViewer = renderAudit(event, { role: 'viewer', moneyVisibleToViewers: false });
    expect(forViewer.diff?.total).toEqual({ changed: true, class: 'money', hidden: true });
    expect(forViewer.diff?.tax).toEqual({ changed: true, class: 'money', hidden: true });
    expect(forViewer.diff?.currency).toEqual({ before: null, after: 'GBP', class: 'plain' });
    expect(JSON.stringify(forViewer)).not.toContain('"900"');
    const forMember = renderAudit(event, { role: 'member', moneyVisibleToViewers: false });
    expect(forMember.diff?.total).toEqual({ before: null, after: '900', class: 'money' });
  });

  it('with the money module off, a member sees date and vendor but no amounts or receipts', async () => {
    // The shed runs Essentials: money is off. Bob records a purchase there without amounts, then
    // amounts are put on it underneath (as an import or an earlier preset would leave them).
    const p = await create(mel, {
      locationId: shed,
      vendorId: vendor,
      purchasedOn: today(),
      currency: 'EGP',
      lines: [{ description: 'Rake', quantity: 1 }],
    });
    await own('UPDATE public.purchases SET total = 300 WHERE id = $1', [p.id]);
    await own('UPDATE public.purchase_lines SET unit_price = 300 WHERE purchase_id = $1', [p.id]);
    await own(
      `INSERT INTO public.attachments (location_id, url, purchase_id, role, created_by)
       VALUES ($1, 'https://example.com/r.pdf', $2, 'receipt', $3)`,
      [shed, p.id, mel.userId],
    );
    const seen = await get(mel, p.id);
    expect(seen).not.toHaveProperty('total');
    expect(seen.moneyHidden).toBe(true);
    expect(seen.lines[0]).not.toHaveProperty('unitPrice');
    expect(seen).toMatchObject({
      vendor: { id: vendor, name: 'Carrefour' },
      purchasedOn: today(),
      currency: 'EGP',
    });
    expect(seen.receipts).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain('"300"');

    // Writing money there is refused; editing the rest keeps the hidden price.
    const money = await call(t, '/api/v1/purchases', {
      as: mel,
      body: { locationId: shed, purchasedOn: today(), currency: 'EGP', total: '5' },
    });
    expect(money.statusCode).toBe(409);
    expect(money.json().code).toBe('module_off');
    const refused = await patch(mel, p.id, seen.rowVersion, { total: null });
    expect(refused.statusCode).toBe(409);
    // Changing the currency is a money write too (review #31): 409 whether or not hidden amounts
    // hang on it, so a 400 "amounts need a currency" can't say that they do.
    for (const currency of [null, 'USD']) {
      const res = await patch(mel, p.id, seen.rowVersion, { currency });
      expect(res.statusCode, `${currency}: ${res.body}`).toBe(409);
      expect(res.json().code).toBe('module_off');
    }
    const same = await patch(mel, p.id, seen.rowVersion, { currency: 'EGP' });
    expect(same.statusCode, same.body).toBe(200);
    const edited = await patch(mel, p.id, (same.json() as Purchase).rowVersion, {
      notes: 'Garden',
      lines: [{ id: seen.lines[0]?.id, description: 'Garden rake' }],
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const [line] = await own<{ unit_price: string; description: string }>(
      'SELECT unit_price::text AS unit_price, description FROM public.purchase_lines WHERE purchase_id = $1',
      [p.id],
    );
    expect(line).toEqual({ unit_price: '300.0000', description: 'Garden rake' });
  });
});

describe('PATCH /api/v1/purchases/:id', () => {
  // catalogue: PATCH /api/v1/purchases/:id
  it('changes the purchase and its lines under If-Match, audited per row', async () => {
    const lamp = await thing(home, 'Lamp');
    const p = await create(mel, {
      locationId: home,
      purchasedOn: today(),
      currency: 'EGP',
      total: '300',
      lines: [
        { description: 'Lamp', quantity: 1, unitPrice: '200' },
        { description: 'Bulbs', quantity: 4, unitPrice: '25' },
      ],
    });
    const [lampLine, bulbs] = p.lines as [Line, Line];

    expect((await patch(mel, p.id, null, { notes: 'x' })).statusCode).toBe(428);

    const res = await patch(mel, p.id, p.rowVersion, {
      total: '٣٥٠',
      vendorId: vendor,
      lines: [
        { id: lampLine.id, unitPrice: '250', thingId: lamp },
        { description: 'Shade', quantity: 1, unitPrice: '100' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = res.json() as Purchase;
    expect(after.total).toBe('350');
    expect(after.vendor?.id).toBe(vendor);
    expect(after.rowVersion).toBeGreaterThan(p.rowVersion);
    expect(after.lines.map((l) => [l.description, l.unitPrice, l.thing?.id ?? null])).toEqual([
      ['Lamp', '250', lamp],
      ['Shade', '100', null],
    ]);
    expect(after.flagged).toBe(false);
    expect(await lineOf(lamp)).toBe(lampLine.id);

    const update = (await auditOf(p.id)).find((e) => e.action === 'purchase.update');
    expect(update?.diff.total).toEqual({ before: '300', after: '350', class: 'money' });
    expect(update?.diff.vendor_id).toMatchObject({ before: null, after: vendor, class: 'plain' });
    const lineEvents = await auditOf(lampLine.id);
    expect(lineEvents.map((e) => e.action)).toEqual([
      'purchase_line.create',
      'purchase_line.update',
    ]);
    expect(lineEvents[1]?.diff.unit_price).toEqual({ before: '200', after: '250', class: 'money' });
    const removed = await auditOf(bulbs.id);
    expect(removed.map((e) => e.action)).toEqual(['purchase_line.create', 'purchase_line.delete']);
    expect(removed[1]?.diff.unit_price).toEqual({ before: '25', after: null, class: 'money' });
    expect((await auditOf(lamp)).map((e) => e.action)).toEqual(['thing.purchase_link']);

    // A stale version is 412, saying who changed it.
    const stale = await patch(adam, p.id, p.rowVersion, { notes: 'late' });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({
      code: 'precondition_failed',
      conflicts: ['notes'],
      row_version: after.rowVersion,
      changedBy: { displayName: expect.any(String) },
    });
  });

  it('keeps amounts tied to a currency and refuses viewers and outsiders', async () => {
    const p = await create(mel, {
      locationId: home,
      purchasedOn: today(),
      currency: 'EGP',
      total: '10',
    });
    const res = await patch(mel, p.id, p.rowVersion, { currency: null });
    expect(res.statusCode).toBe(400);
    expect((await patch(mel, p.id, p.rowVersion, { currency: '$' })).statusCode).toBe(400);
    expect((await patch(vic, p.id, p.rowVersion, { notes: 'x' })).statusCode).toBe(403);
    expect((await patch(ann, p.id, p.rowVersion, { notes: 'x' })).statusCode).toBe(404);
    const cleared = await patch(mel, p.id, p.rowVersion, { currency: null, total: null });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json()).toMatchObject({ currency: null });
    expect(cleared.json()).not.toHaveProperty('total');
  });
});

describe('DELETE /api/v1/purchases/:id', () => {
  // catalogue: DELETE /api/v1/purchases/:id
  it('removes the purchase and its lines, and unlinks its things, each audited', async () => {
    const mug = await thing(home, 'Mug');
    const p = await create(mel, {
      locationId: home,
      purchasedOn: today(),
      currency: 'EGP',
      total: '40',
      lines: [{ description: 'Mug', quantity: 1, unitPrice: '40', thingId: mug }],
    });
    expect(
      (await call(t, `/api/v1/purchases/${p.id}`, { as: vic, method: 'DELETE' })).statusCode,
    ).toBe(403);
    const res = await call(t, `/api/v1/purchases/${p.id}`, { as: mel, method: 'DELETE' });
    expect(res.statusCode, res.body).toBe(204);
    expect(await lineOf(mug)).toBeNull();
    expect(await own('SELECT 1 FROM public.purchase_lines WHERE purchase_id = $1', [p.id])).toEqual(
      [],
    );
    expect((await call(t, `/api/v1/purchases/${p.id}`, { as: mel })).statusCode).toBe(404);
    const events = await auditOf(p.id);
    expect(events.map((e) => e.action)).toEqual(['purchase.create', 'purchase.delete']);
    expect(events[1]?.diff.total).toEqual({ before: '40', after: null, class: 'money' });
    expect((await auditOf(mug)).map((e) => e.action)).toEqual([
      'thing.purchase_link',
      'thing.purchase_unlink',
    ]);
    expect((await auditOf(p.lines[0]?.id as string)).map((e) => e.action)).toEqual([
      'purchase_line.create',
      'purchase_line.delete',
    ]);
  });

  it('leaves someone else’s receipt to an admin', async () => {
    const p = await create(adam, { locationId: home, purchasedOn: today() });
    await own(
      `INSERT INTO public.attachments (location_id, url, purchase_id, role, created_by)
       VALUES ($1, 'https://example.com/r.pdf', $2, 'receipt', $3)`,
      [home, p.id, adam.userId],
    );
    const member = await call(t, `/api/v1/purchases/${p.id}`, { as: mel, method: 'DELETE' });
    expect(member.statusCode).toBe(403);
    const admin = await call(t, `/api/v1/purchases/${p.id}`, { as: adam, method: 'DELETE' });
    expect(admin.statusCode, admin.body).toBe(204);
    const attached = await own<{ action: string }>(
      `SELECT action FROM public.audit_events
        WHERE entity_type = 'attachment' AND diff->'purchase_id'->>'before' = $1`,
      [p.id],
    );
    expect(attached.map((e) => e.action)).toEqual(['attachment.delete']);
  });
});

describe('a thing moved to another location keeps its line (D115)', () => {
  let p: Purchase;
  let sofa: string;

  beforeAll(async () => {
    sofa = await thing(home, 'Sofa');
    p = await create(bob, {
      locationId: home,
      purchasedOn: today(),
      currency: 'EGP',
      total: '5000',
      tax: '700',
      lines: [
        { description: 'Sofa', quantity: 1, unitPrice: '4300', thingId: sofa },
        { description: 'Delivery', quantity: 1, unitPrice: '0' },
      ],
    });
    // Moved within the account (the move definer's result, done as kept_owner).
    await own(
      `UPDATE public.things SET location_id = $2,
              place_id = (SELECT id FROM public.places WHERE location_id = $2 AND is_unplaced)
        WHERE id = $1`,
      [sofa, cabin],
    );
  });

  it('shows the line, not the whole purchase, to someone who sees only the new location', async () => {
    expect((await call(t, `/api/v1/purchases/${p.id}`, { as: cal })).statusCode).toBe(404);
    const rows = await withScope(
      db.pools.app,
      { userId: cal.userId, mfa: false },
      async (_tx, c) =>
        (
          await c.query(
            `SELECT purchase_id, total::text, tax::text, unit_price::text, visible_purchase,
                  vendor_id FROM kept.thing_purchase($1)`,
            [sofa],
          )
        ).rows,
    );
    expect(rows).toEqual([
      {
        purchase_id: p.id,
        total: null,
        tax: null,
        unit_price: '4300.0000',
        visible_purchase: false,
        vendor_id: null,
      },
    ]);
    const bobs = await withScope(
      db.pools.app,
      { userId: bob.userId, mfa: false },
      async (_tx, c) =>
        (await c.query('SELECT total::text, visible_purchase FROM kept.thing_purchase($1)', [sofa]))
          .rows,
    );
    expect(bobs).toEqual([{ total: '5000.0000', visible_purchase: true }]);
  });

  it('refuses to delete the purchase, or the line, while the thing elsewhere comes from it', async () => {
    const del = await call(t, `/api/v1/purchases/${p.id}`, { as: adam, method: 'DELETE' });
    expect(del.statusCode).toBe(409);
    expect(del.json().code).toBe('in_use');
    const current = await get(adam, p.id);
    // The line isn't shown with its thing here (Adam can't see the cabin), but it is still used.
    expect(current.lines[0]?.thing).toBeNull();
    const drop = await patch(adam, p.id, current.rowVersion, {
      lines: [{ id: current.lines[1]?.id }],
    });
    expect(drop.statusCode).toBe(409);
    expect(await lineOf(sofa)).toBe(p.lines[0]?.id);
    // Dropping the unused line is fine.
    const keep = await patch(adam, p.id, current.rowVersion, {
      lines: [{ id: current.lines[0]?.id }],
    });
    expect(keep.statusCode, keep.body).toBe(200);
    expect((keep.json() as Purchase).lines).toHaveLength(1);
  });

  it('refuses to link a thing of another location to the line', async () => {
    const res = await call(t, `/api/v1/purchase-lines/${p.lines[0]?.id}/link`, {
      as: bob,
      body: { thingId: await thing(cabin, 'Cushion') },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('/api/v1/purchase-lines/:id/link', () => {
  let p: Purchase;
  let chair: string;
  let stool: string;

  beforeAll(async () => {
    chair = await thing(home, 'Chair');
    stool = await thing(home, 'Stool');
    p = await create(mel, {
      locationId: home,
      purchasedOn: today(),
      lines: [{ description: 'Seats', quantity: 2 }],
    });
  });

  // catalogue: POST /api/v1/purchase-lines/:id/link
  it('links a thing of the location to a line, audited on the thing', async () => {
    const lineId = p.lines[0]?.id as string;
    const res = await call(t, `/api/v1/purchase-lines/${lineId}/link`, {
      as: mel,
      body: { thingId: chair },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as Purchase).lines[0]?.thing).toEqual({ id: chair, name: 'Chair' });
    expect(await lineOf(chair)).toBe(lineId);
    const events = await auditOf(chair);
    expect(events.map((e) => [e.action, e.location_id, e.actor_id])).toEqual([
      ['thing.purchase_link', home, mel.userId],
    ]);
    expect(events[0]?.diff.purchase_line_id).toEqual({
      before: null,
      after: lineId,
      class: 'plain',
    });

    // With the thing's If-Match: a stale one is 412.
    const [row] = await own<{ row_version: number }>(
      'SELECT row_version FROM public.things WHERE id = $1',
      [stool],
    );
    const stale = await call(t, `/api/v1/purchase-lines/${lineId}/link`, {
      as: mel,
      body: { thingId: stool },
      headers: { 'if-match': String((row?.row_version ?? 0) + 5) },
    });
    expect(stale.statusCode).toBe(412);
    const fresh = await call(t, `/api/v1/purchase-lines/${lineId}/link`, {
      as: mel,
      body: { thingId: stool },
      headers: { 'if-match': String(row?.row_version) },
    });
    expect(fresh.statusCode, fresh.body).toBe(200);
    expect(await lineOf(stool)).toBe(lineId);

    expect(
      (
        await call(t, `/api/v1/purchase-lines/${lineId}/link`, {
          as: vic,
          body: { thingId: chair },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await call(t, `/api/v1/purchase-lines/${lineId}/link`, {
          as: ann,
          body: { thingId: chair },
        })
      ).statusCode,
    ).toBe(404);
  });

  // catalogue: DELETE /api/v1/purchase-lines/:id/link
  it('unlinks one thing, or every thing of the line, audited on each', async () => {
    const lineId = p.lines[0]?.id as string;
    const one = await call(t, `/api/v1/purchase-lines/${lineId}/link?thingId=${chair}`, {
      as: mel,
      method: 'DELETE',
    });
    expect(one.statusCode, one.body).toBe(204);
    expect(await lineOf(chair)).toBeNull();
    expect(await lineOf(stool)).toBe(lineId);
    const all = await call(t, `/api/v1/purchase-lines/${lineId}/link`, {
      as: mel,
      method: 'DELETE',
    });
    expect(all.statusCode).toBe(204);
    expect(await lineOf(stool)).toBeNull();
    expect((await auditOf(chair)).map((e) => e.action)).toEqual([
      'thing.purchase_link',
      'thing.purchase_unlink',
    ]);
    expect((await auditOf(stool)).at(-1)?.action).toBe('thing.purchase_unlink');
    expect(
      (await call(t, `/api/v1/purchase-lines/${lineId}/link`, { as: vic, method: 'DELETE' }))
        .statusCode,
    ).toBe(403);
  });
});
