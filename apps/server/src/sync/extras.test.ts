import { createHash } from 'node:crypto';
import {
  KEEP_OFFLINE,
  newId,
  type SyncExtra,
  type SyncExtrasEstimate,
  type SyncExtrasPage,
} from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, type Loc, own as ownOf } from '../../test/things.js';
import { withScope } from '../db/scope.js';
import { extrasPage } from './extras.js';

// "Keep this location available offline" through the front door (step-8 plan T12; D159, D181,
// Q21). Ibrahim owns Home (household: money and warranties on) and Garage (essentials: both
// off). In Home, Louis is a member and Talia a viewer (Home hides money from viewers). Alfred has
// his own account and sees nothing of Ibrahim's.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let louis: Person;
let talia: Person;
let alfred: Person;
let home: Loc;
let garage: Loc;

const own = <T extends import('pg').QueryResultRow>(text: string, values: unknown[] = []) =>
  ownOf<T>(db, text, values);

const ok = <T>(res: LightMyRequestResponse, status = 200): T => {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
};

const extras = (as: Person, locationId: string, query = '') =>
  call(t, `/api/v1/sync/extras?locationId=${locationId}${query}`, { as });

async function thing(loc: Loc, name: string): Promise<string> {
  const id = newId();
  await own('INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, $4)', [
    id,
    loc.id,
    loc.unplacedId,
    name,
  ]);
  return id;
}

/** A stored file of `bytes`, attached to `subject` with `role`. Returns the attachment id. */
async function attach(
  loc: Loc,
  by: Person,
  subject: Record<string, string>,
  role: string,
  bytes: number,
  mime = 'application/pdf',
): Promise<{ attachmentId: string; fileId: string }> {
  const fileId = newId();
  const sha = createHash('sha256').update(fileId).digest('hex');
  await own(
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'not_applicable', $8)`,
    [
      fileId,
      loc.id,
      `f/${loc.id}/${fileId}`,
      sha,
      bytes,
      mime,
      mime === 'image/jpeg' ? 'photo' : 'document',
      by.userId,
    ],
  );
  const [column, id] = Object.entries(subject)[0] as [string, string];
  const attachmentId = newId();
  await own(
    `INSERT INTO public.attachments (id, location_id, file_id, ${column}, role, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [attachmentId, loc.id, fileId, id, role, by.userId],
  );
  return { attachmentId, fileId };
}

