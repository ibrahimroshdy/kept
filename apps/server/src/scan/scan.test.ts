import { KEPT_VERSION, newId, randomShortCode } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, createThing, type Loc, ok, own, place } from '../../test/things.js';
import { barcodeTransport } from './barcode.js';

// T17: scan resolution and barcode lookup through the front door, in the web contract's shapes
// (apps/web/src/api/capture/types.ts `ScanOutcome`, `BarcodeLookup`).

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home and Cottage
let talia: Person; // viewer of Home
let bruce: Person; // another household
let home: Loc;
let cottage: Loc;
let garage: Loc;

const realFetch = barcodeTransport.fetch;

const resolve = (as: Person, text: string, format?: string) =>
  call(t, '/api/v1/scan/resolve', { as, body: { text, ...(format ? { format } : {}) } });
const barcode = (as: Person, code: string) => call(t, `/api/v1/barcodes/${code}`, { as });
const answer = (res: LightMyRequestResponse) => ({
  status: res.statusCode,
  body: res.body,
  type: res.headers['content-type'],
});

async function legacy(loc: Loc, source: string, collection: string, code: string, thingId: string) {
  await own(
    db,
    `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [loc.id, source, collection, code, thingId],
  );
}

async function setting(key: string, value: unknown) {
  await own(
    db,
    `INSERT INTO public.instance_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(value)],
  );
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  talia = await person(t, db, 'talia');
  bruce = await person(t, db, 'bruce');
  home = await createLocation(t, db, ibrahim, 'household');
  cottage = await createLocation(t, db, ibrahim, 'household', 'Cottage');
  garage = await createLocation(t, db, bruce, 'household', 'Garage');
  await join(db, home.id, talia.userId, 'viewer');
});

afterEach(() => {
  barcodeTransport.fetch = realFetch;
});

afterAll(async () => {
  await t.app.close();
});

