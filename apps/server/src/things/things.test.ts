import { newId, randomShortCode, SHORT_CODE } from '@kept/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  eventsOf,
  type Json,
  type Loc,
  ok,
  own,
  place,
  setDisplayName,
} from '../../test/things.js';
import { renderAudit } from '../audit/render.js';
import { withScope } from '../db/scope.js';
import { allocateShortId } from '../places/short-id.js';
import { moneyShaped, moneyShapedClasses } from './audit-image.js';

// Task 14 through the front door, as the web calls it (apps/web/src/api/inventory/{types,
// paths}.ts, mock/things.ts). Rows are seeded as kept_owner only where no route makes them yet
// (account types, vendors, people, tags); every thing is made and read through the app as a
// signed-in user on kept_app.

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];

let ann: Person; // owner of `home` (complete: money and secrets on)
let mo: Person; // member of `home`
let vic: Person; // viewer of `home`
let bob: Person; // owner of his own home, nothing of Ann's
let home: Loc;
let basic: Loc; // Ann's Essentials location: no money module
let bobs: Loc;
let collectible: string; // Ann's account type with a money field, a text field and a required one
let artwork: string; // another account type sharing only `edition`

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent });
  ann = await person(t, db, 'ann');
  mo = await person(t, db, 'mo');
  vic = await person(t, db, 'vic');
  bob = await person(t, db, 'bob');
  await setDisplayName(db, ann, 'Ann');
  await setDisplayName(db, mo, 'Alfred');
  home = await createLocation(t, db, ann, 'complete');
  basic = await createLocation(t, db, ann, 'essentials', 'Cabin');
  bobs = await createLocation(t, db, bob, 'complete', 'Bob home');
  await join(db, home.id, mo.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
  await join(db, basic.id, mo.userId, 'member');

  const [c] = await own<{ id: string }>(
    db,
    `INSERT INTO public.types (owner_account_id, name, icon, capabilities)
     VALUES ($1, 'Collectible', 'lucide:gem', '{}') RETURNING id`,
    [home.accountId],
  );
  collectible = c?.id as string;
  await own(
    db,
    `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind, required, sort)
     VALUES ($1, $2, 'appraised', 'Appraised value', 'money', false, 1),
            ($1, $2, 'edition', 'Edition', 'text', false, 2),
            ($1, $2, 'maker', 'Maker', 'text', true, 3)`,
    [home.accountId, collectible],
  );
  const [a] = await own<{ id: string }>(
    db,
    `INSERT INTO public.types (owner_account_id, name, icon, capabilities)
     VALUES ($1, 'Artwork', 'lucide:frame', '{}') RETURNING id`,
    [home.accountId],
  );
  artwork = a?.id as string;
  await own(
    db,
    `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind)
     VALUES ($1, $2, 'edition', 'Edition', 'text')`,
    [home.accountId, artwork],
  );
});

const get = (as: Person, url: string) => call(t, url, { as });
const thingOf = async (as: Person, id: string) => ok(await get(as, `/api/v1/things/${id}`));

describe('POST /api/v1/things', () => {
  // catalogue: POST /api/v1/things
  it('creates a thing in the Unplaced area with a short ID, stamped by the caller, audited', async () => {
    const res = await call(t, '/api/v1/things', {
      as: mo,
      body: {
        locationId: home.id,
        placeId: home.unplacedId,
        name: 'HDMI cable',
        aliases: { ar: ['كابل'] },
        model: 'X2',
      },
    });
    const view = ok(res, 201);
    expect(view.name).toBe('HDMI cable');
    expect(view.shortCode).toMatch(SHORT_CODE);
    expect(view.placeId).toBe(home.unplacedId);
    expect(view.path).toEqual([
      expect.objectContaining({ id: home.unplacedId, kind: 'place', isUnplaced: true }),
    ]);
    expect(view.lastSeenAt).toEqual(expect.any(String));
    expect(view.rowVersion).toBe(1);
    expect(view.isContainer).toBe(false);
    const [row] = await own<{ created_by: string; code: string }>(
      db,
      `SELECT t.created_by, s.code FROM public.things t
         JOIN public.short_ids s ON s.thing_id = t.id WHERE t.id = $1`,
      [view.id],
    );
    expect(row?.created_by).toBe(mo.userId);
    expect(row?.code).toBe(view.shortCode);
    const events = await eventsOf(db, home.id, view.id);
    expect(events.map((e) => e.action)).toEqual(['thing.create']);
    expect(events[0]?.actor_id).toBe(mo.userId);
    expect(events[0]?.diff.name).toEqual({ before: null, after: 'HDMI cable', class: 'plain' });
  });

  it('creates a thing inside a container, with the path through it', async () => {
    const box = await createThing(t, ann, home, {
      name: 'Box 3',
      typeId: await builtinType(db, 'box_bin'),
    });
    expect(box.isContainer).toBe(true);
    const inside = await createThing(t, ann, home, { name: 'Charger', containerId: box.id });
    expect(inside.containerId).toBe(box.id);
    // Each step carries its short ID, so a breadcrumb links by code (D208, T19).
    expect((inside.path as { id: string; kind: string }[]).at(-1)).toEqual(
      expect.objectContaining({ id: box.id, kind: 'container', shortCode: box.shortCode }),
    );
    const [where] = await own<{ code: string | null }>(
      db,
      `SELECT (SELECT s.code FROM public.short_ids s
                WHERE s.place_id = t.place_id AND s.is_primary AND s.state = 'assigned') AS code
         FROM public.things t WHERE t.id = $1`,
      [box.id],
    );
    const read = (await thingOf(ann, inside.id)).path as { kind: string; shortCode: unknown }[];
    expect(read[0]).toMatchObject({ kind: 'place', shortCode: where?.code ?? null });
    expect(read.at(-1)?.shortCode).toBe(box.shortCode);
    expect((await thingOf(ann, box.id)).contentsCount).toBe(1);
  });

  it('accepts a client id in the UUIDv7 window, and refuses one another tenant used alike', async () => {
    const id = newId();
    const made = await createThing(t, ann, home, { id, name: 'Chosen id' });
    expect(made.id).toBe(id);
    const again = await call(t, '/api/v1/things', {
      as: bob,
      body: { id, locationId: bobs.id, placeId: bobs.unplacedId, name: 'Clash' },
    });
    expect(again.statusCode).toBe(404);
  });

  it("gives a car its type's default meter (D113)", async () => {
    const car = await createThing(t, ann, home, {
      name: 'Corolla',
      typeId: await builtinType(db, 'car'),
    });
    expect(car.meters).toEqual([
      expect.objectContaining({ kind: 'distance', unit: 'km', latest: null, needsReview: 0 }),
    ]);
    expect(car.quantity).toBe(1);
  });

  it('applies D10: serialized is one by one, consumables may be 0, others never 0', async () => {
    const tool = await call(t, '/api/v1/things', {
      as: ann,
      body: {
        locationId: home.id,
        placeId: home.unplacedId,
        name: 'Drills',
        quantity: 2,
        typeId: await builtinType(db, 'tool'),
      },
    });
    expect(tool.statusCode).toBe(400);
    expect(tool.json().hint).toMatch(/must be 1/);
    const cables = await createThing(t, ann, home, {
      name: 'Zip ties',
      quantity: 0,
      typeId: await builtinType(db, 'cable'),
    });
    expect(cables.quantity).toBe(0);
    const plain = await call(t, '/api/v1/things', {
      as: ann,
      body: { locationId: home.id, placeId: home.unplacedId, name: 'Nothing', quantity: 0 },
    });
    expect(plain.statusCode).toBe(400);
    const decimal = await createThing(t, ann, home, { name: 'Rope (m)', quantity: 2.5 });
    expect(decimal.quantity).toBe(2.5);
  });

  it('makes a one-line purchase, and gates its price by role and module', async () => {
    const [vendor] = await own<{ id: string }>(
      db,
      `INSERT INTO public.vendors (owner_account_id, name, kind) VALUES ($1, 'B.TECH', 'store')
       RETURNING id`,
      [home.accountId],
    );
    const made = await createThing(t, mo, home, {
      name: 'Kettle',
      purchase: {
        purchasedOn: '2026-09-01',
        vendorId: vendor?.id,
        currency: 'EGP',
        price: '1250.50',
      },
    });
    expect(made.purchase).toEqual(
      expect.objectContaining({
        purchasedOn: '2026-09-01',
        vendor: { id: vendor?.id, name: 'B.TECH' },
        currency: 'EGP',
        lineDescription: 'Kettle',
        quantity: 1,
        // Canonical, as /purchases/:id answers it (not numeric(16,4)'s "1250.5000").
        unitPrice: '1250.5',
        receipts: [],
      }),
    );
    // One form for one amount: the purchase says the same as the thing.
    const bought = made.purchase as { purchaseId: string; unitPrice: string };
    const whole = ok(await call(t, `/api/v1/purchases/${bought.purchaseId}`, { as: mo }));
    expect((whole.lines as { unitPrice: string }[])[0]?.unitPrice).toBe(bought.unitPrice);
    expect(whole.total).toBe('1250.5');
    const asViewer = await thingOf(vic, made.id);
    const purchase = asViewer.purchase as Record<string, unknown>;
    expect(purchase).not.toHaveProperty('unitPrice');
    expect(purchase.moneyHidden).toBe(true);
    // The currency goes with the price (security review #22).
    expect(purchase).not.toHaveProperty('currency');
    expect(asViewer.moneyHidden).toBe(true);
    const actions = await own<{ action: string; diff: Record<string, { class: string }> }>(
      db,
      `SELECT action, diff FROM public.audit_events WHERE location_id = $1 AND root_thing_id = $2
        ORDER BY at, id`,
      [home.id, made.id],
    );
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining(['purchase.create', 'purchase_line.create', 'thing.create']),
    );
    const line = actions.find((a) => a.action === 'purchase_line.create');
    expect(line?.diff.unit_price?.class).toBe('money');

    // Essentials has no money module: a price is refused, not silently dropped.
    const off = await call(t, '/api/v1/things', {
      as: mo,
      body: {
        locationId: basic.id,
        placeId: basic.unplacedId,
        name: 'Kettle',
        purchase: { purchasedOn: '2026-09-01', currency: 'EGP', price: '10' },
      },
    });
    expect(off.statusCode).toBe(409);
    expect(off.json().code).toBe('module_off');
  });

  it('refuses a purchase date in the future and a disabled currency', async () => {
    const future = await call(t, '/api/v1/things', {
      as: ann,
      body: {
        locationId: home.id,
        placeId: home.unplacedId,
        name: 'Later',
        purchase: { purchasedOn: '2999-01-01', currency: 'EGP', price: '1' },
      },
    });
    expect(future.statusCode).toBe(400);
    const odd = await call(t, '/api/v1/things', {
      as: ann,
      body: {
        locationId: home.id,
        placeId: home.unplacedId,
        name: 'Odd',
        purchase: { purchasedOn: '2026-01-01', currency: 'XAU', price: '1' },
      },
    });
    expect(odd.statusCode).toBe(400);
  });

  it("answers 404 for another tenant's location, place, type or tag, and 403 for a viewer", async () => {
    const base = { locationId: home.id, placeId: home.unplacedId, name: 'X' };
    expect((await call(t, '/api/v1/things', { as: bob, body: base })).statusCode).toBe(404);
    expect(
      (await call(t, '/api/v1/things', { as: ann, body: { ...base, placeId: bobs.unplacedId } }))
        .statusCode,
    ).toBe(404);
    const [bobType] = await own<{ id: string }>(
      db,
      `INSERT INTO public.types (owner_account_id, name, icon) VALUES ($1, 'Bob type', 'lucide:box')
       RETURNING id`,
      [bobs.accountId],
    );
    expect(
      (await call(t, '/api/v1/things', { as: ann, body: { ...base, typeId: bobType?.id } }))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(t, '/api/v1/things', { as: ann, body: { ...base, typeId: newId() } })).statusCode,
    ).toBe(404);
    const [bobTag] = await own<{ id: string }>(
      db,
      `INSERT INTO public.tags (owner_account_id, name) VALUES ($1, 'bob tag') RETURNING id`,
      [bobs.accountId],
    );
    expect(
      (await call(t, '/api/v1/things', { as: ann, body: { ...base, tagIds: [bobTag?.id] } }))
        .statusCode,
    ).toBe(404);
    expect((await call(t, '/api/v1/things', { as: vic, body: base })).statusCode).toBe(403);
  });
});

