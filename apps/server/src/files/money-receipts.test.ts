import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, uniqueJpeg, upload } from '../../test/files.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, ok, own } from '../../test/things.js';
import { withScope } from '../db/scope.js';

// Receipts and invoices are money (security review #1, #10, #12, #22). A receipt shows the price,
// so when the caller's gate hides money (a viewer where viewers don't see money, or anyone where
// the Money module is off) the receipt and invoice attachments are withheld everywhere they could
// leave: a thing's purchase, the purchase itself, the attachment lists, and the signed-URL route.
// A thing's purchase also drops its currency then. And after a move within the account, a member
// of the thing's new location still gets its receipt (D115), though the purchase stayed behind.
//
// Ann owns Home and Office (Household: money on) and Shed (Essentials: money off). In Home Bob is
// a member and Vic a viewer; Bob is a member of the Shed too. Nobody but Ann sees the Office.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ann: Person;
let bob: Person;
let vic: Person;
let home: Loc;
let office: Loc;
let shed: Loc;

type Attachment = { id: string; role: string; file: { id: string } | null };
type ThingView = {
  purchase: {
    purchaseId: string | null;
    currency?: string | null;
    unitPrice?: string;
    moneyHidden?: true;
    receipts: Attachment[];
  } | null;
  attachmentsCount?: number;
};

const get = async (as: Person, url: string) => ok(await call(t, url, { as }));
const thingOf = async (as: Person, id: string) =>
  (await get(as, `/api/v1/things/${id}`)) as unknown as ThingView;
const urlFor = (as: Person, fileId: string, variant: string, query = '') =>
  call(t, `/api/v1/files/${fileId}/url${query}`, { as, body: { variant } });
const setViewerToggle = (loc: Loc, on: boolean) =>
  own(db, 'UPDATE public.locations SET money_visible_to_viewers = $2 WHERE id = $1', [loc.id, on]);

async function uploaded(as: Person, loc: Loc): Promise<string> {
  const res = await upload(t, as, loc.id, await uniqueJpeg(), { cls: 'evidence' });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

async function attach(as: Person, loc: Loc, fileId: string, subject: object, role: string) {
  return ok(
    await call(t, '/api/v1/attachments', {
      as,
      body: { locationId: loc.id, fileId, subject, role },
    }),
    201,
  );
}

/** A thing bought on a purchase in `loc`, with a receipt: {thing, purchase, receipt (file id)}. */
async function bought(as: Person, loc: Loc, name: string) {
  const thing = ok(
    await call(t, '/api/v1/things', {
      as,
      body: { locationId: loc.id, placeId: loc.unplacedId, name },
    }),
    201,
  ).id;
  const purchase = ok(
    await call(t, '/api/v1/purchases', {
      as,
      body: {
        locationId: loc.id,
        purchasedOn: '2026-09-01',
        currency: 'GBP',
        lines: [{ description: name, quantity: 1, thingId: thing }],
      },
    }),
    201,
  ).id;
  const receipt = await uploaded(as, loc);
  await attach(as, loc, receipt, { purchaseId: purchase }, 'receipt');
  return { thing, purchase, receipt };
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  vic = await person(t, db, 'vic');
  home = await createLocation(t, db, ann, 'household', 'Home');
  office = await createLocation(t, db, ann, 'household', 'Office');
  shed = await createLocation(t, db, ann, 'essentials', 'Shed');
  await join(db, home.id, bob.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
  await join(db, shed.id, bob.userId, 'member');
});

afterAll(async () => {
  await t.app.close();
  await files.cleanup();
});

describe('a viewer where viewers do not see money (#1, #10, #22)', () => {
  let fridge: { thing: string; purchase: string; receipt: string };
  beforeAll(async () => {
    fridge = await bought(ann, home, 'Fridge');
  });

  it("leaves the receipts and the currency out of the thing's purchase", async () => {
    const seen = await thingOf(vic, fridge.thing);
    expect(seen.purchase?.moneyHidden).toBe(true);
    expect(seen.purchase?.receipts).toEqual([]);
    expect(seen.purchase).not.toHaveProperty('currency');
    expect(JSON.stringify(seen)).not.toContain(fridge.receipt);

    const member = await thingOf(bob, fridge.thing);
    expect(member.purchase?.currency).toBe('GBP');
    expect(member.purchase?.receipts.map((r) => r.file?.id)).toEqual([fridge.receipt]);
  });

  it('leaves them out of the purchase and its attachment list', async () => {
    const p = await get(vic, `/api/v1/purchases/${fridge.purchase}`);
    expect(p.receipts).toEqual([]);
    const list = await get(vic, `/api/v1/purchases/${fridge.purchase}/attachments`);
    expect(list.items).toEqual([]);
    const byRole = await get(vic, `/api/v1/purchases/${fridge.purchase}/attachments?role=receipt`);
    expect(byRole.items).toEqual([]);

    const member = await get(bob, `/api/v1/purchases/${fridge.purchase}/attachments`);
    expect((member.items as Attachment[]).map((a) => a.role)).toEqual(['receipt']);
  });

  it('refuses a signed URL for a file that is only a receipt, and gives one while it is also a photo', async () => {
    for (const variant of ['display', 'thumb', 'share', 'original']) {
      expect((await urlFor(vic, fridge.receipt, variant)).statusCode, variant).toBe(404);
    }
    expect((await urlFor(bob, fridge.receipt, 'display')).statusCode).toBe(200);

    await attach(ann, home, fridge.receipt, { thingId: fridge.thing }, 'photo');
    expect((await urlFor(vic, fridge.receipt, 'display')).statusCode).toBe(200);
  });

  it('shows them again while the location lets viewers see money', async () => {
    await setViewerToggle(home, true);
    try {
      const seen = await thingOf(vic, fridge.thing);
      expect(seen.purchase?.currency).toBe('GBP');
      expect(seen.purchase?.receipts).toHaveLength(1);
      const p = await get(vic, `/api/v1/purchases/${fridge.purchase}`);
      expect(p.receipts).toHaveLength(1);
    } finally {
      await setViewerToggle(home, false);
    }
  });
});

describe('a member where the Money module is off (#10)', () => {
  it('sees no receipts, and may not add one', async () => {
    const rake = await bought(ann, home, 'Rake');
    // Move it to the Shed (money off) the way the app does, within Ann's account.
    await withScope(db.pools.app, { userId: ann.userId, mfa: false }, (_tx, c) =>
      c.query('SELECT kept.move_things(ARRAY[$1]::uuid[], $2, $3, NULL)', [
        rake.thing,
        shed.id,
        shed.unplacedId,
      ]),
    );
    const seen = await thingOf(bob, rake.thing);
    expect(seen.purchase?.receipts).toEqual([]);
    expect(seen.purchase).not.toHaveProperty('currency');

    const shedBuy = ok(
      await call(t, '/api/v1/purchases', {
        as: bob,
        body: { locationId: shed.id, purchasedOn: '2026-09-02', lines: [] },
      }),
      201,
    ).id;
    const file = await uploaded(bob, shed);
    const refused = await call(t, '/api/v1/attachments', {
      as: bob,
      body: {
        locationId: shed.id,
        fileId: file,
        subject: { purchaseId: shedBuy },
        role: 'receipt',
      },
    });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().code).toBe('module_off');

    // A photo is fine, and can't be turned into an invoice either.
    const photo = await attach(bob, shed, file, { purchaseId: shedBuy }, 'photo');
    const retyped = await call(t, `/api/v1/attachments/${photo.id}`, {
      as: bob,
      method: 'PATCH',
      body: { role: 'invoice' },
      headers: { 'if-match': String(photo.rowVersion) },
    });
    expect(retyped.statusCode, retyped.body).toBe(409);
    expect(retyped.json().code).toBe('module_off');
  });
});