describe('POST /api/v1/scan/resolve', () => {
  it('opens a thing or a place you can see, by a bare code or any host’s link (D120)', async () => {
    const drill = await createThing(t, ibrahim, home, { name: 'Drill' });
    expect(ok(await resolve(talia, `https://kept.elsewhere.example/l/${drill.shortCode}`))).toEqual(
      {
        outcome: 'open',
        target: { kind: 'thing', id: drill.id, locationId: home.id },
      },
    );
    const code = drill.shortCode as string;
    const typed = `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase();
    expect(ok(await resolve(ibrahim, typed))).toMatchObject({ outcome: 'open' });
    const shelf = await place(db, home, 'Shelf B');
    const placeCode = randomShortCode();
    await own(
      db,
      'INSERT INTO public.short_ids (code, location_id, place_id) VALUES ($1, $2, $3)',
      [placeCode, home.id, shelf],
    );
    expect(ok(await resolve(ibrahim, placeCode, 'qr_code'))).toEqual({
      outcome: 'open',
      target: { kind: 'place', id: shelf, locationId: home.id },
    });
    // Opening marks nothing seen (D40): the phone calls POST /things/:id/seen itself.
    const seen = await own<{ last_seen_at: Date | null }>(
      db,
      'SELECT last_seen_at FROM public.things WHERE id = $1',
      [drill.id],
    );
    const before = seen[0]?.last_seen_at?.getTime();
    await resolve(ibrahim, code);
    const after = await own<{ last_seen_at: Date | null }>(
      db,
      'SELECT last_seen_at FROM public.things WHERE id = $1',
      [drill.id],
    );
    expect(after[0]?.last_seen_at?.getTime()).toBe(before);
  });

  it('offers a blank of your writable location to claim; a viewer gets "not in your Kept"', async () => {
    const code = randomShortCode();
    await own(
      db,
      `INSERT INTO public.short_ids (code, location_id, state, is_primary) VALUES ($1, $2, 'blank', false)`,
      [code, home.id],
    );
    expect(ok(await resolve(ibrahim, code))).toEqual({ outcome: 'claim', locationId: home.id });
    expect(ok(await resolve(talia, code))).toEqual({ outcome: 'not_in_your_kept' });
  });

  it("answers B's code, B's blank, a retired code, a trashed thing and a random code byte for byte alike", async () => {
    const crate = await createThing(t, bruce, garage, { name: 'Crate' });
    const theirBlank = randomShortCode();
    const retired = randomShortCode();
    await own(
      db,
      `INSERT INTO public.short_ids (code, location_id, state, is_primary)
       VALUES ($1, $2, 'blank', false), ($3, $4, 'retired', false)`,
      [theirBlank, garage.id, retired, home.id],
    );
    const gone = await createThing(t, ibrahim, home, { name: 'Old fan' });
    await own(
      db,
      'UPDATE public.things SET deleted_at = now(), trash_batch_id = uuidv7() WHERE id = $1',
      [gone.id],
    );
    const random = answer(await resolve(ibrahim, randomShortCode()));
    expect(random.status).toBe(200);
    expect(JSON.parse(random.body)).toEqual({ outcome: 'not_in_your_kept' });
    for (const code of [crate.shortCode as string, theirBlank, retired, gone.shortCode as string]) {
      expect(answer(await resolve(ibrahim, code))).toEqual(random);
      expect(answer(await resolve(ibrahim, `https://x.example/l/${code}`))).toEqual(random);
    }
  });

  it('opens an old Homebox label, and asks which when its asset ID is in two collections (D146)', async () => {
    const lamp = await createThing(t, ibrahim, home, { name: 'Lamp' });
    const tent = await createThing(t, ibrahim, cottage, { name: 'Tent' });
    const rug = await createThing(t, ibrahim, home, { name: 'Rug' });
    const uuid = newId();
    await legacy(home, 'homebox', 'c1', '000-014', lamp.id);
    await legacy(cottage, 'homebox', 'c2', '000-014', tent.id);
    await legacy(home, 'homebox', 'c1', uuid.toUpperCase(), rug.id);
    // Bruce has the same asset ID: never a candidate for anyone else.
    const crate = await createThing(t, bruce, garage, { name: 'Crate' });
    await legacy(garage, 'homebox', 'c9', '000-014', crate.id);

    const both = ok(await resolve(ibrahim, 'https://homebox.example/a/000-014'));
    expect(both).toEqual({
      outcome: 'legacy_ambiguous',
      candidates: [
        {
          locationName: 'Cottage',
          locationId: cottage.id,
          name: 'Tent',
          kind: 'thing',
          id: tent.id,
        },
        { locationName: 'Home', locationId: home.id, name: 'Lamp', kind: 'thing', id: lamp.id },
      ],
    });
    expect(ok(await resolve(talia, 'https://homebox.example/a/14'))).toEqual({
      outcome: 'open',
      target: { kind: 'thing', id: lamp.id, locationId: home.id },
    });
    expect(ok(await resolve(talia, `https://homebox.example/item/${uuid}`))).toMatchObject({
      outcome: 'open',
      target: { id: rug.id },
    });
    expect(ok(await resolve(talia, `https://homebox.example/item/${newId()}`))).toEqual({
      outcome: 'not_in_your_kept',
    });
  });

  it('resolves an imported CSV code typed as it is printed', async () => {
    const saw = await createThing(t, ibrahim, home, { name: 'Saw' });
    await legacy(home, 'csv', '', 'GAR-0042', saw.id);
    expect(ok(await resolve(ibrahim, ' gar-0042 '))).toEqual({
      outcome: 'open',
      target: { kind: 'thing', id: saw.id, locationId: home.id },
    });
    expect(ok(await resolve(bruce, 'GAR-0042'))).toEqual({ outcome: 'not_kept', text: 'GAR-0042' });
  });

  it('opens a re-issued Kept label by its old code; a short ID still wins (step-7 T14, Q9)', async () => {
    // Garage's crate holds the code; Home imported an export whose fan was printed with it.
    const crate = await createThing(t, bruce, garage, { name: 'Crate' });
    const fan = await createThing(t, ibrahim, home, { name: 'Fan' });
    const old = crate.shortCode as string;
    await legacy(home, 'kept', '', old, fan.id);
    const fanTarget = {
      outcome: 'open',
      target: { kind: 'thing', id: fan.id, locationId: home.id },
    };
    expect(ok(await resolve(ibrahim, `https://kept.old.example/l/${old}`))).toEqual(fanTarget);
    expect(ok(await resolve(talia, old.toLowerCase()))).toEqual(fanTarget);
    expect(ok(await resolve(bruce, `https://kept.old.example/l/${old}`))).toEqual({
      outcome: 'open',
      target: { kind: 'thing', id: crate.id, locationId: garage.id },
    });
    // Another household's re-issued code is the same miss as a random one.
    const gone = randomShortCode();
    await legacy(garage, 'kept', '', gone, crate.id);
    const random = answer(await resolve(ibrahim, randomShortCode()));
    expect(answer(await resolve(ibrahim, gone))).toEqual(random);
    expect(answer(await resolve(ibrahim, `https://x.example/l/${gone}`))).toEqual(random);
  });

  it('names a product barcode, with whether lookup is on, and shows any other text', async () => {
    await setting('barcode_lookup', false);
    expect(ok(await resolve(ibrahim, '4006381333931', 'ean_13'))).toEqual({
      outcome: 'barcode',
      barcode: { code: '4006381333931', lookupEnabled: false },
    });
    await setting('barcode_lookup', true);
    expect(ok(await resolve(ibrahim, '4006381333931'))).toEqual({
      outcome: 'barcode',
      barcode: { code: '4006381333931', lookupEnabled: true },
    });
    expect(ok(await resolve(ibrahim, 'WIFI:S:home;T:WPA;P:secret;;', 'qr_code'))).toEqual({
      outcome: 'not_kept',
      text: 'WIFI:S:home;T:WPA;P:secret;;',
    });
    expect((await call(t, '/api/v1/scan/resolve', { body: { text: 'x' } })).statusCode).toBe(401);
  });
});