describe('custom fields', () => {
  it('validates custom against the type, refuses secret keys, and keeps required fields', async () => {
    const base = {
      locationId: home.id,
      placeId: home.unplacedId,
      name: 'Print',
      typeId: collectible,
    };
    const unknown = await call(t, '/api/v1/things', {
      as: ann,
      body: { ...base, custom: { nope: 1 } },
    });
    expect(unknown.statusCode).toBe(400);
    const badMoney = await call(t, '/api/v1/things', {
      as: ann,
      body: { ...base, custom: { appraised: '12' } },
    });
    expect(badMoney.statusCode).toBe(400);
    expect(badMoney.json().hint).toContain('body.custom.appraised');

    const router = await builtinType(db, 'network_device');
    const secret = await call(t, '/api/v1/things', {
      as: ann,
      body: { ...base, typeId: router, custom: { wifi_password: 'hunter2' } },
    });
    expect(secret.statusCode).toBe(400);
    expect(JSON.stringify(secret.json())).not.toContain('hunter2');

    const made = await createThing(t, ann, home, { ...base, custom: { maker: 'Hokusai' } });
    const cleared = await call(t, `/api/v1/things/${made.id}`, {
      method: 'PATCH',
      as: ann,
      headers: { 'if-match': String(made.rowVersion) },
      body: { custom: { maker: null } },
    });
    expect(cleared.statusCode).toBe(400);
  });

  it('keeps custom money in canonical form, in and out', async () => {
    const made = await createThing(t, ann, home, {
      name: 'Etching',
      typeId: collectible,
      custom: { appraised: { amount: '00450.50', currency: 'EGP' } },
    });
    expect(made.custom).toMatchObject({ appraised: { amount: '450.5', currency: 'EGP' } });
    // A value stored padded before this rule still leaves in canonical form.
    await own(
      db,
      `UPDATE public.things SET custom = jsonb_set(custom, '{appraised,amount}', '"450.5000"')
        WHERE id = $1`,
      [made.id],
    );
    expect((await thingOf(ann, made.id)).custom).toMatchObject({
      appraised: { amount: '450.5', currency: 'EGP' },
    });
  });

  it('audits custom per key, money classed money and hidden from a viewer (D110)', async () => {
    const made = await createThing(t, ann, home, {
      name: 'Wave print',
      typeId: collectible,
      custom: { edition: '1/50' },
    });
    const res = await call(t, `/api/v1/things/${made.id}`, {
      method: 'PATCH',
      as: ann,
      headers: { 'if-match': String(made.rowVersion) },
      body: { custom: { appraised: { amount: '90000', currency: 'EGP' }, edition: '2/50' } },
    });
    const view = ok(res);
    expect(view.custom).toEqual({
      appraised: { amount: '90000', currency: 'EGP' },
      edition: '2/50',
      maker: undefined,
    });
    const [, update] = await eventsOf(db, home.id, made.id);
    expect(update?.action).toBe('thing.update');
    expect(update?.diff['custom.appraised']).toEqual({
      before: null,
      after: { amount: '90000', currency: 'EGP' },
      class: 'money',
    });
    expect(update?.diff['custom.edition']).toEqual({
      before: '1/50',
      after: '2/50',
      class: 'plain',
    });
    expect(update?.diff).not.toHaveProperty('custom');

    // renderAudit: a viewer sees that the value changed, never the amount.
    const [raw] = await own<Record<string, unknown>>(
      db,
      'SELECT * FROM public.audit_events WHERE id = $1',
      [update?.id],
    );
    const row = {
      id: raw?.id,
      at: raw?.at,
      locationId: raw?.location_id,
      ownerAccountId: raw?.owner_account_id,
      actorType: raw?.actor_type,
      actorId: raw?.actor_id,
      action: raw?.action,
      entityType: raw?.entity_type,
      entityId: raw?.entity_id,
      rootThingId: raw?.root_thing_id,
      diff: raw?.diff,
      requestId: raw?.request_id,
      undoOf: raw?.undo_of,
      undoableUntil: raw?.undoable_until,
    } as Parameters<typeof renderAudit>[0];
    const forViewer = renderAudit(row, { role: 'viewer', moneyVisibleToViewers: false });
    expect(forViewer.diff?.['custom.appraised']).toEqual({
      changed: true,
      class: 'money',
      hidden: true,
    });
    expect(forViewer.diff?.['custom.edition']).toEqual({
      before: '1/50',
      after: '2/50',
      class: 'plain',
    });

    // The view: a viewer gets no money value; with the location's toggle on, they do (D13).
    const asViewer = await thingOf(vic, made.id);
    expect(asViewer.custom).toEqual({ edition: '2/50' });
    expect(asViewer.moneyHidden).toBe(true);
    await own(db, 'UPDATE public.locations SET money_visible_to_viewers = true WHERE id = $1', [
      home.id,
    ]);
    try {
      const shown = await thingOf(vic, made.id);
      expect(shown.custom).toEqual({
        edition: '2/50',
        appraised: { amount: '90000', currency: 'EGP' },
      });
      expect(shown).not.toHaveProperty('moneyHidden');
    } finally {
      await own(db, 'UPDATE public.locations SET money_visible_to_viewers = false WHERE id = $1', [
        home.id,
      ]);
    }
  });

  it('refuses money writes where the money module is off (409 module_off)', async () => {
    const [cabinType] = await own<{ id: string }>(db, `SELECT id FROM public.types WHERE id = $1`, [
      collectible,
    ]);
    const made = await createThing(t, mo, basic, { name: 'Print', typeId: cabinType?.id });
    const res = await call(t, `/api/v1/things/${made.id}`, {
      method: 'PATCH',
      as: mo,
      headers: { 'if-match': String(made.rowVersion) },
      body: { custom: { appraised: { amount: '1', currency: 'EGP' } } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('module_off');
    // Plain fields still save.
    const plain = await call(t, `/api/v1/things/${made.id}`, {
      method: 'PATCH',
      as: mo,
      headers: { 'if-match': String(made.rowVersion) },
      body: { custom: { edition: 'A/P' } },
    });
    expect(ok(plain).custom).toEqual({ edition: 'A/P' });
  });

  it('summarises secrets without values: set, and who may reveal (D116)', async () => {
    const router = await createThing(t, ann, home, {
      name: 'Router',
      typeId: await builtinType(db, 'network_device'),
    });
    const secrets = router.secrets as { fieldKey: string; set: boolean; canReveal: boolean }[];
    expect(secrets.map((s) => s.fieldKey).sort()).toEqual(['linked_account', 'wifi_password']);
    expect(secrets.every((s) => !s.set && s.canReveal)).toBe(true);
    const asMember = await thingOf(mo, router.id);
    expect((asMember.secrets as { canReveal: boolean }[]).every((s) => s.canReveal === false)).toBe(
      true,
    );
    expect(JSON.stringify(asMember)).not.toMatch(/ciphertext/);
  });
});

describe('GET /api/v1/things/:id', () => {
  it('is 200 for a viewer and 404 for anyone outside, the same as a missing id', async () => {
    const made = await createThing(t, ann, home, { name: 'Lamp' });
    expect((await get(vic, `/api/v1/things/${made.id}`)).statusCode).toBe(200);
    const outside = await get(bob, `/api/v1/things/${made.id}`);
    const missing = await get(bob, `/api/v1/things/${newId()}`);
    expect(outside.statusCode).toBe(404);
    expect(outside.json()).toEqual(missing.json());
  });

  it('shows type-resolved fields with their sources, tags, brand, belongs-to and links', async () => {
    const [brand] = await own<{ id: string }>(
      db,
      `INSERT INTO public.brands (owner_account_id, name) VALUES ($1, 'Sony') RETURNING id`,
      [home.accountId],
    );
    const [tag] = await own<{ id: string }>(
      db,
      `INSERT INTO public.tags (owner_account_id, name, colour) VALUES ($1, 'living', '#aaaa00') RETURNING id`,
      [home.accountId],
    );
    const [who] = await own<{ id: string }>(
      db,
      `INSERT INTO public.people (owner_account_id, display_name) VALUES ($1, 'Sinbad') RETURNING id`,
      [home.accountId],
    );
    const tv = await createThing(t, ann, home, {
      name: 'TV',
      typeId: await builtinType(db, 'network_device'),
      brandId: brand?.id,
      tagIds: [tag?.id],
      belongsToPersonId: who?.id,
    });
    expect(tv.brand).toEqual({ id: brand?.id, name: 'Sony' });
    expect(tv.tags).toEqual([{ id: tag?.id, name: 'living', colour: '#aaaa00' }]);
    expect(tv.belongsTo).toEqual({ id: who?.id, displayName: 'Sinbad' });
    const fields = tv.fields as { key: string; labelKey: string | null; source: { via: string } }[];
    const via = Object.fromEntries(fields.map((f) => [f.key, f.source.via]));
    expect(via.wifi_password).toBe('own');
    expect(via.os).toBe('group');
    expect(fields.filter((f) => f.key === 'os')).toHaveLength(1);
    expect(fields.find((f) => f.key === 'os')?.labelKey).toBe('os');
    expect(tv.type).toEqual(expect.objectContaining({ builtinKey: 'network_device', name: null }));

    // An account child type: its own field, and its parent's inherited, root first.
    const [poster] = await own<{ id: string }>(
      db,
      `INSERT INTO public.types (owner_account_id, parent_id, name, icon)
       VALUES ($1, $2, 'Poster', 'lucide:image') RETURNING id`,
      [home.accountId, collectible],
    );
    await own(
      db,
      `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind)
       VALUES ($1, $2, 'size', 'Size', 'text')`,
      [home.accountId, poster?.id],
    );
    const print = await createThing(t, ann, home, {
      name: 'Poster',
      typeId: poster?.id,
      custom: { size: 'A2', edition: 'open' },
    });
    const posterFields = print.fields as {
      key: string;
      label: string;
      source: { via: string; typeId: string };
    }[];
    expect(posterFields.map((f) => [f.key, f.source.via])).toEqual([
      ['appraised', 'inherited'],
      ['edition', 'inherited'],
      ['maker', 'inherited'],
      ['size', 'own'],
    ]);
    expect(posterFields[0]?.source.typeId).toBe(collectible);
    expect(print.custom).toEqual({ size: 'A2', edition: 'open' });
  });
  it("links a moved thing's purchase to its own vendor, even among vendors of the same name", async () => {
    // Two vendors of one name in Ann's account; the purchase names the second (D115).
    const vendors = await own<{ id: string }>(
      db,
      `INSERT INTO public.vendors (owner_account_id, name, kind)
       VALUES ($1, 'Metro', 'store'), ($1, 'Metro', 'store') RETURNING id`,
      [home.accountId],
    );
    const bought = vendors.map((v) => v.id).sort()[1] as string;
    const kettle = await createThing(t, ann, home, {
      name: 'Kettle',
      purchase: { purchasedOn: '2026-03-03', vendorId: bought, currency: 'EGP', price: '700' },
    });
    // Moved within the account: the purchase stays in `home`, the thing goes to the cabin, where
    // Cy sees it without seeing `home` or its purchase.
    await own(db, 'UPDATE public.things SET location_id = $2, place_id = $3 WHERE id = $1', [
      kettle.id,
      basic.id,
      basic.unplacedId,
    ]);
    const cy = await person(t, db, 'cy');
    await join(db, basic.id, cy.userId, 'viewer');
    const view = await thingOf(cy, kettle.id);
    expect(view.purchase).toMatchObject({
      purchaseId: null,
      vendor: { id: bought, name: 'Metro' },
    });
  });
});

describe('PATCH /api/v1/things/:id', () => {
  // catalogue: PATCH /api/v1/things/:id
  it('edits fields, merges custom per key, replaces tags and aliases per language, audited', async () => {
    const [tag] = await own<{ id: string }>(
      db,
      `INSERT INTO public.tags (owner_account_id, name) VALUES ($1, 'kitchen') RETURNING id`,
      [home.accountId],
    );
    const made = await createThing(t, ann, home, {
      name: 'Mixer',
      aliases: { en: ['blender'], ar: ['خلاط'] },
    });
    const res = await call(t, `/api/v1/things/${made.id}`, {
      method: 'PATCH',
      as: mo,
      headers: { 'if-match': String(made.rowVersion) },
      body: {
        name: 'Stand mixer',
        condition: 'good',
        aliases: { en: ['kitchen machine'], ar: [] },
        tagIds: [tag?.id],
        notes: '',
      },
    });
    const view = ok(res);
    expect(view.name).toBe('Stand mixer');
    expect(view.condition).toBe('good');
    expect(view.aliases).toEqual({ en: ['kitchen machine'] });
    expect(view.tags).toEqual([expect.objectContaining({ id: tag?.id })]);
    expect(view.notes).toBeNull();
    expect(view.rowVersion).toBe((made.rowVersion as number) + 1);
    const events = await eventsOf(db, home.id, made.id);
    const update = events.at(-1);
    expect(update?.action).toBe('thing.update');
    expect(update?.actor_id).toBe(mo.userId);
    expect(update?.undoable_until).not.toBeNull();
    expect(update?.diff.name).toEqual({ before: 'Mixer', after: 'Stand mixer', class: 'plain' });
    expect(update?.diff.tag_ids).toEqual({ before: [], after: [tag?.id], class: 'plain' });
  });

  it('answers 412 with the conflicting fields and who changed it (D156), 428 without If-Match', async () => {
    const made = await createThing(t, ann, home, { name: 'Vase' });
    ok(
      await call(t, `/api/v1/things/${made.id}`, {
        method: 'PATCH',
        as: mo,
        headers: { 'if-match': String(made.rowVersion) },
        body: { colour: 'blue' },
      }),
    );
    const stale = await call(t, `/api/v1/things/${made.id}`, {
      method: 'PATCH',
      as: ann,
      headers: { 'if-match': String(made.rowVersion) },
      body: { colour: 'red', notes: 'chipped' },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toEqual(
      expect.objectContaining({
        code: 'precondition_failed',
        conflicts: ['colour', 'notes'],
        row_version: (made.rowVersion as number) + 1,
        changedBy: { displayName: 'Alfred' },
      }),
    );
    const none = await call(t, `/api/v1/things/${made.id}`, {
      method: 'PATCH',
      as: ann,
      body: { colour: 'red' },
    });
    expect(none.statusCode).toBe(428);
  });

  it('checks D10 on quantity edits: not for a thing with a meter', async () => {
    const car = await createThing(t, ann, home, {
      name: 'Van',
      typeId: await builtinType(db, 'car'),
    });
    const res = await call(t, `/api/v1/things/${car.id}`, {
      method: 'PATCH',
      as: ann,
      headers: { 'if-match': String(car.rowVersion) },
      body: { quantity: 2 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reindexes the location when a container with things in it is renamed (T20)', async () => {
    const box = await createThing(t, ann, home, { name: 'Crate' });
    await createThing(t, ann, home, { name: 'Inside', containerId: box.id });
    sent.length = 0;
    ok(
      await call(t, `/api/v1/things/${box.id}`, {
        method: 'PATCH',
        as: ann,
        headers: { 'if-match': String(box.rowVersion) },
        body: { name: 'Crate A' },
      }),
    );
    expect(sent).toContainEqual({ name: 'reindex', data: { locationId: home.id } });
  });
});

describe('the viewer and the outsider', () => {
  it('lets a viewer read and refuses every write with 403; an outsider gets 404', async () => {
    const made = await createThing(t, ann, home, { name: 'Clock', quantity: 3 });
    const v = { 'if-match': String(made.rowVersion) };
    const writes: [string, string, unknown][] = [
      ['PATCH', `/api/v1/things/${made.id}`, { name: 'x' }],
      ['POST', `/api/v1/things/${made.id}/lifecycle`, { lifecycle: 'sold' }],
      ['POST', `/api/v1/things/${made.id}/seen`, {}],
      ['POST', `/api/v1/things/${made.id}/not-here`, {}],
      ['POST', `/api/v1/things/${made.id}/retype`, { typeId: collectible }],
      ['POST', `/api/v1/things/${made.id}/duplicate`, {}],
      ['POST', `/api/v1/things/${made.id}/split`, { quantity: 1 }],
      ['POST', `/api/v1/things/${made.id}/links`, { toThingId: made.id, kind: 'related' }],
      ['POST', `/api/v1/things/${made.id}/convert-to-place`, {}],
    ];
    for (const [method, url, body] of writes) {
      const asViewer = await call(t, url, {
        method: method as 'POST',
        as: vic,
        headers: v,
        body,
      });
      expect(asViewer.statusCode, `${method} ${url}`).toBe(403);
      const asOutsider = await call(t, url, {
        method: method as 'POST',
        as: bob,
        headers: v,
        body,
      });
      expect(asOutsider.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await thingOf(ann, made.id)).rowVersion).toBe(made.rowVersion);
  });
});

describe('lifecycle, seen and not here', () => {
  // catalogue: POST /api/v1/things/:id/lifecycle
  it('ends a thing with a gated price, and in_use clears the end (found, D119), audited', async () => {
    const made = await createThing(t, ann, home, { name: 'Bike' });
    const sold = ok(
      await call(t, `/api/v1/things/${made.id}/lifecycle`, {
        as: ann,
        headers: { 'if-match': String(made.rowVersion) },
        body: {
          lifecycle: 'sold',
          endedOn: '2026-09-20',
          endedPrice: '3000',
          endedCurrency: 'EGP',
          endedTo: 'Louis',
        },
      }),
    );
    expect(sold.lifecycle).toBe('sold');
    expect(sold.derivedState).toEqual(['ended']);
    expect(sold.ended).toEqual({
      on: '2026-09-20',
      price: '3000',
      currency: 'EGP',
      to: 'Louis',
      notes: null,
    });
    const asViewer = await thingOf(vic, made.id);
    expect(asViewer.ended).toEqual({
      on: '2026-09-20',
      moneyHidden: true,
      to: 'Louis',
      notes: null,
    });
    const events = await eventsOf(db, home.id, made.id);
    const ended = events.at(-1);
    expect(ended?.action).toBe('thing.lifecycle');
    expect(ended?.diff.ended_price).toEqual({ before: null, after: '3000.0000', class: 'money' });
    expect(ended?.undoable_until).not.toBeNull();

    const found = ok(
      await call(t, `/api/v1/things/${made.id}/lifecycle`, {
        as: ann,
        headers: { 'if-match': String(sold.rowVersion) },
        body: { lifecycle: 'in_use' },
      }),
    );
    expect(found.ended).toBeNull();
    expect(found.derivedState).toEqual([]);
  });

  it('refuses half a price, and a price where money is off', async () => {
    const made = await createThing(t, ann, home, { name: 'Sofa' });
    const half = await call(t, `/api/v1/things/${made.id}/lifecycle`, {
      as: ann,
      headers: { 'if-match': String(made.rowVersion) },
      body: { lifecycle: 'sold', endedPrice: '10' },
    });
    expect(half.statusCode).toBe(400);
    const cabin = await createThing(t, ann, basic, { name: 'Sofa' });
    const off = await call(t, `/api/v1/things/${cabin.id}/lifecycle`, {
      as: ann,
      headers: { 'if-match': String(cabin.rowVersion) },
      body: { lifecycle: 'sold', endedPrice: '10', endedCurrency: 'EGP' },
    });
    expect(off.statusCode).toBe(409);
  });

  // catalogue: POST /api/v1/things/:id/not-here
  it('marks a thing not here: uncertain, audited (D40)', async () => {
    const made = await createThing(t, ann, home, { name: 'Keys' });
    const view = ok(await call(t, `/api/v1/things/${made.id}/not-here`, { as: mo, body: {} }));
    expect(view.locationUncertain).toBe(true);
    expect(view.derivedState).toEqual(['uncertain']);
    const events = await eventsOf(db, home.id, made.id);
    expect(events.at(-1)?.action).toBe('thing.not_here');
    expect(events.at(-1)?.diff.location_uncertain).toEqual({
      before: false,
      after: true,
      class: 'plain',
    });
  });

  // catalogue: POST /api/v1/things/:id/seen
  it('marks a thing seen now and clears not-here, audited (D40)', async () => {
    const made = await createThing(t, ann, home, { name: 'Wallet' });
    await own(
      db,
      `UPDATE public.things SET last_seen_at = now() - interval '400 days', location_uncertain = true
        WHERE id = $1`,
      [made.id],
    );
    const res = ok(await call(t, `/api/v1/things/${made.id}/seen`, { as: mo, body: {} }));
    expect(Date.now() - Date.parse(res.lastSeenAt as string)).toBeLessThan(60_000);
    expect((await thingOf(ann, made.id)).locationUncertain).toBe(false);
    const events = await eventsOf(db, home.id, made.id);
    expect(events.at(-1)?.action).toBe('thing.seen');
    expect(events.at(-1)?.diff).toHaveProperty('last_seen_at');
  });
});

describe('retype, duplicate and split', () => {
  // catalogue: POST /api/v1/things/:id/retype
  it('re-types: matching keys stay, the rest are archived, never deleted (D92), audited', async () => {
    const made = await createThing(t, ann, home, {
      name: 'Etching',
      typeId: collectible,
      custom: { edition: '3/9', maker: 'Goya', appraised: { amount: '5', currency: 'EGP' } },
    });
    const view = ok(
      await call(t, `/api/v1/things/${made.id}/retype`, {
        as: ann,
        headers: { 'if-match': String(made.rowVersion) },
        body: { typeId: artwork },
      }),
    );
    expect(view.custom).toEqual({ edition: '3/9' });
    expect(view.archivedCustom).toEqual({
      maker: 'Goya',
      appraised: { amount: '5', currency: 'EGP' },
    });
    const asViewer = await thingOf(vic, made.id);
    expect(asViewer.archivedCustom).toEqual({ maker: 'Goya' });
    const events = await eventsOf(db, home.id, made.id);
    const retype = events.at(-1);
    expect(retype?.action).toBe('thing.retype');
    expect(retype?.diff['archived_custom.appraised']?.class).toBe('money');
    expect(retype?.diff.type_id).toEqual({ before: collectible, after: artwork, class: 'plain' });

    // And back: the archived values return.
    const back = ok(
      await call(t, `/api/v1/things/${made.id}/retype`, {
        as: ann,
        headers: { 'if-match': String(view.rowVersion) },
        body: { typeId: collectible },
      }),
    );
    expect(back.custom).toEqual({
      edition: '3/9',
      maker: 'Goya',
      appraised: { amount: '5', currency: 'EGP' },
    });
    expect(back.archivedCustom).toEqual({});
  });

  // catalogue: POST /api/v1/things/:id/duplicate
  it('duplicates: same place, new short ID, no serial, no purchase, audited', async () => {
    const made = await createThing(t, ann, home, {
      name: 'Speaker',
      serial: 'SN-1',
      purchase: { purchasedOn: '2026-01-01', currency: 'EGP', price: '100' },
    });
    const copy = ok(
      await call(t, `/api/v1/things/${made.id}/duplicate`, { as: mo, body: {} }),
      201,
    );
    expect(copy.id).not.toBe(made.id);
    expect(copy.name).toBe('Speaker');
    expect(copy.serial).toBeNull();
    expect(copy.purchase).toBeNull();
    expect(copy.placeId).toBe(made.placeId);
    expect(copy.shortCode).toMatch(SHORT_CODE);
    expect(copy.shortCode).not.toBe(made.shortCode);
    const events = await eventsOf(db, home.id, copy.id);
    expect(events.map((e) => e.action)).toEqual(['thing.create']);
    expect(events[0]?.diff.duplicate_of).toEqual({ before: null, after: made.id, class: 'plain' });
  });

  // catalogue: POST /api/v1/things/:id/split
  it('splits part of a quantity into a new thing with the same purchase line (D10), audited', async () => {
    const shelf = await place(db, home, 'Shelf');
    const made = await createThing(t, ann, home, {
      name: 'HDMI cables',
      quantity: 6,
      typeId: await builtinType(db, 'cable'),
      purchase: { purchasedOn: '2026-01-01', currency: 'EGP', price: '50' },
    });
    const res = ok(
      await call(t, `/api/v1/things/${made.id}/split`, {
        as: mo,
        body: { quantity: 2, to: { placeId: shelf } },
      }),
    );
    expect(res.originalId).toBe(made.id);
    const part = await thingOf(ann, res.newId as string);
    const original = await thingOf(ann, made.id);
    expect(original.quantity).toBe(4);
    expect(part.quantity).toBe(2);
    expect(part.placeId).toBe(shelf);
    expect(part.shortCode).toMatch(SHORT_CODE);
    expect((part.purchase as { lineDescription: string }).lineDescription).toBe('HDMI cables');
    const [row] = await own<{ split_from_id: string; purchase_line_id: string }>(
      db,
      'SELECT split_from_id, purchase_line_id FROM public.things WHERE id = $1',
      [part.id],
    );
    expect(row?.split_from_id).toBe(made.id);
    const events = await eventsOf(db, home.id, made.id);
    expect(events.at(-1)?.action).toBe('thing.split');
    expect(events.at(-1)?.diff.quantity).toEqual({
      before: '6.000',
      after: '4.000',
      class: 'plain',
    });
    expect((await eventsOf(db, home.id, part.id)).map((e) => e.action)).toEqual(['thing.create']);

    // Then list: both, found by the shelf and the Unplaced area.
    const onShelf = ok(await get(ann, `/api/v1/things?placeId=${shelf}`));
    expect((onShelf.items as Json[]).map((x) => x.id)).toEqual([part.id]);
  });

  it('refuses to split the whole, or anything counted one by one', async () => {
    const made = await createThing(t, ann, home, { name: 'Pens', quantity: 3 });
    const whole = await call(t, `/api/v1/things/${made.id}/split`, {
      as: ann,
      body: { quantity: 3 },
    });
    expect(whole.statusCode).toBe(400);
    const tool = await createThing(t, ann, home, {
      name: 'Saw',
      typeId: await builtinType(db, 'tool'),
    });
    const one = await call(t, `/api/v1/things/${tool.id}/split`, {
      as: ann,
      body: { quantity: 1 },
    });
    expect(one.statusCode).toBe(400);
    const stale = await call(t, `/api/v1/things/${made.id}/split`, {
      as: ann,
      headers: { 'if-match': '999' },
      body: { quantity: 1 },
    });
    expect(stale.statusCode).toBe(412);
  });
});

describe('links, convert and codes', () => {
  // catalogue: POST /api/v1/things/:id/links
  it('links two things of a location (D76), audited; the other side sees it', async () => {
    const camera = await createThing(t, ann, home, { name: 'Camera' });
    const lens = await createThing(t, ann, home, { name: 'Lens' });
    const link = ok(
      await call(t, `/api/v1/things/${lens.id}/links`, {
        as: mo,
        body: { toThingId: camera.id, kind: 'accessory_of' },
      }),
      201,
    );
    expect(link).toEqual(
      expect.objectContaining({
        kind: 'accessory_of',
        direction: 'from',
        thing: expect.objectContaining({ id: camera.id }),
      }),
    );
    const cameraView = await thingOf(ann, camera.id);
    expect(cameraView.links).toEqual([
      expect.objectContaining({
        id: link.id,
        direction: 'to',
        thing: expect.objectContaining({ id: lens.id }),
      }),
    ]);
    const events = await eventsOf(db, home.id, link.id);
    expect(events.map((e) => e.action)).toEqual(['thing.link']);
    const again = await call(t, `/api/v1/things/${lens.id}/links`, {
      as: mo,
      body: { toThingId: camera.id, kind: 'accessory_of' },
    });
    expect(again.statusCode).toBe(409);
    const elsewhere = await createThing(t, ann, basic, { name: 'Tripod' });
    const across = await call(t, `/api/v1/things/${lens.id}/links`, {
      as: ann,
      body: { toThingId: elsewhere.id, kind: 'related' },
    });
    expect(across.statusCode).toBe(400);
  });

  // catalogue: DELETE /api/v1/thing-links/:linkId
  it('removes a link, audited', async () => {
    const a = await createThing(t, ann, home, { name: 'Printer' });
    const b = await createThing(t, ann, home, { name: 'Toner' });
    const link = ok(
      await call(t, `/api/v1/things/${b.id}/links`, {
        as: ann,
        body: { toThingId: a.id, kind: 'consumable_for' },
      }),
      201,
    );
    expect(
      (await call(t, `/api/v1/thing-links/${link.id}`, { method: 'DELETE', as: vic })).statusCode,
    ).toBe(403);
    const res = await call(t, `/api/v1/thing-links/${link.id}`, { method: 'DELETE', as: mo });
    expect(res.statusCode).toBe(204);
    expect((await thingOf(ann, a.id)).links).toEqual([]);
    const events = await eventsOf(db, home.id, link.id);
    expect(events.map((e) => e.action)).toEqual(['thing.link', 'thing.unlink']);
  });

  // catalogue: POST /api/v1/things/:id/convert-to-place
  it('converts a container to a place with the same id (Q14), audited, reindexed', async () => {
    const box = await createThing(t, ann, home, { name: 'Toy box' });
    const toy = await createThing(t, ann, home, { name: 'Lego', containerId: box.id });
    sent.length = 0;
    const res = ok(
      await call(t, `/api/v1/things/${box.id}/convert-to-place`, {
        as: ann,
        headers: { 'if-match': String(box.rowVersion) },
        body: {},
      }),
    );
    expect(res.placeId).toBe(box.id);
    expect((await get(ann, `/api/v1/things/${box.id}`)).statusCode).toBe(404);
    expect((await thingOf(ann, toy.id)).placeId).toBe(box.id);
    const events = await eventsOf(db, home.id, box.id);
    expect(events.slice(-2).map((e) => e.action)).toEqual([
      'thing.convert_to_place',
      'place.create',
    ]);
    expect(sent).toContainEqual({ name: 'reindex', data: { locationId: home.id } });
    const car = await createThing(t, ann, home, {
      name: 'Jeep',
      typeId: await builtinType(db, 'car'),
    });
    const metered = await call(t, `/api/v1/things/${car.id}/convert-to-place`, {
      as: ann,
      headers: { 'if-match': String(car.rowVersion) },
      body: { discard: true },
    });
    expect(metered.statusCode).toBe(409);
  });

  it("looks up codes: its own, folded input; another tenant's and a random one alike (D137)", async () => {
    const made = await createThing(t, ann, home, { name: 'Label me' });
    const code = made.shortCode as string;
    expect(ok(await get(ann, `/api/v1/codes/${code}`))).toEqual({ kind: 'thing', id: made.id });
    const typed = `${code.slice(0, 3).toLowerCase()}-${code.slice(3).toLowerCase()}`;
    expect(ok(await get(ann, `/api/v1/codes/${typed}`)).id).toBe(made.id);
    const theirs = await get(bob, `/api/v1/codes/${code}`);
    let random = randomShortCode();
    while (random === code) random = randomShortCode();
    const nowhere = await get(bob, `/api/v1/codes/${random}`);
    expect(theirs.statusCode).toBe(404);
    expect(theirs.json()).toEqual(nowhere.json());
    expect((await get(ann, '/api/v1/codes/not-a-code')).statusCode).toBe(404);
  });

  it("skips a code taken anywhere, another tenant's included, and never moves it", async () => {
    const bobThing = await createThing(t, bob, bobs, { name: 'Bob thing' });
    const taken = bobThing.shortCode as string;
    let fresh = randomShortCode();
    while (fresh === taken) fresh = randomShortCode();
    const codes = [taken, taken, fresh];
    const shelf = await place(db, home, 'Code shelf');
    const got = await withScope(db.pools.app, { userId: ann.userId, mfa: false }, (_tx, client) =>
      allocateShortId(client, home.id, { placeId: shelf }, () => codes.shift() as string),
    );
    expect(got).toBe(fresh);
    const rows = await own<{ location_id: string; thing_id: string }>(
      db,
      'SELECT location_id, thing_id FROM public.short_ids WHERE code = $1',
      [taken],
    );
    expect(rows).toEqual([{ location_id: bobs.id, thing_id: bobThing.id }]);
  });
});

describe('GET /api/v1/things (list-standard)', () => {
  let list: Loc;
  const names = ['delta', 'Alpha', 'charlie', 'echo', 'bravo', 'golf', 'foxtrot'];

  beforeAll(async () => {
    list = await createLocation(t, db, ann, 'complete', 'List home');
    const box = await builtinType(db, 'box_bin');
    const cable = await builtinType(db, 'cable');
    for (const [i, name] of names.entries()) {
      await createThing(t, ann, list, { name, typeId: i % 2 === 0 ? cable : box });
    }
  });

  const pages = async (as: Person, params: string) => {
    const seen: Json[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const res = ok(
        await get(
          as,
          `/api/v1/things?locationId=${list.id}&limit=3&${params}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        ),
      );
      seen.push(...(res.items as Json[]));
      cursor = res.next_cursor as string | null;
      if (!cursor) break;
    }
    return seen;
  };

  it('sorts by name with ICU collation, A to Z, the same across pages', async () => {
    const all = await pages(ann, 'sort=name');
    expect(all.map((x) => x.name)).toEqual([
      'Alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'foxtrot',
      'golf',
    ]);
  });

  it('groups by type first, stable across pages, and pages agree with one big page', async () => {
    const paged = await pages(ann, 'group=type&sort=name');
    const one = ok(
      await get(ann, `/api/v1/things?locationId=${list.id}&limit=200&group=type&sort=name`),
    );
    expect(paged.map((x) => x.id)).toEqual((one.items as Json[]).map((x) => x.id));
    expect(new Set(paged.map((x) => x.id)).size).toBe(names.length);
    const keys = paged.map((x) => (x.type as { builtinKey: string }).builtinKey);
    const firstOther = keys.findIndex((k) => k !== keys[0]);
    expect(keys.slice(firstOther).every((k) => k !== keys[0])).toBe(true);
  });

  it('sorts by updated and last seen, newest first, stable across pages', async () => {
    const updated = await pages(ann, 'sort=updated');
    expect(updated.map((x) => x.name)).toEqual([...names].reverse());
    const seen = await pages(ann, 'sort=lastSeen&group=place');
    expect(new Set(seen.map((x) => x.id)).size).toBe(names.length);
  });

  it('turns any sort around with dir (D211), the same across pages', async () => {
    const zToA = await pages(ann, 'sort=name&dir=desc');
    expect(zToA.map((x) => x.name)).toEqual([
      'golf',
      'foxtrot',
      'echo',
      'delta',
      'charlie',
      'bravo',
      'Alpha',
    ]);
    expect((await pages(ann, 'sort=name&dir=asc')).map((x) => x.name)[0]).toBe('Alpha');
    const oldest = await pages(ann, 'sort=updated&dir=asc');
    expect(oldest.map((x) => x.name)).toEqual(names);
    const grouped = await pages(ann, 'group=type&sort=name&dir=desc');
    const one = ok(
      await get(
        ann,
        `/api/v1/things?locationId=${list.id}&limit=200&group=type&sort=name&dir=desc`,
      ),
    );
    expect(grouped.map((x) => x.id)).toEqual((one.items as Json[]).map((x) => x.id));
    expect((await get(ann, `/api/v1/things?locationId=${list.id}&dir=up`)).statusCode).toBe(400);
  });

  it('filters: container, q, type, state and lifecycle; a viewer sees the same; an outsider 404', async () => {
    const containers = ok(
      await get(ann, `/api/v1/things?locationId=${list.id}&container=1&limit=50`),
    );
    expect((containers.items as Json[]).map((x) => x.name).sort()).toEqual([
      'Alpha',
      'echo',
      'golf',
    ]);
    expect((containers.items as Json[]).every((x) => x.isContainer)).toBe(true);
    const q = ok(await get(ann, `/api/v1/things?locationId=${list.id}&q=char`));
    expect((q.items as Json[]).map((x) => x.name)).toEqual(['charlie']);
    // A location filter the caller can't see is a 404, as /search, /trash and /activity answer
    // it (review #36; D205 made the filter a list, each id checked).
    const outsider = await get(bob, `/api/v1/things?locationId=${list.id}`);
    expect(outsider.statusCode).toBe(404);
    const viewer = ok(await get(vic, `/api/v1/things?locationId=${home.id}&limit=5`));
    expect((viewer.items as Json[]).length).toBeGreaterThan(0);
    const ended = ok(await get(ann, `/api/v1/things?locationId=${list.id}&state=ended`));
    expect(ended.items).toEqual([]);
    const bad = await get(ann, '/api/v1/things?cursor=nonsense');
    expect(bad.statusCode).toBe(400);
  });

  it('filters by brand, person, tag and vendor (T28)', async () => {
    const [brand] = await own<{ id: string }>(
      db,
      `INSERT INTO public.brands (owner_account_id, name) VALUES ($1, 'Bosch') RETURNING id`,
      [list.accountId],
    );
    const [who] = await own<{ id: string }>(
      db,
      `INSERT INTO public.people (owner_account_id, display_name) VALUES ($1, 'Ibrahim') RETURNING id`,
      [list.accountId],
    );
    const [vendor] = await own<{ id: string }>(
      db,
      `INSERT INTO public.vendors (owner_account_id, name, kind) VALUES ($1, 'Carrefour', 'store')
       RETURNING id`,
      [list.accountId],
    );
    const drill = await createThing(t, ann, list, {
      name: 'Drill',
      brandId: brand?.id,
      belongsToPersonId: who?.id,
      purchase: { purchasedOn: '2026-02-02', vendorId: vendor?.id, currency: 'EGP', price: '900' },
    });
    for (const param of [
      `brandId=${brand?.id}`,
      `belongsToId=${who?.id}`,
      `vendorId=${vendor?.id}`,
    ]) {
      const res = ok(await get(ann, `/api/v1/things?${param}`));
      expect(
        (res.items as Json[]).map((x) => x.id),
        param,
      ).toEqual([drill.id]);
    }
  });
  it('takes several types, brands and owners, and "is none of" each (D205)', async () => {
    const multi = await createLocation(t, db, ann, 'complete', 'Multi home');
    const [bosch, makita] = await own<{ id: string }>(
      db,
      `INSERT INTO public.brands (owner_account_id, name)
       VALUES ($1, 'Bosch D205'), ($1, 'Makita D205') RETURNING id`,
      [multi.accountId],
    );
    const [ibrahim, bruce] = await own<{ id: string }>(
      db,
      `INSERT INTO public.people (owner_account_id, display_name)
       VALUES ($1, 'Ibrahim D205'), ($1, 'Bruce D205') RETURNING id`,
      [multi.accountId],
    );
    const box = await builtinType(db, 'box_bin');
    const cable = await builtinType(db, 'cable');
    await createThing(t, ann, multi, {
      name: 'Anvil',
      typeId: cable,
      brandId: bosch?.id,
      belongsToPersonId: ibrahim?.id,
    });
    await createThing(t, ann, multi, { name: 'Bucket', typeId: box, brandId: makita?.id });
    await createThing(t, ann, multi, { name: 'Candle', belongsToPersonId: bruce?.id });
    await createThing(t, ann, multi, { name: 'Dowel', typeId: cable });
    const by = async (qs: string) =>
      ((ok(await get(ann, `/api/v1/things?locationId=${multi.id}&${qs}`)).items as Json[]) ?? [])
        .map((x) => x.name)
        .sort();

    expect(await by(`brandId=${bosch?.id}&brandId=${makita?.id}`)).toEqual(['Anvil', 'Bucket']);
    expect(await by(`brandId=${bosch?.id}&not=brandId`)).toEqual(['Bucket', 'Candle', 'Dowel']);
    expect(await by(`belongsToId=${ibrahim?.id}&belongsToId=${bruce?.id}`)).toEqual([
      'Anvil',
      'Candle',
    ]);
    expect(await by(`belongsToId=${ibrahim?.id}&not=belongsToId`)).toEqual([
      'Bucket',
      'Candle',
      'Dowel',
    ]);
    expect(await by(`typeId=${cable}&typeId=${box}`)).toEqual(['Anvil', 'Bucket', 'Dowel']);
    // None of a type: the untyped count.
    expect(await by(`typeId=${cable}&not=typeId`)).toEqual(['Bucket', 'Candle']);
    // Two locations, and none of one.
    const two = ok(
      await get(ann, `/api/v1/things?locationId=${multi.id}&locationId=${list.id}&limit=50`),
    );
    expect((two.items as Json[]).length).toBeGreaterThan(4);
    const notList = ok(
      await get(ann, `/api/v1/things?locationId=${list.id}&not=locationId&brandId=${makita?.id}`),
    );
    expect((notList.items as Json[]).map((x) => x.name)).toEqual(['Bucket']);
    expect((await get(ann, '/api/v1/things?not=vendorId')).statusCode).toBe(400);
  });
});

describe('route security review (step 2): things', () => {
  it('classes arrays of money-shaped values as money (audit images)', () => {
    const money = { amount: '5', currency: 'EGP' };
    expect(moneyShaped(money)).toBe(true);
    expect(moneyShaped([money])).toBe(true);
    expect(moneyShaped(['a', money])).toBe(true);
    expect(moneyShaped(['a', 'b'])).toBe(false);
    expect(moneyShaped([])).toBe(false);
    expect(moneyShapedClasses({ 'archived_custom.quotes': [money], 'custom.n': ['x'] })).toEqual({
      'archived_custom.quotes': 'money',
    });
  });

  // catalogue: POST /api/v1/things/:id/retype
  it('re-types a value only into a field of the same kind; money never becomes text', async () => {
    const [x] = await own<{ id: string }>(
      db,
      `INSERT INTO public.types (owner_account_id, name, icon, capabilities)
       VALUES ($1, 'Review coin', 'lucide:gem', '{}') RETURNING id`,
      [home.accountId],
    );
    const [y] = await own<{ id: string }>(
      db,
      `INSERT INTO public.types (owner_account_id, name, icon, capabilities)
       VALUES ($1, 'Review note', 'lucide:gem', '{}') RETURNING id`,
      [home.accountId],
    );
    await own(
      db,
      `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind)
       VALUES ($1, $2, 'worth', 'Worth', 'money'), ($1, $3, 'worth', 'Worth', 'text')`,
      [home.accountId, x?.id, y?.id],
    );
    const made = await createThing(t, ann, home, {
      name: 'Dinar',
      typeId: x?.id,
      custom: { worth: { amount: '40', currency: 'EGP' } },
    });
    const view = ok(
      await call(t, `/api/v1/things/${made.id}/retype`, {
        as: ann,
        headers: { 'if-match': String(made.rowVersion) },
        body: { typeId: y?.id },
      }),
    );
    expect(view.custom).toEqual({});
    expect(view.archivedCustom).toEqual({ worth: { amount: '40', currency: 'EGP' } });
    const asViewer = await thingOf(vic, made.id);
    expect(asViewer.custom).toEqual({});
    expect(asViewer.archivedCustom).toEqual({});
    expect(JSON.stringify(asViewer)).not.toContain('"40"');
    const retypeAudit = (await eventsOf(db, home.id, made.id)).at(-1);
    expect(retypeAudit?.diff['archived_custom.worth']?.class).toBe('money');

    // Back to the money type: the archived value returns into the money field.
    const back = ok(
      await call(t, `/api/v1/things/${made.id}/retype`, {
        as: ann,
        headers: { 'if-match': String(view.rowVersion) },
        body: { typeId: x?.id },
      }),
    );
    expect(back.custom).toEqual({ worth: { amount: '40', currency: 'EGP' } });
    expect(back.archivedCustom).toEqual({});
  });

  it('hides an archived array of money values from a viewer', async () => {
    const made = await createThing(t, ann, home, { name: 'Old quote holder' });
    await own(
      db,
      `UPDATE public.things
          SET archived_custom = '{"quotes":[{"amount":"9","currency":"EGP"}],"note":["x"]}'
        WHERE id = $1`,
      [made.id],
    );
    expect((await thingOf(ann, made.id)).archivedCustom).toEqual({
      quotes: [{ amount: '9', currency: 'EGP' }],
      note: ['x'],
    });
    expect((await thingOf(vic, made.id)).archivedCustom).toEqual({ note: ['x'] });
  });

  // catalogue: PATCH /api/v1/things/:id
  it('bumps row_version on a tags-only PATCH, so a stale If-Match after it is 412', async () => {
    const [tag] = await own<{ id: string }>(
      db,
      `INSERT INTO public.tags (owner_account_id, name) VALUES ($1, 'review tag') RETURNING id`,
      [home.accountId],
    );
    const made = await createThing(t, ann, home, { name: 'Tagged lamp' });
    const tagged = ok(
      await call(t, `/api/v1/things/${made.id}`, {
        method: 'PATCH',
        as: mo,
        headers: { 'if-match': String(made.rowVersion) },
        body: { tagIds: [tag?.id] },
      }),
    );
    expect(tagged.rowVersion).toBe((made.rowVersion as number) + 1);
    const audit = await eventsOf(db, home.id, made.id);
    expect(audit.at(-1)?.diff.tag_ids).toMatchObject({ before: [], after: [tag?.id] });
    const stale = await call(t, `/api/v1/things/${made.id}`, {
      method: 'PATCH',
      as: ann,
      headers: { 'if-match': String(made.rowVersion) },
      body: { name: 'Lamp' },
    });
    expect(stale.statusCode).toBe(412);
  });

  // catalogue: POST /api/v1/things/:id/not-here
  it('takes an optional If-Match on not-here: a stale one is 412', async () => {
    const made = await createThing(t, ann, home, { name: 'Umbrella' });
    const url = `/api/v1/things/${made.id}/not-here`;
    const stale = await call(t, url, {
      as: mo,
      headers: { 'if-match': String((made.rowVersion as number) + 3) },
      body: {},
    });
    expect(stale.statusCode, stale.body).toBe(412);
    ok(await call(t, url, { as: mo, headers: { 'if-match': String(made.rowVersion) }, body: {} }));
    const audit = await eventsOf(db, home.id, made.id);
    expect(audit.at(-1)?.action).toBe('thing.not_here');
  });

  // catalogue: POST /api/v1/things/:id/duplicate
  it('duplicates without the money its caller can’t see', async () => {
    const [row] = await own<{ id: string }>(
      db,
      `INSERT INTO public.things (location_id, place_id, name, type_id, custom, archived_custom)
       VALUES ($1, $2, 'Heirloom', $3,
               '{"edition":"1/1","maker":"Anon","appraised":{"amount":"900","currency":"EGP"}}',
               '{"old":[{"amount":"1","currency":"EGP"}],"kept":"yes"}')
       RETURNING id`,
      [basic.id, basic.unplacedId, collectible],
    );
    const copy = ok(
      await call(t, `/api/v1/things/${row?.id}/duplicate`, { as: mo, body: {} }),
      201,
    );
    const [stored] = await own<{ custom: object; archived_custom: object }>(
      db,
      'SELECT custom, archived_custom FROM public.things WHERE id = $1',
      [copy.id],
    );
    expect(stored?.custom).toEqual({ edition: '1/1', maker: 'Anon' });
    expect(stored?.archived_custom).toEqual({ kept: 'yes' });
    const audit = await eventsOf(db, basic.id, copy.id);
    expect(audit.map((e) => e.action)).toEqual(['thing.create']);
  });

  it('refuses to clear an end price its caller can’t see (409 module_off)', async () => {
    const [row] = await own<{ id: string }>(
      db,
      `INSERT INTO public.things (location_id, place_id, name, lifecycle, ended_on, ended_price,
                                  ended_currency)
       VALUES ($1, $2, 'Sold chair', 'sold', '2026-09-01', 10, 'EGP') RETURNING id`,
      [basic.id, basic.unplacedId],
    );
    const seen = await thingOf(mo, row?.id as string);
    const res = await call(t, `/api/v1/things/${row?.id}/lifecycle`, {
      as: mo,
      headers: { 'if-match': String(seen.rowVersion) },
      body: { lifecycle: 'in_use' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().code).toBe('module_off');
    const [after] = await own<{ lifecycle: string; ended_price: string }>(
      db,
      'SELECT lifecycle, ended_price::text AS ended_price FROM public.things WHERE id = $1',
      [row?.id],
    );
    expect(after).toEqual({ lifecycle: 'sold', ended_price: '10.0000' });
  });

  // catalogue: POST /api/v1/things/:id/convert-to-place
  it('converts to a place only for owners and admins, with If-Match, auditing the place and its contents', async () => {
    const crate = await createThing(t, ann, home, { name: 'Review crate' });
    const apple = await createThing(t, ann, home, { name: 'Review apple', containerId: crate.id });
    const url = `/api/v1/things/${crate.id}/convert-to-place`;
    const byMember = await call(t, url, {
      as: mo,
      headers: { 'if-match': String(crate.rowVersion) },
      body: {},
    });
    expect(byMember.statusCode).toBe(403);
    expect((await call(t, url, { as: ann, body: {} })).statusCode).toBe(428);
    const stale = await call(t, url, {
      as: ann,
      headers: { 'if-match': String((crate.rowVersion as number) + 2) },
      body: {},
    });
    expect(stale.statusCode).toBe(412);
    ok(
      await call(t, url, { as: ann, headers: { 'if-match': String(crate.rowVersion) }, body: {} }),
    );
    const created = (await eventsOf(db, home.id, crate.id)).filter(
      (e) => e.action === 'place.create',
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.diff).toMatchObject({
      name: { after: 'Review crate' },
      converted_from: { after: 'thing' },
    });
    const appleMove = (await eventsOf(db, home.id, apple.id)).at(-1);
    expect(appleMove).toMatchObject({ action: 'thing.move', undoable_until: null });
    expect(appleMove?.diff).toMatchObject({
      container_id: { before: crate.id, after: null },
      place_id: { before: null, after: crate.id },
    });
  });

  it('refuses to convert what would lose its record (409 with what), unless told to discard it', async () => {
    const [tag] = await own<{ id: string }>(
      db,
      `INSERT INTO public.tags (owner_account_id, name) VALUES ($1, 'convert tag') RETURNING id`,
      [home.accountId],
    );
    const safe = await createThing(t, ann, home, {
      name: 'Review cabinet',
      serial: 'CAB-1',
      tagIds: [tag?.id],
      purchase: { purchasedOn: '2026-01-01', currency: 'EGP', price: '10' },
    });
    const url = `/api/v1/things/${safe.id}/convert-to-place`;
    const headers = { 'if-match': String(safe.rowVersion) };
    const refused = await call(t, url, { as: ann, headers, body: {} });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'conflict', reason: 'discards' });
    expect(refused.json().discards).toEqual(['purchase', 'serial', 'tags']);
    expect((await thingOf(ann, safe.id)).id).toBe(safe.id);
    const done = ok(await call(t, url, { as: ann, headers, body: { discard: true } }));
    expect(done.placeId).toBe(safe.id);
    const converted = (await eventsOf(db, home.id, safe.id)).find(
      (e) => e.action === 'thing.convert_to_place',
    );
    expect(converted?.diff).toMatchObject({ discarded: { after: ['purchase', 'serial', 'tags'] } });
  });
});
