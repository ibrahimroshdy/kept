import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  createLocation,
  createThing,
  type Loc,
  own as ownOf,
  setDisplayName,
} from '../../test/things.js';

// Step-4 T9 through the front door: warranties with defaults and coverage, claims and repairs,
// and the derived state "in repair" (D53–D55, D158, D195; plan Q18, Q25–Q27), in the web
// contract's shapes (apps/web/src/api/household/types.ts, "warranties and claims").
//
// Ibrahim owns Home (household: warranties and money on) and Garage (essentials: both off). In
// Home, Bruce is an admin, Louis a member and Talia a viewer (Home hides money from viewers).
// Alfred has his own account.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let talia: Person;
let alfred: Person;
let home: Loc;
let garage: Loc;

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownOf<T>(db, text, values);

const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
  expect(res.statusCode, res.body).toBe(status);
  return (status === 204 ? undefined : res.json()) as T;
};

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
const shift = (iso: string, days: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

type Warranty = {
  id: string;
  thingId: string;
  kind: string;
  provider: string | null;
  startsOn: string;
  endsOn: string | null;
  termMonths: number | null;
  lifetime: boolean;
  effectiveEndsOn: string | null;
  leadDays: number;
  state: 'active' | 'expiring' | 'ended';
  documents: { id: string; url: string | null }[];
  rowVersion: number;
  createdBy: { displayName: string };
};
type Coverage = { longestId: string | null; boughtOn: string | null; coveredUntil: string | null };
type Money = { amount: string; currency: string } | { moneyHidden: true };
type Claim = {
  id: string;
  thingId: string;
  warranty: { id: string; kind: string; provider: string | null } | null;
  openedOn: string;
  reference: string | null;
  vendor: { id: string; name: string; kind: string } | null;
  status: string;
  cost: Money | null;
  coveredAmount: Money | null;
  closedOn: string | null;
  savedYou: Money | null;
  documents: { id: string; url: string | null; role: string }[];
  rowVersion: number;
};

const eventsOf = (entityId: string) =>
  own<{ id: string; action: string; root_thing_id: string | null; diff: Record<string, never> }>(
    `SELECT id, action, root_thing_id, diff FROM public.audit_events
      WHERE entity_id = $1 ORDER BY at, id`,
    [entityId],
  );

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, method: 'POST', body: {} });

const warranties = (as: Person, thingId: string) =>
  call(t, `/api/v1/things/${thingId}/warranties`, { as });
const addWarranty = (as: Person, thingId: string, body: object) =>
  call(t, `/api/v1/things/${thingId}/warranties`, { as, body });
const patchWarranty = (as: Person, id: string, version: number, body: object) =>
  call(t, `/api/v1/warranties/${id}`, {
    as,
    method: 'PATCH',
    body,
    headers: { 'if-match': String(version) },
  });
const delWarranty = (as: Person, id: string, version: number) =>
  call(t, `/api/v1/warranties/${id}`, {
    as,
    method: 'DELETE',
    headers: { 'if-match': String(version) },
  });

const claims = (as: Person, thingId: string) => call(t, `/api/v1/things/${thingId}/claims`, { as });
const openClaim = (as: Person, thingId: string, body: object) =>
  call(t, `/api/v1/things/${thingId}/claims`, { as, body });
const patchClaim = (as: Person, id: string, version: number, body: object) =>
  call(t, `/api/v1/claims/${id}`, {
    as,
    method: 'PATCH',
    body,
    headers: { 'if-match': String(version) },
  });
const delClaim = (as: Person, id: string, version: number) =>
  call(t, `/api/v1/claims/${id}`, {
    as,
    method: 'DELETE',
    headers: { 'if-match': String(version) },
  });

const thingView = async (as: Person, id: string) =>
  ok<{
    derivedState: string[];
    repairAt: { vendorName: string | null } | null;
    rowVersion: number;
  }>(await call(t, `/api/v1/things/${id}`, { as }));

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  for (const [p, name] of [
    [ibrahim, 'Ibrahim'],
    [bruce, 'Bruce'],
    [louis, 'Louis'],
    [talia, 'Talia'],
    [alfred, 'Alfred'],
  ] as const) {
    await setDisplayName(db, p, name);
  }
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await join(db, garage.id, louis.userId, 'member');
});