describe('GET /api/v1/barcodes/:code', () => {
  const offProduct = {
    status: 1,
    status_verbose: 'product found',
    code: '3017624010701',
    product: { product_name: 'Nutella', brands: 'Ferrero, Nutella', quantity: '400 g' },
  };

  it('answers enabled:false with no outbound call when lookup is off (D126)', async () => {
    await setting('barcode_lookup', false);
    const spy = vi.fn();
    barcodeTransport.fetch = spy as unknown as typeof fetch;
    expect(ok(await barcode(ibrahim, '3017624010701'))).toEqual({ enabled: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks Open Food Facts once, with the User-Agent, and names the product', async () => {
    await setting('barcode_lookup', true);
    await setting('barcode_contact', 'ibrahim@example.com');
    const spy = vi.fn(async () => Response.json(offProduct));
    barcodeTransport.fetch = spy as unknown as typeof fetch;
    expect(ok(await barcode(ibrahim, '3017624010701'))).toEqual({
      enabled: true,
      found: true,
      product: { name: 'Nutella', brand: 'Ferrero', quantity: '400 g' },
      attribution: 'Open Food Facts (ODbL)',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://world.openfoodfacts.org/api/v2/product/3017624010701.json?fields=product_name,brands,quantity',
    );
    expect((init.headers as Record<string, string>)['user-agent']).toBe(
      `Kept/${KEPT_VERSION} (ibrahim@example.com)`,
    );
  });

  it('asks the sister databases in turn when Open Food Facts has no such product', async () => {
    await setting('barcode_lookup', true);
    const spy = vi.fn(async (url: string) =>
      url.includes('openbeautyfacts')
        ? Response.json({
            status: 1,
            product: { product_name: 'Soap', brands: '', quantity: null },
          })
        : url.includes('openproductsfacts')
          ? new Response('{}', { status: 404 })
          : Response.json({ status: 0, status_verbose: 'product not found' }),
    );
    barcodeTransport.fetch = spy as unknown as typeof fetch;
    expect(ok(await barcode(ibrahim, '5000000000009'))).toEqual({
      enabled: true,
      found: true,
      product: { name: 'Soap', brand: null, quantity: null },
      attribution: 'Open Beauty Facts (ODbL)',
    });
    expect(spy).toHaveBeenCalledTimes(3);
    // Text that can't be a GTIN is not found, with no call at all.
    spy.mockClear();
    expect(ok(await barcode(ibrahim, 'ABC-123'))).toMatchObject({ enabled: true, found: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses the 16th lookup in a minute with 429 and Retry-After (§3.2)', async () => {
    await setting('barcode_lookup', true);
    await own(db, 'DELETE FROM auth.sign_in_failures');
    barcodeTransport.fetch = vi.fn(async () =>
      Response.json({ status: 0 }),
    ) as unknown as typeof fetch;
    for (let i = 0; i < 15; i++) {
      expect((await barcode(i % 2 ? ibrahim : bruce, '3017624010701')).statusCode).toBe(200);
    }
    const over = await barcode(talia, '3017624010701');
    expect(over.statusCode).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('the admin settings for barcode lookup and former hostnames (T16, T17)', () => {
  it('turns lookup on with a contact and lists former hostnames, audited, and refuses the own host', async () => {
    const admin = await person(t, db, 'ibrahim-admin');
    await own(db, 'INSERT INTO public.instance_admins (user_id) VALUES ($1)', [admin.userId]);
    const put = (body: Record<string, unknown>) =>
      call(t, '/api/v1/admin/settings', { as: admin, method: 'PUT', body });
    const res = ok(
      await put({
        barcodeLookup: true,
        barcodeContact: 'ops@example.com',
        formerHostnames: ['Kept.Old.example', 'kept.old.example'],
      }),
    );
    expect(res).toMatchObject({
      barcodeLookup: { value: true, locked: false },
      barcodeContact: { value: 'ops@example.com', locked: false },
      formerHostnames: ['kept.old.example'],
    });
    const events = await own<{ diff: Record<string, unknown> }>(
      db,
      `SELECT diff FROM public.audit_events WHERE action = 'instance.settings_update'
        ORDER BY at DESC LIMIT 1`,
    );
    expect(Object.keys(events[0]?.diff ?? {}).sort()).toEqual(
      expect.arrayContaining(['barcode_contact', 'former_hostnames']),
    );
    expect((await put({ formerHostnames: ['localhost'] })).statusCode).toBe(400);
    expect((await put({ formerHostnames: ['not a host!'] })).statusCode).toBe(400);
    expect((await put({ barcodeContact: 'nope' })).statusCode).toBe(400);
    expect((await call(t, '/api/v1/admin/settings', { as: ibrahim })).statusCode).toBe(403);
  });
});
