import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import {
  act,
  attachment,
  draft,
  draftPurchase,
  extraction,
  type InboxPageJson,
  inbox,
  inboxItem,
  itemRow,
} from '../../test/inbox.js';
import { auditOf, call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  createLocation,
  createThing,
  eventsOf,
  type Json,
  type Loc,
  ok,
  own,
  place,
} from '../../test/things.js';
import { AUDIT_EVENT_HEADER } from '../http/write.js';

// T15: the review inbox through the front door, in the web contract's shapes
// (apps/web/src/api/capture/types.ts "inbox (T15)").

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of Home
let louis: Person; // member of Home
let talia: Person; // viewer of Home
let bruce: Person; // another household: his own Garage
let home: Loc;
let garage: Loc;

const page = async (as: Person, query = '') =>
  ok(await inbox(t, as, query)) as unknown as InboxPageJson;

const actions = async (loc: Loc, action: string) =>
  (await auditOf(db, loc.id)).filter((e) => e.action === action);

const thingOf = async (id: string) =>
  (
    await own<{
      name: string | null;
      serial: string | null;
      quantity: string;
      review_state: string;
      field_status: Record<string, { state: string }>;
      deleted_at: Date | null;
      merged_into_id: string | null;
      place_id: string | null;
      purchase_line_id: string | null;
    }>(
      db,
      `SELECT name, serial, quantity::text AS quantity, review_state, field_status, deleted_at,
              merged_into_id, place_id, purchase_line_id
         FROM public.things WHERE id = $1`,
      [id],
    )
  )[0];

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  bruce = await person(t, db, 'bruce');
  home = await createLocation(t, db, ibrahim, 'household');
  garage = await createLocation(t, db, bruce, 'household', 'Garage');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
});

afterAll(async () => {
  await t.app.close();
});

describe('GET /api/v1/inbox', () => {
  it('lists "Mine" by default, everyone\'s on request, with chip counts, grouped by batch', async () => {
    const hour = 3600_000;
    const older = await draft(t, db, ibrahim, home, {
      name: 'Hammer',
      createdAt: new Date(Date.now() - 3 * hour),
    });
    const newer = await draft(t, db, ibrahim, home, {
      name: 'Level',
      createdAt: new Date(Date.now() - 2 * hour),
    });
    const sameBatch = await draft(t, db, ibrahim, home, {
      name: 'Tape measure',
      batchId: older.batchId,
      createdAt: new Date(Date.now() - hour),
    });
    const hers = await draft(t, db, louis, home, { name: 'Router' });

    const mine = await page(ibrahim, `locationId=${home.id}`);
    // Newest batch first; within the older batch, newest item first.
    expect(mine.items.map((i) => i.id)).toEqual([newer.itemId, sameBatch.itemId, older.itemId]);
    expect(mine.items[1]?.batch).toMatchObject({ id: older.batchId, count: 2 });
    expect(mine.counts).toMatchObject({ mine: 3, everyone: 4 });
    expect(mine.counts.byKind).toMatchObject({ draft: 3, receipt: 0, reading: 0 });

    const everyone = await page(ibrahim, `locationId=${home.id}&mine=0`);
    expect(everyone.items.map((i) => i.id)).toContain(hers.itemId);
    expect(everyone.counts.byKind.draft).toBe(4);

    // A member reviews too: their own by default, everyone's on request.
    const his = await page(louis, `locationId=${home.id}`);
    expect(his.items.map((i) => i.id)).toEqual([hers.itemId]);
    expect((await page(louis, `locationId=${home.id}&mine=false`)).items).toHaveLength(4);

    // The shape the web reads.
    const item = mine.items[0];
    expect(item).toMatchObject({
      kind: 'draft',
      locationId: home.id,
      rowVersion: 1,
      createdBy: { displayName: expect.any(String) },
      thing: {
        id: newer.thingId,
        name: 'Level',
        brand: null,
        fieldStatus: { name: { state: 'extracted', confidence: 0.9 } },
        photos: [],
      },
      suggestions: [],
    });
  });

  it('refuses a viewer (403), answers an invisible location like a random one (404)', async () => {
    expect((await inbox(t, talia, `locationId=${home.id}`)).statusCode).toBe(403);
    // Talia's own Personal location is hers to review: the global list is empty, not refused.
    const global = await page(talia);
    expect(global.items).toEqual([]);
    const hidden = await inbox(t, ibrahim, `locationId=${garage.id}`);
    const random = await inbox(t, ibrahim, `locationId=${newId()}`);
    expect(hidden.statusCode).toBe(404);
    expect({ s: hidden.statusCode, b: hidden.json() }).toEqual({
      s: random.statusCode,
      b: random.json(),
    });
  });

  it('filters by kind, batch and q without changing the counts, and hides trashed drafts', async () => {
    const loc = await createLocation(t, db, ibrahim, 'household', 'Filters');
    const shelf = await place(db, loc, 'Pantry shelf');
    const a = await draft(t, db, ibrahim, loc, { name: 'Espresso machine' });
    const b = await draft(t, db, ibrahim, loc, {
      name: 'Kettle',
      body: { placeId: shelf },
    });
    const claim = await inboxItem(db, loc, ibrahim, {
      kind: 'label_claim',
      thingId: a.thingId,
      code: 'K7M2Q9',
      payload: { claimedFor: { kind: 'thing', id: b.thingId, name: 'Kettle' } },
    });
    const all = await page(ibrahim, `locationId=${loc.id}`);
    expect(all.counts.byKind).toMatchObject({ draft: 2, label_claim: 1 });

    const claims = await page(ibrahim, `locationId=${loc.id}&kind=label_claim`);
    expect(claims.items.map((i) => i.id)).toEqual([claim]);
    expect(claims.items[0]?.claim).toEqual({
      code: 'K7M2Q9',
      claimedFor: { kind: 'thing', id: b.thingId, name: 'Kettle' },
    });
    expect(claims.counts).toEqual(all.counts);

    expect((await page(ibrahim, `locationId=${loc.id}&batchId=${b.batchId}`)).items).toHaveLength(
      1,
    );
    // q: the name, and the place, normalised; the counts ignore it.
    const byName = await page(ibrahim, `locationId=${loc.id}&q=ESPRESSO`);
    expect(byName.items.map((i) => i.id).sort()).toEqual([a.itemId, claim].sort());
    expect(byName.counts).toEqual(all.counts);
    const byPlace = await page(ibrahim, `locationId=${loc.id}&q=pantry`);
    expect(byPlace.items.map((i) => i.id)).toEqual([b.itemId]);
    expect((await page(ibrahim, `locationId=${loc.id}&q=50%25_off`)).items).toEqual([]);

    // A draft in the trash (by hand, or "Undo this batch") takes its items out of sight.
    await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [a.thingId]);
    const after = await page(ibrahim, `locationId=${loc.id}`);
    expect(after.items.map((i) => i.id)).toEqual([b.itemId]);
    expect(after.counts.byKind).toMatchObject({ draft: 1, label_claim: 0 });
  });

  it('pages with a cursor', async () => {
    const loc = await createLocation(t, db, ibrahim, 'household', 'Paging');
    for (let i = 0; i < 3; i++) await draft(t, db, ibrahim, loc, { name: `Jar ${i}` });
    const first = await page(ibrahim, `locationId=${loc.id}&limit=2`);
    expect(first.items).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    const second = await page(ibrahim, `locationId=${loc.id}&limit=2&cursor=${first.next_cursor}`);
    expect(second.items).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
    const ids = [...first.items, ...second.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });
});