let tv: string;
let kettle: string;
let bare: string;
let mower: string;
const docs: Record<string, { attachmentId: string; fileId: string }> = {};

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'essentials', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');

  // The television: bought for 4,999.50 EGP, valued at 3,000, with its manual, a photo, the
  // purchase's receipt, a warranty card, and a service manual too large to keep.
  tv = await thing(home, 'Television');
  const vendor = newId();
  await own('INSERT INTO public.vendors (id, owner_account_id, name) VALUES ($1, $2, $3)', [
    vendor,
    home.accountId,
    'VENDORMARKER Electronics',
  ]);
  const purchase = newId();
  await own(
    `INSERT INTO public.purchases (id, location_id, vendor_id, purchased_on, currency, total)
     VALUES ($1, $2, $3, '2026-09-01', 'EGP', 4999.5)`,
    [purchase, home.id, vendor],
  );
  const line = newId();
  await own(
    `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, unit_price)
     VALUES ($1, $2, $3, 'Television', 4999.5)`,
    [line, home.id, purchase],
  );
  await own('UPDATE public.things SET purchase_line_id = $1 WHERE id = $2', [line, tv]);
  await own(
    `INSERT INTO public.valuations (location_id, thing_id, value, currency, valued_on, source,
                                    created_by)
     VALUES ($1, $2, 3000, 'EGP', '2026-10-01', 'estimate', $3)`,
    [home.id, tv, ibrahim.userId],
  );
  docs.manual = await attach(home, ibrahim, { thing_id: tv }, 'manual', 1000);
  docs.photo = await attach(home, ibrahim, { thing_id: tv }, 'photo', 700, 'image/jpeg');
  docs.receipt = await attach(home, ibrahim, { purchase_id: purchase }, 'receipt', 500);
  const warranty = newId();
  await own(
    `INSERT INTO public.warranties (id, location_id, thing_id, kind, starts_on, claim_contact,
                                    created_by, lifetime)
     VALUES ($1, $2, $3, 'manufacturer', '2026-09-01', 'CONTACTMARKER 0100', $4, true)`,
    [warranty, home.id, tv, ibrahim.userId],
  );
  docs.card = await attach(home, ibrahim, { warranty_id: warranty }, 'warranty_doc', 200);
  docs.huge = await attach(home, ibrahim, { thing_id: tv }, 'manual', KEEP_OFFLINE.fileBytes + 1);

  // A kettle with only a manual; a thing with nothing to keep.
  kettle = await thing(home, 'Kettle');
  docs.kettle = await attach(home, ibrahim, { thing_id: kettle }, 'document', 300);
  bare = await thing(home, 'Spoon');

  // Garage (money and warranties off): a mower with a manual and a warranty card.
  mower = await thing(garage, 'Mower');
  docs.mowerManual = await attach(garage, ibrahim, { thing_id: mower }, 'manual', 400);
  const gw = newId();
  await own(
    `INSERT INTO public.warranties (id, location_id, thing_id, kind, starts_on, created_by,
                                    lifetime)
     VALUES ($1, $2, $3, 'manufacturer', '2026-09-01', $4, true)`,
    [gw, garage.id, mower, ibrahim.userId],
  );
  docs.mowerCard = await attach(garage, ibrahim, { warranty_id: gw }, 'warranty_doc', 100);
}, 120_000);

const itemOf = (page: SyncExtrasPage, thingId: string): SyncExtra | undefined =>
  page.items.find((x) => x.thingId === thingId);
const attachmentIds = (item: SyncExtra | undefined) =>
  (item?.documents ?? []).map((d) => d.attachmentId).sort();