// ---------------------------------------------------------------------------------------------
// Warranties
// ---------------------------------------------------------------------------------------------

describe('warranties, their defaults and the coverage bar (D53–D55, D195)', () => {
  it('defaults the term from the brand, else the nearest type up the chain, and the start from the purchase', async () => {
    const [brand] = await own<{ id: string }>(
      `INSERT INTO public.brands (owner_account_id, name, default_warranty_months)
       VALUES ($1, 'Toshiba', 24) RETURNING id`,
      [home.accountId],
    );
    const parent = newId();
    const child = newId();
    await own(
      `INSERT INTO public.types (id, owner_account_id, name, icon, default_warranty_months)
       VALUES ($1, $3, 'Appliance', 'lucide:plug', 36),
              ($2, $3, 'Blender', 'lucide:plug', NULL)`,
      [parent, child, home.accountId],
    );
    await own('UPDATE public.types SET parent_id = $1 WHERE id = $2', [parent, child]);

    const branded = await createThing(t, louis, home, {
      name: 'Television',
      brandId: brand?.id,
      typeId: child,
      purchase: { purchasedOn: '2026-03-15', currency: 'EGP', price: '30000' },
    });
    const byBrand = ok(
      await call(t, `/api/v1/things/${branded.id}/warranty-defaults`, { as: louis }),
    );
    expect(byBrand).toEqual({
      termMonths: 24,
      from: { kind: 'brand', id: brand?.id, name: 'Toshiba' },
      startsOn: '2026-03-15',
    });
    const typed = await createThing(t, louis, home, { name: 'Blender', typeId: child });
    const byType = ok(await call(t, `/api/v1/things/${typed.id}/warranty-defaults`, { as: louis }));
    expect(byType).toEqual({
      termMonths: 36,
      from: { kind: 'type', id: parent, name: 'Appliance' },
      startsOn: null,
    });
    const plain = await createThing(t, louis, home, { name: 'Rug' });
    expect(
      ok(await call(t, `/api/v1/things/${plain.id}/warranty-defaults`, { as: louis })),
    ).toEqual({ termMonths: null, from: null, startsOn: null });
  });

  // catalogue: POST /api/v1/things/:id/warranties
  it('adds warranties, the longest cover first, lifetime above all; the bar spans bought → covered until', async () => {
    const tv = await createThing(t, louis, home, {
      name: 'Fridge',
      purchase: { purchasedOn: '2025-10-01', currency: 'EGP', price: '40000' },
    });
    const makers = ok<Warranty>(
      await addWarranty(louis, tv.id, {
        kind: 'manufacturer',
        provider: 'Sharp',
        startsOn: '2025-10-01',
        termMonths: 24,
      }),
      201,
    );
    expect(makers).toMatchObject({
      thingId: tv.id,
      kind: 'manufacturer',
      termMonths: 24,
      endsOn: null,
      lifetime: false,
      effectiveEndsOn: '2027-09-30',
      leadDays: 30,
      state: 'active',
      documents: [],
      rowVersion: 1,
      createdBy: { displayName: 'Louis' },
    });
    const extended = ok<Warranty>(
      await addWarranty(louis, tv.id, {
        kind: 'extended',
        startsOn: '2027-10-01',
        endsOn: '2029-09-30',
      }),
      201,
    );
    const ended = ok<Warranty>(
      await addWarranty(louis, tv.id, {
        kind: 'store',
        startsOn: '2025-10-01',
        termMonths: 1,
      }),
      201,
    );
    expect(ended.state).toBe('ended');
    const list = ok<{ items: Warranty[]; coverage: Coverage }>(await warranties(talia, tv.id));
    expect(list.items.map((w) => w.id)).toEqual([extended.id, makers.id, ended.id]);
    expect(list.coverage).toEqual({
      longestId: extended.id,
      boughtOn: '2025-10-01',
      coveredUntil: '2029-09-30',
    });
    const forever = ok<Warranty>(
      await addWarranty(louis, tv.id, {
        kind: 'insurance',
        startsOn: '2026-01-01',
        lifetime: true,
      }),
      201,
    );
    expect(forever).toMatchObject({ lifetime: true, effectiveEndsOn: null, state: 'active' });
    const again = ok<{ items: Warranty[]; coverage: Coverage }>(await warranties(louis, tv.id));
    expect(again.items[0]?.id).toBe(forever.id);
    expect(again.coverage).toMatchObject({ longestId: forever.id, coveredUntil: 'lifetime' });

    const events = await eventsOf(makers.id);
    expect(events).toMatchObject([{ action: 'warranty.create', root_thing_id: tv.id }]);
  });

  it('reads a warranty as expiring from its lead days before the last day', async () => {
    const kettle = await createThing(t, louis, home, { name: 'Kettle' });
    const soon = ok<Warranty>(
      await addWarranty(louis, kettle.id, {
        kind: 'manufacturer',
        startsOn: shift(today(), -300),
        endsOn: shift(today(), 10),
        leadDays: 14,
      }),
      201,
    );
    expect(soon.state).toBe('expiring');
    const later = ok<Warranty>(
      await addWarranty(louis, kettle.id, {
        kind: 'store',
        startsOn: shift(today(), -300),
        endsOn: shift(today(), 10),
        leadDays: 5,
      }),
      201,
    );
    expect(later.state).toBe('active');
    // Its last day is covered (L2: inclusive).
    const last = ok<Warranty>(
      await addWarranty(louis, kettle.id, {
        kind: 'credit_card',
        startsOn: shift(today(), -30),
        endsOn: today(),
        leadDays: 0,
      }),
      201,
    );
    expect(last.state).toBe('expiring');
  });

  it('refuses a warranty on several things (Split it first), a thing that then grows, and bad terms', async () => {
    const cups = await createThing(t, louis, home, { name: 'Cups', quantity: 3 });
    const res = await addWarranty(louis, cups.id, {
      kind: 'store',
      startsOn: '2026-01-01',
      termMonths: 12,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'quantity_not_one',
      hint: expect.stringMatching(/Split/),
    });

    const mixer = await createThing(t, louis, home, { name: 'Mixer' });
    ok(
      await addWarranty(louis, mixer.id, { kind: 'store', startsOn: '2026-01-01', termMonths: 12 }),
      201,
    );
    const grow = await call(t, `/api/v1/things/${mixer.id}`, {
      as: louis,
      method: 'PATCH',
      body: { quantity: 2 },
      headers: { 'if-match': String((await thingView(louis, mixer.id)).rowVersion) },
    });
    expect(grow.statusCode).toBe(409);

    const bad = [
      { kind: 'store', startsOn: '2026-01-01' },
      { kind: 'store', startsOn: '2026-01-01', termMonths: 12, lifetime: true },
      { kind: 'store', startsOn: '2026-05-01', endsOn: '2026-04-01' },
      { kind: 'store', startsOn: '2026-01-01', termMonths: 0 },
      { kind: 'nope', startsOn: '2026-01-01', termMonths: 12 },
    ];
    for (const body of bad) expect((await addWarranty(louis, mixer.id, body)).statusCode).toBe(400);
    expect(
      (await addWarranty(talia, mixer.id, { kind: 'store', startsOn: '2026-01-01', termMonths: 1 }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await addWarranty(alfred, mixer.id, {
          kind: 'store',
          startsOn: '2026-01-01',
          termMonths: 1,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('is off with Warranties off: 404 to read, 409 to write', async () => {
    const drill = await createThing(t, louis, garage, { name: 'Drill' });
    const read = await warranties(louis, drill.id);
    expect(read.statusCode).toBe(404);
    expect(read.json()).toMatchObject({ code: 'module_off' });
    const write = await addWarranty(louis, drill.id, {
      kind: 'store',
      startsOn: '2026-01-01',
      termMonths: 12,
    });
    expect(write.statusCode).toBe(409);
    expect(write.json()).toMatchObject({ code: 'module_off' });
    expect((await claims(louis, drill.id)).statusCode).toBe(404);
    expect((await openClaim(louis, drill.id, { openedOn: '2026-01-01' })).json()).toMatchObject({
      code: 'module_off',
    });
  });

  // catalogue: PATCH /api/v1/warranties/:id
  it('edits with If-Match, switching the end from a term to a date; undo puts the term back', async () => {
    const hob = await createThing(t, louis, home, { name: 'Hob' });
    const w = ok<Warranty>(
      await addWarranty(louis, hob.id, {
        kind: 'manufacturer',
        startsOn: '2026-01-01',
        termMonths: 12,
      }),
      201,
    );
    expect((await patchWarranty(louis, w.id, 9, { provider: 'X' })).statusCode).toBe(412);
    const res = await patchWarranty(louis, w.id, 1, { endsOn: '2027-06-30', provider: 'Bosch' });
    const edited = ok<Warranty>(res);
    expect(edited).toMatchObject({
      endsOn: '2027-06-30',
      termMonths: null,
      effectiveEndsOn: '2027-06-30',
      provider: 'Bosch',
      rowVersion: 2,
    });
    const event = (await eventsOf(w.id)).find((e) => e.action === 'warranty.update');
    expect(event?.diff).toMatchObject({
      term_months: { before: 12, after: null },
      ends_on: { before: null, after: '2027-06-30' },
    });
    expect(res.headers['x-kept-audit-event']).toBe(event?.id);
    ok(await undo(louis, event?.id as string));
    const back = ok<{ items: Warranty[] }>(await warranties(louis, hob.id)).items[0];
    expect(back).toMatchObject({ termMonths: 12, endsOn: null, provider: null });
    expect((await patchWarranty(louis, w.id, 3, { termMonths: null })).statusCode).toBe(400);
  });

  // catalogue: DELETE /api/v1/warranties/:id
  it('deletes with If-Match; undo brings it back with its documents and its claims', async () => {
    const oven = await createThing(t, louis, home, { name: 'Oven' });
    const w = ok<Warranty>(
      await addWarranty(louis, oven.id, {
        kind: 'manufacturer',
        startsOn: '2026-01-01',
        termMonths: 24,
      }),
      201,
    );
    ok(
      await call(t, '/api/v1/attachments', {
        as: louis,
        body: {
          locationId: home.id,
          url: 'https://maker.example/warranty/oven',
          subject: { warrantyId: w.id },
          role: 'warranty_doc',
        },
      }),
      201,
    );
    const c = ok<Claim>(
      await openClaim(louis, oven.id, { openedOn: '2026-05-01', warrantyId: w.id }),
      201,
    );
    expect(c.warranty).toEqual({ id: w.id, kind: 'manufacturer', provider: null });
    expect(
      ok<{ items: Warranty[] }>(await warranties(louis, oven.id)).items[0]?.documents,
    ).toHaveLength(1);

    const res = await delWarranty(louis, w.id, 1);
    ok(res, 204);
    expect(ok<{ items: Claim[] }>(await claims(louis, oven.id)).items[0]?.warranty).toBeNull();
    const deleted = (await eventsOf(w.id)).find((e) => e.action === 'warranty.delete');
    expect(deleted?.diff).toMatchObject({
      term_months: { before: 24, after: null },
      claim_ids: { before: [c.id] },
      documents: { before: [{ role: 'warranty_doc', url: 'https://maker.example/warranty/oven' }] },
    });
    ok(await undo(louis, res.headers['x-kept-audit-event'] as string));
    const back = ok<{ items: Warranty[] }>(await warranties(louis, oven.id)).items;
    expect(back).toMatchObject([
      { id: w.id, termMonths: 24, documents: [{ url: 'https://maker.example/warranty/oven' }] },
    ]);
    expect(ok<{ items: Claim[] }>(await claims(louis, oven.id)).items[0]?.warranty?.id).toBe(w.id);
  });

  it('undo puts back a document whose file only its uploader could see (the event holds it)', async () => {
    const fridge = await createThing(t, louis, home, { name: 'Fridge' });
    const w = ok<Warranty>(
      await addWarranty(louis, fridge.id, {
        kind: 'manufacturer',
        startsOn: '2026-01-01',
        termMonths: 24,
      }),
      201,
    );
    const fileId = newId();
    await own(
      `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                                 derivative_state, created_by)
       VALUES ($1, $2, $3, $4, 100, 'application/pdf', 'document', 'not_applicable', $5)`,
      [
        fileId,
        home.id,
        `f/${home.id}/${fileId}`,
        fileId.replaceAll('-', '').padEnd(64, '0'),
        louis.userId,
      ],
    );
    const doc = ok<{ id: string }>(
      await call(t, '/api/v1/attachments', {
        as: louis,
        body: { locationId: home.id, fileId, subject: { warrantyId: w.id }, role: 'warranty_doc' },
      }),
      201,
    );
    // Bruce deletes it: the file is no longer attached, and only Louis uploaded it.
    const res = await delWarranty(bruce, w.id, 1);
    ok(res, 204);
    ok(await undo(bruce, res.headers['x-kept-audit-event'] as string));
    const back = ok<{ items: Warranty[] }>(await warranties(louis, fridge.id)).items;
    expect(back[0]?.documents.map((d) => d.id)).toEqual([doc.id]);
  });
});

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

describe('claims and repairs (D54, D158, D195, Q18)', () => {
  it('prefills a claim from the longest active warranty and the brand’s contacts', async () => {
    const [brand] = await own<{ id: string }>(
      `INSERT INTO public.brands (owner_account_id, name, claim_url, support_phone)
       VALUES ($1, 'Samsung', 'https://samsung.example/claim', '+20 2 1234 5678') RETURNING id`,
      [home.accountId],
    );
    const phone = await createThing(t, louis, home, { name: 'Phone', brandId: brand?.id });
    const empty = ok(await call(t, `/api/v1/things/${phone.id}/claim-prefill`, { as: louis }));
    expect(empty).toEqual({
      warrantyId: null,
      claimUrl: 'https://samsung.example/claim',
      supportPhone: '+20 2 1234 5678',
      claimContact: null,
    });
    ok(
      await addWarranty(louis, phone.id, { kind: 'store', startsOn: '2024-01-01', termMonths: 6 }),
      201,
    );
    const w = ok<Warranty>(
      await addWarranty(louis, phone.id, {
        kind: 'manufacturer',
        startsOn: shift(today(), -30),
        termMonths: 12,
        claimContact: 'Call the service line',
      }),
      201,
    );
    const pre = ok(await call(t, `/api/v1/things/${phone.id}/claim-prefill`, { as: talia }));
    expect(pre).toMatchObject({ warrantyId: w.id, claimContact: 'Call the service line' });
  });

  // catalogue: POST /api/v1/things/:id/claims
  it('opens a claim in repair with a service centre made inline: the thing reads "at" it, in its view, search and lists', async () => {
    const laptop = await createThing(t, louis, home, { name: 'Laptop' });
    const c = ok<Claim>(
      await openClaim(louis, laptop.id, {
        openedOn: shift(today(), -2),
        reference: 'RMA-4411',
        vendor: { name: 'B.Tech Service' },
        status: 'in_repair',
      }),
      201,
    );
    expect(c).toMatchObject({
      status: 'in_repair',
      reference: 'RMA-4411',
      vendor: { name: 'B.Tech Service', kind: 'service_centre' },
      cost: null,
      coveredAmount: null,
      savedYou: null,
      closedOn: null,
      documents: [],
      rowVersion: 1,
    });
    expect(await eventsOf(c.id)).toMatchObject([
      { action: 'claim.create', root_thing_id: laptop.id },
    ]);
    const vendorEvents = await own<{ action: string }>(
      `SELECT action FROM public.audit_events WHERE entity_id = $1`,
      [c.vendor?.id],
    );
    expect(vendorEvents).toEqual([{ action: 'vendor.create' }]);
    // The same name again is the same vendor.
    const other = await createThing(t, louis, home, { name: 'Tablet' });
    const c2 = ok<Claim>(
      await openClaim(louis, other.id, { openedOn: today(), vendor: { name: 'b.tech service' } }),
      201,
    );
    expect(c2.vendor?.id).toBe(c.vendor?.id);

    const view = await thingView(talia, laptop.id);
    expect(view.derivedState).toContain('in_repair');
    expect(view.repairAt).toEqual({ vendorName: 'B.Tech Service' });
    expect((await thingView(talia, other.id)).repairAt).toBeNull();
    const found = ok<{ things: { items: { id: string; derivedState: string[] }[] } }>(
      await call(t, `/api/v1/search?state=in_repair&locationId=${home.id}`, { as: louis }),
    );
    expect(found.things.items.map((x) => x.id)).toEqual([laptop.id]);
    expect(found.things.items[0]?.derivedState).toContain('in_repair');
    const listed = ok<{ things: { items: { id: string; derivedState: string[] }[] } }>(
      await call(t, `/api/v1/places/${home.unplacedId}/contents?limit=200`, { as: louis }),
    );
    expect(listed.things.items.find((x) => x.id === laptop.id)?.derivedState).toContain(
      'in_repair',
    );

    // A second repair of the same thing: 409.
    const twice = await openClaim(louis, laptop.id, { openedOn: today(), status: 'in_repair' });
    expect(twice.statusCode).toBe(409);
    expect(twice.json()).toMatchObject({ code: 'thing_in_repair' });
    expect((await openClaim(talia, laptop.id, { openedOn: today() })).statusCode).toBe(403);
    expect((await openClaim(louis, laptop.id, { openedOn: '2999-01-01' })).statusCode).toBe(400);
    expect(
      (await openClaim(louis, laptop.id, { openedOn: today(), warrantyId: newId() })).statusCode,
    ).toBe(400);
  });

  // catalogue: PATCH /api/v1/claims/:id
  it('resolves a repair at no cost: closed today, "saved you" the covered amount; a closed claim won’t reopen', async () => {
    const washer = await createThing(t, louis, home, { name: 'Washer' });
    const c = ok<Claim>(
      await openClaim(louis, washer.id, {
        openedOn: shift(today(), -10),
        vendor: { name: 'Zanussi Centre' },
        status: 'in_repair',
      }),
      201,
    );
    const res = await patchClaim(louis, c.id, 1, {
      status: 'resolved',
      cost: '0',
      coveredAmount: '3500',
      currency: 'egp',
    });
    const done = ok<Claim>(res);
    expect(done).toMatchObject({
      status: 'resolved',
      closedOn: today(),
      cost: { amount: '0', currency: 'EGP' },
      coveredAmount: { amount: '3500', currency: 'EGP' },
      savedYou: { amount: '3500', currency: 'EGP' },
    });
    const event = (await eventsOf(c.id)).find((e) => e.action === 'claim.status');
    expect(event?.diff).toMatchObject({
      status: { before: 'in_repair', after: 'resolved' },
      covered_amount: { after: '3500', class: 'money' },
    });
    expect(res.headers['x-kept-audit-event']).toBe(event?.id);
    expect((await thingView(louis, washer.id)).derivedState).not.toContain('in_repair');

    const reopen = await patchClaim(louis, c.id, 2, { status: 'open' });
    expect(reopen.statusCode).toBe(409);
    expect(reopen.json()).toMatchObject({ code: 'invalid_transition' });

    // A viewer sees the claim, not its money.
    const seen = ok<{ items: Claim[] }>(await claims(talia, washer.id)).items[0];
    expect(seen).toMatchObject({
      status: 'resolved',
      cost: { moneyHidden: true },
      coveredAmount: { moneyHidden: true },
      savedYou: null,
    });
    expect(JSON.stringify(seen)).not.toContain('3500');
  });

  it('undo of the resolve puts the thing back in repair, while nothing changed since', async () => {
    const dryer = await createThing(t, louis, home, { name: 'Dryer' });
    const c = ok<Claim>(
      await openClaim(louis, dryer.id, { openedOn: today(), status: 'in_repair' }),
      201,
    );
    const res = await patchClaim(louis, c.id, 1, { status: 'rejected', reference: 'Denied' });
    ok(res);
    expect((await thingView(louis, dryer.id)).derivedState).not.toContain('in_repair');
    ok(await undo(louis, res.headers['x-kept-audit-event'] as string));
    const back = ok<{ items: Claim[] }>(await claims(louis, dryer.id)).items[0];
    expect(back).toMatchObject({ status: 'in_repair', closedOn: null, reference: null });
    expect((await thingView(louis, dryer.id)).derivedState).toContain('in_repair');
    // The transition guard still holds after the undo's own way past it.
    const closed = ok<Claim>(
      await patchClaim(louis, c.id, (back as Claim).rowVersion, { status: 'resolved' }),
    );
    expect(
      (await patchClaim(louis, c.id, closed.rowVersion, { status: 'in_repair' })).statusCode,
    ).toBe(409);
  });

  it('refuses amounts without a currency, money where it is hidden, and a close date before the opening', async () => {
    const lamp = await createThing(t, louis, home, { name: 'Lamp' });
    const c = ok<Claim>(await openClaim(louis, lamp.id, { openedOn: '2026-05-01' }), 201);
    expect((await patchClaim(louis, c.id, 1, { cost: '100' })).statusCode).toBe(400);
    expect(
      (await patchClaim(louis, c.id, 1, { status: 'rejected', closedOn: '2026-04-01' })).statusCode,
    ).toBe(400);
    expect((await patchClaim(louis, c.id, 1, { closedOn: '2026-06-01' })).statusCode).toBe(400);
    expect((await patchClaim(talia, c.id, 1, { reference: 'x' })).statusCode).toBe(403);
    // Money hidden from members once the location turns Money off.
    const setMoney = (on: boolean) =>
      own(
        `INSERT INTO public.location_modules (location_id, module, enabled)
         VALUES ($1, 'money', $2)
         ON CONFLICT (location_id, module) DO UPDATE SET enabled = excluded.enabled`,
        [home.id, on],
      );
    await setMoney(false);
    try {
      const hidden = await patchClaim(louis, c.id, 1, { cost: '100', currency: 'EGP' });
      expect(hidden.statusCode).toBe(409);
      expect(hidden.json()).toMatchObject({ code: 'module_off' });
      const plain = ok<Claim>(await patchClaim(louis, c.id, 1, { reference: 'CASE-9' }));
      expect(plain).toMatchObject({ reference: 'CASE-9', cost: { moneyHidden: true } });
    } finally {
      await setMoney(true);
    }
  });

  // catalogue: DELETE /api/v1/claims/:id
  it('deletes a claim with If-Match; undo restores it with its documents', async () => {
    const vacuum = await createThing(t, louis, home, { name: 'Vacuum' });
    const c = ok<Claim>(await openClaim(louis, vacuum.id, { openedOn: '2026-06-01' }), 201);
    ok(
      await call(t, '/api/v1/attachments', {
        as: louis,
        body: {
          locationId: home.id,
          url: 'https://centre.example/job/77',
          subject: { claimId: c.id },
          role: 'proof',
        },
      }),
      201,
    );
    expect(ok<{ items: Claim[] }>(await claims(louis, vacuum.id)).items[0]?.documents).toHaveLength(
      1,
    );
    expect((await delClaim(louis, c.id, 7)).statusCode).toBe(412);
    const res = await delClaim(louis, c.id, 1);
    ok(res, 204);
    expect(ok<{ items: Claim[] }>(await claims(louis, vacuum.id)).items).toEqual([]);
    const deleted = (await eventsOf(c.id)).find((e) => e.action === 'claim.delete');
    expect(deleted?.diff).toMatchObject({
      opened_on: { before: '2026-06-01', after: null },
      documents: { before: [{ role: 'proof' }] },
    });
    ok(await undo(louis, res.headers['x-kept-audit-event'] as string));
    const back = ok<{ items: Claim[] }>(await claims(louis, vacuum.id)).items;
    expect(back).toMatchObject([
      { id: c.id, openedOn: '2026-06-01', documents: [{ url: 'https://centre.example/job/77' }] },
    ]);
  });
});