describe('receipts after a move within the account (#12, D115)', () => {
  it("gives a member of the thing's new location the receipt the purchase kept behind", async () => {
    const printer = await bought(ann, office, 'Printer');
    await withScope(db.pools.app, { userId: ann.userId, mfa: false }, (_tx, c) =>
      c.query('SELECT kept.move_things(ARRAY[$1]::uuid[], $2, $3, NULL)', [
        printer.thing,
        home.id,
        home.unplacedId,
      ]),
    );

    const seen = await thingOf(bob, printer.thing);
    expect(seen.purchase?.purchaseId).toBeNull();
    expect(seen.purchase?.receipts).toHaveLength(1);
    const [receipt] = seen.purchase?.receipts ?? [];
    expect(receipt?.role).toBe('receipt');
    expect(receipt?.file?.id).toBe(printer.receipt);
    // A full view, previews and all, from kept.thing_receipts() (0033): Bob can't read the
    // file row where the purchase stayed, so everything comes from the definer.
    const [row] = await own<{ sha256: string; bytes: string }>(
      db,
      'SELECT sha256, bytes::text AS bytes FROM public.files WHERE id = $1',
      [printer.receipt],
    );
    expect(receipt?.file).toMatchObject({
      sha256: row?.sha256,
      bytes: Number(row?.bytes),
      mime: 'image/jpeg',
      class: 'evidence',
      derivativeState: 'ready',
    });
    const file = receipt?.file as { thumbUrl: string | null; displayUrl: string | null } | null;
    expect(file?.thumbUrl).toEqual(expect.any(String));
    expect(file?.displayUrl).toEqual(expect.any(String));
    // And the web can open it the way it opens any receipt after a move.
    const url = await urlFor(bob, printer.receipt, 'original', `?thingId=${printer.thing}`);
    expect(url.statusCode, url.body).toBe(200);

    // A viewer can't open an original (D117), and money is hidden from Vic here anyway.
    expect((await thingOf(vic, printer.thing)).purchase?.receipts).toEqual([]);
  });

  it('refuses the ?thingId= URL when money is hidden in the thing’s location', async () => {
    const drill = await bought(ann, office, 'Drill');
    await withScope(db.pools.app, { userId: ann.userId, mfa: false }, (_tx, c) =>
      c.query('SELECT kept.move_things(ARRAY[$1]::uuid[], $2, $3, NULL)', [
        drill.thing,
        shed.id,
        shed.unplacedId,
      ]),
    );
    const res = await urlFor(bob, drill.receipt, 'original', `?thingId=${drill.thing}`);
    expect(res.statusCode).toBe(404);
    expect((await thingOf(bob, drill.thing)).purchase?.receipts).toEqual([]);
  });
});