describe('POST /api/v1/inbox/:id/accept', () => {
  /** A draft AI named, with a serial and a quantity waiting. */
  async function suggested(loc: Loc = home) {
    const d = await draft(t, db, ibrahim, loc, { name: 'Cordless drill' });
    const att = await attachment(db, loc, ibrahim, { thingId: d.thingId });
    const ex = await extraction(db, loc, ibrahim, {
      attachmentId: att,
      thingId: d.thingId,
      mode: 'thing',
    });
    const source = { extractionId: ex, attachmentId: att };
    await own(db, 'UPDATE public.inbox_items SET payload = $2 WHERE id = $1', [
      d.itemId,
      JSON.stringify({
        extractionId: ex,
        suggestions: [
          { field: 'serial', value: 'SN-4471', confidence: 0.55, source },
          { field: 'quantity', value: '2', confidence: 0.7, source },
        ],
      }),
    ]);
    return { ...d, extractionId: ex };
  }

  // catalogue: POST /api/v1/inbox/:id/accept
  it('writes an accepted suggestion as confirmed, drops a rejected one, and confirms the draft', async () => {
    const d = await suggested();
    const listed = (await page(ibrahim, `locationId=${home.id}`)).items.find(
      (i) => i.id === d.itemId,
    );
    expect(listed?.suggestions?.map((s) => s.field)).toEqual(['serial', 'quantity']);
    expect(listed).toMatchObject({ extraction: { id: d.extractionId, status: 'succeeded' } });

    // The payload written after the insert moved the item to version 2.
    expect(listed?.rowVersion).toBe(2);
    const res = await act(
      t,
      ibrahim,
      d.itemId,
      'accept',
      { accept: ['serial'], reject: ['quantity'] },
      2,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await thingOf(d.thingId)).toMatchObject({
      serial: 'SN-4471',
      quantity: '1.000',
      review_state: 'confirmed',
      field_status: {
        name: { state: 'confirmed' },
        serial: { state: 'confirmed', extraction_id: d.extractionId },
      },
    });
    expect(await itemRow(db, d.itemId)).toMatchObject({
      resolution: 'accepted',
      resolved_by: ibrahim.userId,
      payload: { suggestions: [], decided: { accepted: ['serial'], rejected: ['quantity'] } },
    });
    // Audited: the edit (undoable, with the review state in it) and the resolution.
    const edits = await eventsOf(db, home.id, d.thingId);
    const update = edits.find((e) => e.action === 'thing.update');
    expect(update?.diff).toMatchObject({
      serial: { before: null, after: 'SN-4471' },
      review_state: { before: 'draft', after: 'confirmed' },
    });
    expect(update?.undoable_until).not.toBeNull();
    expect(res.headers[AUDIT_EVENT_HEADER]).toBe(update?.id);
    expect(await eventsOf(db, home.id, d.itemId)).toMatchObject([
      { action: 'inbox.resolve', diff: { resolution: { before: null, after: 'accepted' } } },
    ]);
    // Gone from the list.
    const after = await page(ibrahim, `locationId=${home.id}`);
    expect(after.items.some((i) => i.id === d.itemId)).toBe(false);
  });

  it('needs a name, If-Match, a current version and a suggestion that exists', async () => {
    const nameless = await draft(t, db, ibrahim, home, { name: null });
    expect((await act(t, ibrahim, nameless.itemId, 'accept', {})).statusCode).toBe(400);
    expect((await act(t, ibrahim, nameless.itemId, 'accept', {}, null)).statusCode).toBe(428);
    expect((await act(t, ibrahim, nameless.itemId, 'accept', {}, 7)).statusCode).toBe(412);
    expect(
      (await act(t, ibrahim, nameless.itemId, 'accept', { accept: ['warranty'] })).statusCode,
    ).toBe(400);
    // Typed by hand: the name is `manual`, and the item resolves `edited`.
    const res = await act(t, ibrahim, nameless.itemId, 'accept', { set: { name: 'Tile cutter' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(await thingOf(nameless.thingId)).toMatchObject({
      name: 'Tile cutter',
      review_state: 'confirmed',
      field_status: { name: { state: 'manual' } },
    });
    expect((await itemRow(db, nameless.itemId))?.resolution).toBe('edited');
    // Resolved: a second accept finds nothing.
    expect((await act(t, ibrahim, nameless.itemId, 'accept', {}, 2)).statusCode).toBe(404);
  });

  it('undoes an accept back to a draft', async () => {
    const d = await suggested();
    const res = await act(t, ibrahim, d.itemId, 'accept', { accept: ['serial'] }, 2);
    const eventId = String(res.headers[AUDIT_EVENT_HEADER]);
    ok(await call(t, `/api/v1/audit/${eventId}/undo`, { as: ibrahim, body: {} }));
    expect(await thingOf(d.thingId)).toMatchObject({ serial: null, review_state: 'draft' });
  });
});

describe('POST /api/v1/inbox/:id/discard', () => {
  // catalogue: POST /api/v1/inbox/:id/discard
  it('trashes the draft, answers its undo, and the undo brings the item back', async () => {
    const d = await draft(t, db, louis, home, { name: 'Broken lamp' });
    const res = await act(t, louis, d.itemId, 'discard', {});
    const body = ok(res) as Json & { undo: { eventId: string; until: string } };
    expect((await thingOf(d.thingId))?.deleted_at).not.toBeNull();
    const trash = (await eventsOf(db, home.id, d.thingId)).filter(
      (e) => e.action === 'thing.trash',
    );
    expect(trash).toHaveLength(1);
    expect(body.undo.eventId).toBe(trash[0]?.id);
    expect(res.headers[AUDIT_EVENT_HEADER]).toBe(trash[0]?.id);
    expect(await eventsOf(db, home.id, d.itemId)).toMatchObject([{ action: 'inbox.discard' }]);
    expect((await page(louis, `locationId=${home.id}`)).items.some((i) => i.id === d.itemId)).toBe(
      false,
    );
    ok(await call(t, `/api/v1/audit/${body.undo.eventId}/undo`, { as: louis, body: {} }));
    expect((await page(louis, `locationId=${home.id}`)).items.some((i) => i.id === d.itemId)).toBe(
      true,
    );
  });
});

describe('POST /api/v1/inbox/:id/dismiss', () => {
  // catalogue: POST /api/v1/inbox/:id/dismiss
  it('resolves a label claim as dismissed, audited; a draft is not dismissed', async () => {
    const box = await createThing(t, ibrahim, home, { name: 'Camping box' });
    const claim = await inboxItem(db, home, ibrahim, {
      kind: 'label_claim',
      thingId: box.id,
      code: 'Q3W4E5',
      payload: { claimedFor: { kind: 'thing', id: box.id, name: 'Camping box' } },
    });
    ok(await act(t, ibrahim, claim, 'dismiss', {}));
    expect((await itemRow(db, claim))?.resolution).toBe('dismissed');
    expect(await eventsOf(db, home.id, claim)).toMatchObject([
      { action: 'inbox.resolve', diff: { resolution: { after: 'dismissed' } } },
    ]);
    const d = await draft(t, db, ibrahim, home, { name: 'Mug' });
    expect((await act(t, ibrahim, d.itemId, 'dismiss', {})).statusCode).toBe(409);
  });
});

describe('duplicates', () => {
  // catalogue: POST /api/v1/inbox/:id/merge
  it('merges into the survivor either side names, keeping both histories and the old label', async () => {
    const survivor = await createThing(t, ibrahim, home, { name: 'Bosch drill', serial: 'B-77' });
    const dup = await draft(t, db, ibrahim, home, { name: 'Drill (photo)' });
    ok(
      await call(t, `/api/v1/things/${dup.thingId}`, {
        as: ibrahim,
        method: 'PATCH',
        body: { notes: 'from the garage shelf' },
        headers: { 'if-match': '2' },
      }),
    );
    const codes = await own<{ code: string }>(
      db,
      'SELECT code::text AS code FROM public.short_ids WHERE thing_id = $1 AND is_primary',
      [dup.thingId],
    );
    const item = await inboxItem(db, home, ibrahim, {
      kind: 'duplicate',
      thingId: dup.thingId,
      otherThingId: survivor.id,
      batchId: dup.batchId,
      payload: { reason: 'serial' },
    });
    const listed = (await page(ibrahim, `locationId=${home.id}&kind=duplicate`)).items;
    expect(listed.find((i) => i.id === item)?.duplicate).toMatchObject({
      other: { id: survivor.id },
      reason: 'serial',
    });
    // `into` must be one of the pair.
    expect((await act(t, ibrahim, item, 'merge', { into: newId() })).statusCode).toBe(404);

    ok(await act(t, ibrahim, item, 'merge', { into: survivor.id }));
    expect(await thingOf(dup.thingId)).toMatchObject({ merged_into_id: survivor.id });
    expect((await thingOf(dup.thingId))?.deleted_at).not.toBeNull();
    const merges = await eventsOf(db, home.id, dup.thingId);
    expect(merges.find((e) => e.action === 'thing.merge')?.diff).toMatchObject({
      merged_into_id: { before: null, after: survivor.id },
    });
    const subjects = await own<{ thing_id: string }>(
      db,
      `SELECT s.thing_id FROM public.audit_event_subjects s JOIN public.audit_events e
          ON e.id = s.event_id WHERE e.action = 'thing.merge' AND e.entity_id = $1`,
      [dup.thingId],
    );
    expect(subjects.map((s) => s.thing_id).sort()).toEqual([dup.thingId, survivor.id].sort());
    expect((await itemRow(db, item))?.resolution).toBe('merged');

    // The old label finds the survivor; its history carries the merged thing's, labelled.
    const found = ok(await call(t, `/api/v1/codes/${codes[0]?.code}`, { as: ibrahim }));
    expect(found).toMatchObject({ id: survivor.id });
    const history = ok(await call(t, `/api/v1/things/${survivor.id}/history`, { as: ibrahim }));
    const events = history.items as { action: string; mergedFrom?: { id: string } }[];
    expect(events.find((e) => e.action === 'thing.update')).toMatchObject({
      mergedFrom: { id: dup.thingId },
    });
    expect(events.find((e) => e.action === 'thing.create' && !e.mergedFrom)).toBeDefined();
  });

  // catalogue: POST /api/v1/inbox/:id/not-duplicate
  it('says two things are different (not-duplicate), audited', async () => {
    const a = await createThing(t, ibrahim, home, { name: 'HDMI cable' });
    const b = await createThing(t, ibrahim, home, { name: 'HDMI cable' });
    const item = await inboxItem(db, home, ibrahim, {
      kind: 'duplicate',
      thingId: a.id,
      otherThingId: b.id,
      payload: { reason: 'brand_model_place' },
    });
    ok(await act(t, ibrahim, item, 'not-duplicate', {}));
    expect((await itemRow(db, item))?.resolution).toBe('dismissed');
    expect(await eventsOf(db, home.id, item)).toMatchObject([
      { action: 'inbox.resolve', diff: { resolution: { after: 'dismissed' } } },
    ]);
    expect((await thingOf(a.id))?.deleted_at).toBeNull();
    expect((await thingOf(b.id))?.deleted_at).toBeNull();
  });
});

describe('receipts', () => {
  async function receipt(loc: Loc, lines: Parameters<typeof draftPurchase>[2], money = {}) {
    const purchaseId = await draftPurchase(db, loc, lines, money);
    const att = await attachment(db, loc, ibrahim, { purchaseId }, 'receipt');
    const ex = await extraction(
      db,
      loc,
      ibrahim,
      { attachmentId: att, purchaseId, mode: 'receipt' },
      {
        mode: 'receipt',
        fields: { total: { value: 312.5, confidence: 0.9 }, lines: [] },
      },
    );
    const batchId = newId();
    const itemId = await inboxItem(db, loc, ibrahim, {
      kind: 'receipt',
      purchaseId,
      extractionId: ex,
      batchId,
      payload: { vendorSeen: 'ACE HARDWARE', flagged: false, currencySeen: '$', extractionId: ex },
    });
    return { purchaseId, itemId, extractionId: ex, batchId };
  }

  it('ranks candidates for a line: brand and model first, then by name', async () => {
    const brand = (
      await own<{ id: string }>(
        db,
        `INSERT INTO public.brands (owner_account_id, name) VALUES ($1, 'Bosch') RETURNING id`,
        [home.accountId],
      )
    )[0]?.id as string;
    const exact = await createThing(t, ibrahim, home, {
      name: 'Impact driver',
      brandId: brand,
      model: 'GDR 18V',
    });
    const byName = await createThing(t, ibrahim, home, { name: 'Driver bits' });
    const r = await receipt(home, [
      { description: 'BOSCH GDR 18V impact driver' },
      { description: 'Garden hose 20m' },
    ]);
    const res = ok(await call(t, `/api/v1/inbox/${r.itemId}/candidates?line=0`, { as: ibrahim }));
    const things = res.things as { id: string; match: string }[];
    expect(things[0]).toMatchObject({ id: exact.id, match: 'brand_model' });
    expect(things.find((x) => x.id === byName.id)).toMatchObject({ match: 'name' });
    const none = ok(await call(t, `/api/v1/inbox/${r.itemId}/candidates?line=1`, { as: ibrahim }));
    expect((none.things as { id: string }[]).some((x) => x.id === exact.id)).toBe(false);
    expect(
      (await call(t, `/api/v1/inbox/${r.itemId}/candidates?line=9`, { as: ibrahim })).statusCode,
    ).toBe(400);
  });

  // catalogue: POST /api/v1/inbox/:id/receipt
  it('confirms a receipt: one new thing, one linked, one skipped, the vendor made inline', async () => {
    const linked = await createThing(t, ibrahim, home, { name: 'Extension cord' });
    const r = await receipt(
      home,
      [
        { description: 'Work lamp' },
        { description: 'Extension cord 5m' },
        { description: 'Carrier bag' },
      ],
      { currency: 'EGP' },
    );
    const listed = (await page(ibrahim, `locationId=${home.id}&kind=receipt`)).items.find(
      (i) => i.id === r.itemId,
    );
    expect(listed?.receipt).toMatchObject({
      purchaseId: r.purchaseId,
      vendorSeen: 'ACE HARDWARE',
      currency: 'EGP',
      total: '312.5',
      flagged: false,
      lines: [
        { index: 0, description: 'Work lamp', quantity: '1' },
        { index: 1, description: 'Extension cord 5m' },
        { index: 2, description: 'Carrier bag' },
      ],
    });
    expect(listed?.receipt?.moneyHidden).toBeUndefined();

    const res = await act(t, ibrahim, r.itemId, 'receipt', {
      vendor: { name: 'Ace Hardware' },
      purchasedOn: '2026-09-20',
      currency: 'EGP',
      total: '312.5',
      lines: [
        {
          index: 0,
          description: 'Work lamp',
          quantity: '1',
          unitPrice: '250',
          action: 'new_thing',
        },
        {
          index: 1,
          description: 'Extension cord 5m',
          quantity: '1',
          unitPrice: '60',
          action: 'link',
          thingId: linked.id,
        },
        { index: 2, description: 'Carrier bag', quantity: '1', unitPrice: '2.5', action: 'skip' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    const [p] = await own<{
      review_state: string;
      vendor: string;
      purchased_on: string;
      total: string;
    }>(
      db,
      `SELECT p.review_state, v.name AS vendor, p.purchased_on::text AS purchased_on,
              p.total::text AS total
         FROM public.purchases p JOIN public.vendors v ON v.id = p.vendor_id WHERE p.id = $1`,
      [r.purchaseId],
    );
    expect(p).toMatchObject({
      review_state: 'confirmed',
      vendor: 'Ace Hardware',
      purchased_on: '2026-09-20',
    });
    const lines = await own<{
      id: string;
      description: string;
      unit_price: string | null;
      things: string[] | null;
    }>(
      db,
      `SELECT pl.id, pl.description, trim_scale(pl.unit_price)::text AS unit_price,
              (SELECT array_agg(t.id) FROM public.things t WHERE t.purchase_line_id = pl.id) AS things
         FROM public.purchase_lines pl WHERE pl.purchase_id = $1 ORDER BY pl.sort`,
      [r.purchaseId],
    );
    expect(lines.map((l) => l.unit_price)).toEqual(['250', '60', '2.5']);
    const made = lines[0]?.things?.[0] as string;
    expect(await thingOf(made)).toMatchObject({ name: 'Work lamp', review_state: 'draft' });
    expect(lines[1]?.things).toEqual([linked.id]);
    expect(lines[2]?.things).toBeNull();
    // The new draft waits in the inbox, in the receipt's batch.
    const drafts = await page(ibrahim, `locationId=${home.id}&batchId=${r.batchId}`);
    expect(drafts.items.map((i) => i.thing?.id)).toEqual([made]);
    // Audited: the vendor, the purchase and its links, the confirmation, the resolution.
    const done = (await auditOf(db, home.id)).map((e) => e.action);
    expect(done).toEqual(
      expect.arrayContaining(['purchase.update', 'purchase.confirm', 'thing.purchase_link']),
    );
    expect((await actions(home, 'purchase.confirm')).at(-1)?.diff).toMatchObject({
      review_state: { before: 'draft', after: 'confirmed' },
    });
    expect((await itemRow(db, r.itemId))?.resolution).toBe('linked');
  });

  it("hides a receipt's money from a member where the money module is off", async () => {
    const ess = await createLocation(t, db, ibrahim, 'essentials', 'Cabin');
    await join(db, ess.id, louis.userId, 'member');
    const r = await receipt(ess, [{ description: 'Lantern', unitPrice: '99' }], {
      currency: 'EGP',
      total: '99',
    });
    const item = (await page(louis, `locationId=${ess.id}&mine=0`)).items.find(
      (i) => i.id === r.itemId,
    );
    expect(item?.receipt).toMatchObject({
      moneyHidden: true,
      pages: [],
      lines: [{ description: 'Lantern' }],
    });
    expect(item?.receipt?.total).toBeUndefined();
    expect(item?.receipt?.lines[0]?.unitPrice).toBeUndefined();
  });

  // catalogue: POST /api/v1/inbox/:id/currency
  it('answers the currency question: the purchase gets it, and the amounts that waited', async () => {
    const r = await receipt(home, [{ description: 'Paint' }]);
    const q = await inboxItem(db, home, ibrahim, {
      kind: 'currency',
      purchaseId: r.purchaseId,
      extractionId: r.extractionId,
      payload: { seen: '$', options: ['USD', 'CAD'], extractionId: r.extractionId },
    });
    const listed = (await page(ibrahim, `locationId=${home.id}&kind=currency`)).items.find(
      (i) => i.id === q,
    );
    expect(listed?.currency).toEqual({ seen: '$', options: ['USD', 'CAD'] });
    expect((await act(t, ibrahim, q, 'currency', { currency: '$' })).statusCode).toBe(400);
    ok(await act(t, ibrahim, q, 'currency', { currency: 'USD' }));
    const [p] = await own<{ currency: string; total: string }>(
      db,
      'SELECT currency::text AS currency, trim_scale(total)::text AS total FROM public.purchases WHERE id = $1',
      [r.purchaseId],
    );
    expect(p).toEqual({ currency: 'USD', total: '312.5' });
    expect((await eventsOf(db, home.id, r.purchaseId)).map((e) => e.action)).toContain(
      'purchase.update',
    );
    expect((await itemRow(db, q))?.resolution).toBe('accepted');
  });

  // Found in the step-3 e2e: on a real server the item was titled just "Receipt", with no shop,
  // total or photo, because only receipt items carried the purchase summary.
  it("gives the currency question the receipt's shop, total and pages, money behind the gate", async () => {
    const r = await receipt(home, [{ description: 'Paint' }]);
    await own(
      db,
      `UPDATE public.extractions
          SET result = jsonb_set(result, '{fields,vendor}',
                                 '{"name": {"value": "ACE HARDWARE", "confidence": 0.9}}')
        WHERE id = $1`,
      [r.extractionId],
    );
    const q = await inboxItem(db, home, ibrahim, {
      kind: 'currency',
      purchaseId: r.purchaseId,
      extractionId: r.extractionId,
      payload: { seen: '$', options: ['USD', 'CAD'] },
    });
    const listed = (await page(ibrahim, `locationId=${home.id}&kind=currency`)).items.find(
      (i) => i.id === q,
    );
    expect(listed?.receipt).toMatchObject({
      purchaseId: r.purchaseId,
      vendorSeen: 'ACE HARDWARE',
      total: '312.5',
      lines: [{ index: 0, description: 'Paint' }],
    });
    expect(listed?.receipt?.pages).toHaveLength(1);
    expect(listed?.receipt?.moneyHidden).toBeUndefined();

    // Where the money module is off, a member sees the shop, but no total and no pages.
    const ess = await createLocation(t, db, ibrahim, 'essentials', 'Shed');
    await join(db, ess.id, louis.userId, 'member');
    const hidden = await receipt(ess, [{ description: 'Rope' }]);
    const hq = await inboxItem(db, ess, ibrahim, {
      kind: 'currency',
      purchaseId: hidden.purchaseId,
      extractionId: hidden.extractionId,
      payload: { seen: '$', options: ['USD', 'CAD'] },
    });
    const seen = (await page(louis, `locationId=${ess.id}&mine=0`)).items.find((i) => i.id === hq);
    expect(seen?.receipt).toMatchObject({
      purchaseId: hidden.purchaseId,
      moneyHidden: true,
      pages: [],
    });
    expect(seen?.receipt?.total).toBeUndefined();
    expect(seen?.currency).toEqual({ seen: '$', options: ['USD', 'CAD'] });
  });
});

describe('POST /api/v1/inbox/:id/reading', () => {
  let meter: string;
  let car: string;
  const day = 86_400_000;

  beforeAll(async () => {
    car = (await createThing(t, ibrahim, home, { name: 'Family car' })).id;
    meter = (
      await own<{ id: string }>(
        db,
        `INSERT INTO public.meters (location_id, thing_id, kind, unit) VALUES ($1, $2, 'distance', 'km')
         RETURNING id`,
        [home.id, car],
      )
    )[0]?.id as string;
    await own(
      db,
      `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, logged_by)
       VALUES ($1, $2, 53100, $3, $4)`,
      [home.id, meter, new Date(Date.now() - 30 * day), ibrahim.userId],
    );
  });

  /** An AI reading waiting for review, with its item. */
  async function waiting(value: string, reason: string, daysAgo: number) {
    const takenAt = new Date(Date.now() - daysAgo * day);
    const id = (
      await own<{ id: string }>(
        db,
        `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, source, state,
                                            review_reason, logged_by)
         VALUES ($1, $2, $3, $4, 'photo', 'needs_review', $5, $6) RETURNING id`,
        [home.id, meter, value, takenAt, reason, ibrahim.userId],
      )
    )[0]?.id as string;
    const item = await inboxItem(db, home, ibrahim, {
      kind: 'reading',
      meterReadingId: id,
      payload: {
        reason,
        value,
        thingId: car,
        meterId: meter,
        takenAt: takenAt.toISOString(),
        neighbours: {},
      },
    });
    return { id, item };
  }

  const readingOf = async (id: string) =>
    (
      await own<{ state: string; value: string }>(
        db,
        'SELECT state, trim_scale(value)::text AS value FROM public.meter_readings WHERE id = $1',
        [id],
      )
    )[0];

  // catalogue: POST /api/v1/inbox/:id/reading
  it("keeps, edits and discards a reading through step 2's reading actions", async () => {
    const kept = await waiting('53900', 'ai_read', 20);
    const listed = (await page(ibrahim, `locationId=${home.id}&kind=reading`)).items.find(
      (i) => i.id === kept.item,
    );
    expect(listed?.reading).toMatchObject({
      meter: { id: meter, unit: 'km' },
      value: '53900',
      reason: 'ai_read',
    });
    ok(await act(t, ibrahim, kept.item, 'reading', { action: 'keep' }));
    expect(await readingOf(kept.id)).toEqual({ state: 'accepted', value: '53900' });
    expect((await itemRow(db, kept.item))?.resolution).toBe('accepted');
    expect((await eventsOf(db, home.id, kept.id)).map((e) => e.action)).toEqual(['reading.accept']);

    const typo = await waiting('5410', 'lower_than_previous', 10);
    ok(await act(t, ibrahim, typo.item, 'reading', { action: 'edit', value: '54100' }));
    expect(await readingOf(typo.id)).toEqual({ state: 'accepted', value: '54100' });
    expect((await itemRow(db, typo.item))?.resolution).toBe('edited');
    expect((await eventsOf(db, home.id, typo.id)).map((e) => e.action)).toEqual(['reading.update']);

    const junk = await waiting('1', 'lower_than_previous', 5);
    ok(await act(t, ibrahim, junk.item, 'reading', { action: 'discard' }));
    expect(await readingOf(junk.id)).toBeUndefined();
    expect((await eventsOf(db, home.id, junk.id)).map((e) => e.action)).toEqual(['reading.delete']);
    expect(await eventsOf(db, home.id, junk.item)).toMatchObject([
      { action: 'inbox.resolve', diff: { resolution: { after: 'discarded' } } },
    ]);
  });

  it('records a meter replacement and keeps the reading after it', async () => {
    const low = await waiting('150', 'lower_than_previous', 1);
    expect(
      (await act(t, ibrahim, low.item, 'reading', { action: 'meter_replaced' })).statusCode,
    ).toBe(400);
    ok(await act(t, ibrahim, low.item, 'reading', { action: 'meter_replaced', offset: '54100' }));
    expect(await readingOf(low.id)).toEqual({ state: 'accepted', value: '150' });
    expect((await actions(home, 'meter.replaced')).length).toBe(1);
    expect((await itemRow(db, low.item))?.resolution).toBe('accepted');
  });

  it("keeps a reading AI couldn't read by typing its value", async () => {
    const item = await inboxItem(db, home, ibrahim, {
      kind: 'reading',
      thingId: car,
      payload: { reason: 'needs_value', meterId: meter, takenAt: new Date().toISOString() },
    });
    expect((await act(t, ibrahim, item, 'reading', { action: 'keep' })).statusCode).toBe(400);
    ok(await act(t, ibrahim, item, 'reading', { action: 'edit', value: '54300' }));
    const made = await own<{ value: string }>(
      db,
      `SELECT trim_scale(value)::text AS value FROM public.meter_readings
        WHERE meter_id = $1 AND value = 54300`,
      [meter],
    );
    expect(made).toHaveLength(1);
    expect((await itemRow(db, item))?.resolution).toBe('edited');
  });
});

describe('POST /api/v1/inbox/:id/restore', () => {
  // catalogue: POST /api/v1/inbox/:id/restore
  it('restores the trashed target and applies the dropped move again', async () => {
    const shelf = await place(db, home, 'Top shelf');
    const jar = await createThing(t, ibrahim, home, { name: 'Jam jar' });
    ok(await call(t, `/api/v1/places/${shelf}/trash`, { as: ibrahim, body: {} }));
    const item = await inboxItem(db, home, ibrahim, {
      kind: 'sync_drop',
      payload: {
        op: { op: 'move', payload: { thingIds: [jar.id], to: { placeId: shelf } } },
        reason: 'target_trashed',
        entity: { type: 'place', id: shelf, name: 'Top shelf' },
        by: { displayName: 'Alfred' },
      },
    });
    const listed = (await page(ibrahim, `locationId=${home.id}&kind=sync_drop`)).items.find(
      (i) => i.id === item,
    );
    expect(listed?.syncDrop).toMatchObject({
      reason: 'target_trashed',
      entity: { type: 'place', id: shelf, name: 'Top shelf' },
      by: { displayName: 'Alfred' },
    });
    const res = ok(await act(t, ibrahim, item, 'restore', {}));
    expect(res).toEqual({ outcome: 'applied' });
    expect((await thingOf(jar.id))?.place_id).toBe(shelf);
    const [p] = await own<{ deleted_at: Date | null }>(
      db,
      'SELECT deleted_at FROM public.places WHERE id = $1',
      [shelf],
    );
    expect(p?.deleted_at).toBeNull();
    expect((await eventsOf(db, home.id, jar.id)).map((e) => e.action)).toContain('thing.move');
    expect((await itemRow(db, item))?.resolution).toBe('restored');
  });
});

/** The status and body a request answered with, for the equal-answers checks. */
const answer = (res: LightMyRequestResponse) => ({ status: res.statusCode, body: res.json() });

describe('leak: the inbox answers another household exactly as nothing', () => {
  it("treats Bruce's items like random ids on every inbox route", async () => {
    const his = await draft(t, db, bruce, garage, { name: 'Welder' });
    const verbs: [string, unknown][] = [
      ['accept', {}],
      ['receipt', { vendor: { name: 'X' }, purchasedOn: '2026-09-01', currency: 'EGP', lines: [] }],
      ['currency', { currency: 'EGP' }],
      ['merge', { into: his.thingId }],
      ['not-duplicate', {}],
      ['reading', { action: 'keep' }],
      ['restore', {}],
      ['dismiss', {}],
      ['discard', {}],
    ];
    for (const [verb, body] of verbs) {
      const theirs = await act(t, ibrahim, his.itemId, verb, body);
      const random = await act(t, ibrahim, newId(), verb, body);
      expect(answer(theirs), verb).toEqual(answer(random));
      expect(theirs.statusCode, verb).toBe(404);
    }
    expect(
      answer(await call(t, `/api/v1/inbox/${his.itemId}/candidates`, { as: ibrahim })),
    ).toEqual(answer(await call(t, `/api/v1/inbox/${newId()}/candidates`, { as: ibrahim })));
    const bulk = ok(
      await call(t, '/api/v1/inbox/bulk', {
        as: ibrahim,
        body: { ids: [his.itemId], action: 'discard' },
      }),
    );
    expect(bulk).toEqual({ results: [{ id: his.itemId, ok: false, error: 'not_found' }] });
    const listed = await page(ibrahim, 'mine=0');
    expect(listed.items.some((i) => i.id === his.itemId)).toBe(false);
    // Nothing of his changed.
    expect(await thingOf(his.thingId)).toMatchObject({ review_state: 'draft', deleted_at: null });
    expect(await itemRow(db, his.itemId)).toMatchObject({ resolution: null });
  });
});