describe('GET /api/v1/sync/extras', () => {
  it("gives the owner the location's money and documents, never photos", async () => {
    const page = ok<SyncExtrasPage>(await extras(ibrahim, home.id));
    expect(page.next_cursor).toBeNull();
    const item = itemOf(page, tv);
    expect(item?.purchase).toEqual({ date: '2026-09-01', price: '4999.5', currency: 'EGP' });
    expect(item?.currentValue).toEqual({ amount: '3000', currency: 'EGP' });
    expect(item?.moneyHidden).toBeUndefined();
    expect(attachmentIds(item)).toEqual(
      [docs.manual, docs.receipt, docs.card, docs.huge].map((d) => d?.attachmentId).sort(),
    );
    const receipt = item?.documents.find((d) => d.attachmentId === docs.receipt?.attachmentId);
    expect(receipt).toMatchObject({ kind: 'receipt', mime: 'application/pdf', bytes: 500 });
    expect(receipt?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(attachmentIds(itemOf(page, kettle))).toEqual([docs.kettle?.attachmentId]);
    // Nothing to keep: left out.
    expect(itemOf(page, bare)).toBeUndefined();
    // The documents within the per-file cap, each once: not the huge manual.
    expect(page.totalBytes).toBe(1000 + 500 + 200 + 300);
  });

  it('estimates the whole location before anything downloads', async () => {
    const estimate = ok<SyncExtrasEstimate>(await extras(ibrahim, home.id, '&estimate=1'));
    expect(estimate).toEqual({ things: 2, documents: 5, totalBytes: 2000 });
  });

  it('gives a member the same documents', async () => {
    const page = ok<SyncExtrasPage>(await extras(louis, home.id));
    expect(attachmentIds(itemOf(page, tv))).toHaveLength(4);
    expect(itemOf(page, tv)?.currentValue).toEqual({ amount: '3000', currency: 'EGP' });
  });

  it('hides money from a viewer where Home hides it, and gives her no originals', async () => {
    const res = await extras(talia, home.id);
    const page = ok<SyncExtrasPage>(res);
    const item = itemOf(page, tv);
    expect(item).toEqual({
      thingId: tv,
      purchase: { date: '2026-09-01', price: null, currency: null },
      currentValue: null,
      moneyHidden: true,
      documents: [],
    });
    // The kettle has nothing a viewer can keep.
    expect(itemOf(page, kettle)).toBeUndefined();
    expect(res.body).not.toContain('4999');
    expect(res.body).not.toContain('3000');
    expect(page.totalBytes).toBe(0);
  });

  it('shows a viewer the money once Home lets viewers see it', async () => {
    await own('UPDATE public.locations SET money_visible_to_viewers = true WHERE id = $1', [
      home.id,
    ]);
    try {
      const page = ok<SyncExtrasPage>(await extras(talia, home.id));
      expect(itemOf(page, tv)?.purchase?.price).toBe('4999.5');
      expect(itemOf(page, tv)?.documents).toEqual([]);
    } finally {
      await own('UPDATE public.locations SET money_visible_to_viewers = false WHERE id = $1', [
        home.id,
      ]);
    }
  });

  it("drops a module's documents while it is off", async () => {
    // Garage: money and warranties are off, so the card goes and the money is hidden.
    const page = ok<SyncExtrasPage>(await extras(ibrahim, garage.id));
    const item = itemOf(page, mower);
    expect(item?.moneyHidden).toBe(true);
    expect(attachmentIds(item)).toEqual([docs.mowerManual?.attachmentId]);
    // Home with warranties turned off: the television's card goes, its manual stays.
    const setWarranties = (on: boolean) =>
      own(
        `INSERT INTO public.location_modules (location_id, module, enabled)
         VALUES ($1, 'warranties', $2)
         ON CONFLICT (location_id, module) DO UPDATE SET enabled = excluded.enabled`,
        [home.id, on],
      );
    await setWarranties(false);
    try {
      const home2 = ok<SyncExtrasPage>(await extras(ibrahim, home.id));
      expect(attachmentIds(itemOf(home2, tv))).not.toContain(docs.card?.attachmentId);
      expect(attachmentIds(itemOf(home2, tv))).toContain(docs.manual?.attachmentId);
    } finally {
      await setWarranties(true);
    }
  });

  it("is a 404 for a location the caller isn't in", async () => {
    expect((await extras(alfred, home.id)).statusCode).toBe(404);
    expect((await extras(alfred, home.id, '&estimate=1')).statusCode).toBe(404);
    expect((await extras(ibrahim, alfred.personalLocationId)).statusCode).toBe(404);
    expect((await call(t, `/api/v1/sync/extras?locationId=${home.id}`)).statusCode).toBe(401);
  });

  it('never carries a vendor, a contact detail or a secret', async () => {
    const res = await extras(ibrahim, home.id);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('VENDORMARKER');
    expect(res.body).not.toContain('CONTACTMARKER');
    expect(res.body).not.toContain('Television');
  });

  it('refuses a cursor that is not one of its own', async () => {
    expect((await extras(ibrahim, home.id, '&cursor=garbage')).statusCode).toBe(400);
    const forged = Buffer.from(JSON.stringify({ k: 'not-a-uuid' })).toString('base64url');
    expect((await extras(ibrahim, home.id, `&cursor=${forged}`)).statusCode).toBe(400);
  });

  it('walks every thing a page at a time', async () => {
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r: { items: SyncExtra[]; next: string | null } = await withScope(
        db.pools.app,
        { userId: ibrahim.userId, mfa: false },
        (tx, c) => extrasPage(tx, c, { userId: ibrahim.userId, mfa: false }, home.id, after, 1),
      );
      seen.push(...r.items.map((x) => x.thingId));
      if (r.next === null) break;
      after = r.next;
    }
    expect(seen.sort()).toEqual([tv, kettle].sort());
  });
});
