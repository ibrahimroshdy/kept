import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';

// Task 11 through the front door: the account switcher, brands, vendors, people, tags and a
// person's contact details, as the web calls them (apps/web/src/api/inventory/{types,paths}.ts
// and mock/registries.ts). Rows the routes don't create are seeded as kept_owner.
//
// The household: Bob owns an account with two locations, "Bob home" and "Bob cabin". In Bob
// home, Adam is an admin, Mel a member and Vic a viewer; the cabin is Bob's alone, so Adam
// administers the account without seeing all of it (D123). Ann has her own account and sees
// nothing of Bob's.

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];
let ann: Person;
let bob: Person;
let adam: Person;
let mel: Person;
let vic: Person;
let bobAccount: string;
let annAccount: string;
let home: string;
let cabin: string;

const own = <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

async function createLocation(as: Person, name: string): Promise<string> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: {
      name,
      kind: 'home',
      preset: 'essentials',
      timezone: 'Africa/Cairo',
      currency: 'EGP',
      rooms: [],
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

async function accountOf(p: Person): Promise<string> {
  const [row] = await own<{ id: string }>(
    'SELECT id FROM public.owner_accounts WHERE user_id = $1',
    [p.userId],
  );
  return row?.id as string;
}

/** A live thing in `locationId`'s Unplaced area, seeded as kept_owner. */
async function thing(
  locationId: string,
  f: { brandId?: string; personId?: string; tagId?: string } = {},
): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, brand_id, belongs_to_person_id)
     VALUES ($1, $2, (SELECT id FROM public.places WHERE location_id = $2 AND is_unplaced), 'Thing',
             $3, $4)`,
    [id, locationId, f.brandId ?? null, f.personId ?? null],
  );
  if (f.tagId) {
    await own('INSERT INTO public.thing_tags (location_id, thing_id, tag_id) VALUES ($1, $2, $3)', [
      locationId,
      id,
      f.tagId,
    ]);
  }
  return id;
}

/** The account-level audit rows of `accountId` for `entityId`, oldest first. */
function accountAudit(
  accountId: string,
  entityId: string,
): Promise<
  { action: string; location_id: string | null; actor_id: string; diff: Record<string, unknown> }[]
> {
  return own(
    `SELECT action, location_id, actor_id, diff FROM public.audit_events
      WHERE owner_account_id = $1 AND entity_id = $2 ORDER BY at, id`,
    [accountId, entityId],
  );
}

type Created<T> = {
  item: T & { id: string; rowVersion: number };
  possibleDuplicates: { id: string; name: string; similarity: number }[];
};

async function create<T = Record<string, unknown>>(
  as: Person,
  kind: string,
  body: object,
  accountId = bobAccount,
): Promise<Created<T>> {
  const res = await call(t, `/api/v1/accounts/${accountId}/${kind}`, { as, body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Created<T>;
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent });
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  adam = await person(t, db, 'adam');
  mel = await person(t, db, 'mel');
  vic = await person(t, db, 'vic');
  bobAccount = await accountOf(bob);
  annAccount = await accountOf(ann);
  home = await createLocation(bob, 'Bob home');
  cabin = await createLocation(bob, 'Bob cabin');
  await join(db, home, adam.userId, 'admin');
  await join(db, home, mel.userId, 'member');
  await join(db, home, vic.userId, 'viewer');
});

describe('GET /api/v1/accounts', () => {
  it('lists the accounts you can see, your own first, with whether you manage each', async () => {
    const res = await call(t, '/api/v1/accounts', { as: adam });
    expect(res.statusCode, res.body).toBe(200);
    const { accounts } = res.json() as {
      accounts: { id: string; ownerDisplayName: string; isOwn: boolean; canManage: boolean }[];
    };
    expect(accounts.map((a) => [a.isOwn, a.canManage])).toEqual([
      [true, true],
      [false, true],
    ]);
    expect(accounts[1]?.id).toBe(bobAccount);
    expect(accounts[1]?.ownerDisplayName).toMatch(/^bob-/);

    const forVic = (await call(t, '/api/v1/accounts', { as: vic })).json() as {
      accounts: { id: string; canManage: boolean }[];
    };
    expect(forVic.accounts.find((a) => a.id === bobAccount)?.canManage).toBe(false);
    const forAnn = (await call(t, '/api/v1/accounts', { as: ann })).json() as {
      accounts: { id: string }[];
    };
    expect(forAnn.accounts.map((a) => a.id)).toEqual([annAccount]);
  });
});

describe('brands', () => {
  // catalogue: POST /api/v1/accounts/:accountId/brands
  it('an admin creates one, audited on the account; a member or viewer gets 403', async () => {
    const { item, possibleDuplicates } = await create<{ name: string; ownerAccountId: string }>(
      adam,
      'brands',
      { name: 'Samsung', website: 'https://samsung.com' },
    );
    expect(item).toMatchObject({
      name: 'Samsung',
      ownerAccountId: bobAccount,
      website: 'https://samsung.com',
      supportPhone: null,
      claimUrl: null,
      defaultWarrantyMonths: null,
      rowVersion: 1,
    });
    expect(possibleDuplicates).toEqual([]);
    const audit = await accountAudit(bobAccount, item.id);
    expect(audit).toMatchObject([
      { action: 'brand.create', location_id: null, actor_id: adam.userId },
    ]);
    expect(audit[0]?.diff).toMatchObject({ name: { after: 'Samsung', class: 'plain' } });

    for (const as of [mel, vic]) {
      const res = await call(t, `/api/v1/accounts/${bobAccount}/brands`, {
        as,
        body: { name: 'LG' },
      });
      expect(res.statusCode, res.body).toBe(403);
    }
  });

  it('refuses a normalised duplicate with 409 and the existing id', async () => {
    const { item } = await create(bob, 'brands', { name: 'Philips' });
    const res = await call(t, `/api/v1/accounts/${bobAccount}/brands`, {
      as: bob,
      body: { name: '  PHILIPS ' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'conflict', existingId: item.id });
  });

  it('is invisible to another account: 404 on the list, the item and a write', async () => {
    const { item } = await create(bob, 'brands', { name: 'Bosch' });
    expect((await call(t, `/api/v1/accounts/${bobAccount}/brands`, { as: ann })).statusCode).toBe(
      404,
    );
    expect((await call(t, `/api/v1/brands/${item.id}`, { as: ann })).statusCode).toBe(404);
    const res = await call(t, `/api/v1/brands/${item.id}`, {
      as: ann,
      method: 'PATCH',
      body: { name: 'Mine' },
      headers: { 'if-match': '1' },
    });
    expect(res.statusCode).toBe(404);
    expect((await call(t, `/api/v1/brands/${item.id}`, { as: vic })).json()).toMatchObject({
      name: 'Bosch',
    });
  });

  // catalogue: PATCH /api/v1/brands/:id
  it('renames with If-Match, audited, and reindexes every location that uses it', async () => {
    const { item } = await create(bob, 'brands', { name: 'Braun' });
    await thing(home, { brandId: item.id });
    await thing(cabin, { brandId: item.id });
    sent.length = 0;
    const res = await call(t, `/api/v1/brands/${item.id}`, {
      as: adam,
      method: 'PATCH',
      body: { name: 'Braun GmbH', supportPhone: '+49 1' },
      headers: { 'if-match': '1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Braun GmbH', supportPhone: '+49 1', rowVersion: 2 });
    const audit = await accountAudit(bobAccount, item.id);
    expect(audit.map((a) => a.action)).toEqual(['brand.create', 'brand.update']);
    expect(audit[1]?.diff).toMatchObject({
      name: { before: 'Braun', after: 'Braun GmbH' },
      support_phone: { before: null, after: '+49 1' },
    });
    // Adam can't see the cabin, but its things name the brand too (T20, 0026).
    const reindexed = sent
      .filter((j) => j.name === 'reindex')
      .map((j) => (j.data as { locationId: string }).locationId);
    expect(reindexed.sort()).toEqual([home, cabin].sort());
  });

  it('answers 412 with the fields, the version and who changed it; 428 without If-Match', async () => {
    const { item } = await create(bob, 'brands', { name: 'Miele' });
    const first = await call(t, `/api/v1/brands/${item.id}`, {
      as: bob,
      method: 'PATCH',
      body: { website: 'https://miele.com' },
      headers: { 'if-match': '1' },
    });
    expect(first.statusCode, first.body).toBe(200);
    const stale = await call(t, `/api/v1/brands/${item.id}`, {
      as: adam,
      method: 'PATCH',
      body: { name: 'Miele & Cie' },
      headers: { 'if-match': '1' },
    });
    expect(stale.statusCode, stale.body).toBe(412);
    const body = stale.json() as {
      conflicts: string[];
      row_version: number;
      changedBy: { displayName: string };
    };
    expect(body.conflicts).toEqual(['name']);
    expect(body.row_version).toBe(2);
    expect(body.changedBy.displayName).toMatch(/^bob-/);
    const bare = await call(t, `/api/v1/brands/${item.id}`, {
      as: adam,
      method: 'PATCH',
      body: { name: 'Miele & Cie' },
    });
    expect(bare.statusCode).toBe(428);
  });

  // catalogue: DELETE /api/v1/brands/:id
  it('deletes one nothing uses, audited; one used where you can’t see is 409 in_use', async () => {
    const used = (await create(bob, 'brands', { name: 'Dyson' })).item;
    await thing(cabin, { brandId: used.id });
    const refused = await call(t, `/api/v1/brands/${used.id}`, { as: adam, method: 'DELETE' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'in_use' });

    const spare = (await create(bob, 'brands', { name: 'Tefal' })).item;
    expect(
      (await call(t, `/api/v1/brands/${spare.id}`, { as: mel, method: 'DELETE' })).statusCode,
    ).toBe(403);
    const res = await call(t, `/api/v1/brands/${spare.id}`, { as: adam, method: 'DELETE' });
    expect(res.statusCode, res.body).toBe(204);
    const audit = await accountAudit(bobAccount, spare.id);
    expect(audit.map((a) => a.action)).toEqual(['brand.create', 'brand.delete']);
    expect((await call(t, `/api/v1/brands/${spare.id}`, { as: bob })).statusCode).toBe(404);
  });

  // catalogue: POST /api/v1/brands/:id/merge-into
  it('merges into another, moving every thing in the account, audited', async () => {
    const from = (await create(bob, 'brands', { name: 'Hoover UK' })).item;
    const into = (await create(bob, 'brands', { name: 'Hoover' })).item;
    const a = await thing(home, { brandId: from.id });
    const b = await thing(cabin, { brandId: from.id });
    const res = await call(t, `/api/v1/brands/${from.id}/merge-into`, {
      as: adam,
      body: { targetId: into.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ repointed: 2 });
    const rows = await own<{ brand_id: string }>(
      'SELECT brand_id FROM public.things WHERE id = ANY($1)',
      [[a, b]],
    );
    expect(rows.map((r) => r.brand_id)).toEqual([into.id, into.id]);
    const audit = await accountAudit(bobAccount, from.id);
    expect(audit.at(-1)).toMatchObject({ action: 'brand.merge' });
    expect(audit.at(-1)?.diff).toMatchObject({ merged_into: { after: into.id } });

    const self = await call(t, `/api/v1/brands/${into.id}/merge-into`, {
      as: adam,
      body: { targetId: into.id },
    });
    expect(self.statusCode).toBe(400);
    expect(
      (
        await call(t, `/api/v1/brands/${into.id}/merge-into`, {
          as: mel,
          body: { targetId: from.id },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('lists with q, normalised and ranked, one page at a time', async () => {
    await create(ann, 'brands', { name: 'Sony' }, annAccount);
    await create(ann, 'brands', { name: 'Sonos' }, annAccount);
    await create(ann, 'brands', { name: 'Apple' }, annAccount);
    const res = await call(t, `/api/v1/accounts/${annAccount}/brands?q=SONY`, { as: ann });
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as { items: { name: string }[]; next_cursor: string | null };
    expect(page.items[0]?.name).toBe('Sony');
    expect(page.items.map((i) => i.name)).not.toContain('Apple');

    const first = (
      await call(t, `/api/v1/accounts/${annAccount}/brands?limit=2`, { as: ann })
    ).json() as {
      items: { name: string }[];
      next_cursor: string;
    };
    expect(first.items.map((i) => i.name)).toEqual(['Apple', 'Sonos']);
    const second = (
      await call(t, `/api/v1/accounts/${annAccount}/brands?limit=2&cursor=${first.next_cursor}`, {
        as: ann,
      })
    ).json() as { items: { name: string }[]; next_cursor: string | null };
    expect(second.items.map((i) => i.name)).toEqual(['Sony']);
    expect(second.next_cursor).toBeNull();
  });
});

describe('vendors and people, created inline (D11)', () => {
  // catalogue: POST /api/v1/accounts/:accountId/people
  it('a member adds a person and is shown the near duplicates; a viewer gets 403', async () => {
    const alfred = await create<{ displayName: string; userId: string | null }>(mel, 'people', {
      displayName: 'Alfred',
    });
    expect(alfred.item).toMatchObject({
      displayName: 'Alfred',
      userId: null,
      ownerAccountId: bobAccount,
    });
    const again = await create(mel, 'people', { displayName: 'alfred ' });
    expect(again.possibleDuplicates).toEqual([
      { id: alfred.item.id, name: 'Alfred', similarity: 1 },
    ]);
    const audit = await accountAudit(bobAccount, again.item.id);
    expect(audit).toMatchObject([
      { action: 'person.create', actor_id: mel.userId, location_id: null },
    ]);
    const res = await call(t, `/api/v1/accounts/${bobAccount}/people`, {
      as: vic,
      body: { displayName: 'Viv' },
    });
    expect(res.statusCode).toBe(403);
  });

  // catalogue: POST /api/v1/accounts/:accountId/vendors
  it('a member adds a vendor, audited; the kind defaults to other', async () => {
    const { item } = await create<{ kind: string }>(mel, 'vendors', { name: 'Carrefour Maadi' });
    expect(item).toMatchObject({ name: 'Carrefour Maadi', kind: 'other', address: null });
    const dupe = await create(mel, 'vendors', { name: 'Carrefour  maadi', kind: 'store' });
    expect(dupe.possibleDuplicates.map((d) => d.id)).toEqual([item.id]);
    expect(await accountAudit(bobAccount, item.id)).toMatchObject([{ action: 'vendor.create' }]);
  });

  it('refuses linking a person to a user who has no membership in the account', async () => {
    const res = await call(t, `/api/v1/accounts/${bobAccount}/people`, {
      as: bob,
      body: { displayName: 'Ann', userId: ann.userId },
    });
    expect(res.statusCode).toBe(404);
    const ok = await create<{ userId: string }>(bob, 'people', {
      displayName: 'Adam',
      userId: adam.userId,
    });
    expect(ok.item.userId).toBe(adam.userId);
  });

  // catalogue: PATCH /api/v1/vendors/:id
  it('only an admin changes a vendor, audited', async () => {
    const { item } = await create(mel, 'vendors', { name: 'B.Tech' });
    const bad = await call(t, `/api/v1/vendors/${item.id}`, {
      as: mel,
      method: 'PATCH',
      body: { phone: '19966' },
      headers: { 'if-match': '1' },
    });
    expect(bad.statusCode).toBe(403);
    const res = await call(t, `/api/v1/vendors/${item.id}`, {
      as: adam,
      method: 'PATCH',
      body: { phone: '19966', kind: 'store' },
      headers: { 'if-match': '1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ phone: '19966', kind: 'store', rowVersion: 2 });
    expect((await accountAudit(bobAccount, item.id)).map((a) => a.action)).toEqual([
      'vendor.create',
      'vendor.update',
    ]);
  });

  // catalogue: DELETE /api/v1/vendors/:id
  it('a vendor on a purchase is in use; an unused one is deleted, audited', async () => {
    const used = (await create(bob, 'vendors', { name: 'Amazon', kind: 'online' })).item;
    await own(
      `INSERT INTO public.purchases (location_id, vendor_id, purchased_on) VALUES ($1, $2, '2026-09-01')`,
      [cabin, used.id],
    );
    const refused = await call(t, `/api/v1/vendors/${used.id}`, { as: adam, method: 'DELETE' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'in_use' });
    const spare = (await create(bob, 'vendors', { name: 'Noon' })).item;
    expect(
      (await call(t, `/api/v1/vendors/${spare.id}`, { as: adam, method: 'DELETE' })).statusCode,
    ).toBe(204);
    expect((await accountAudit(bobAccount, spare.id)).map((a) => a.action)).toEqual([
      'vendor.create',
      'vendor.delete',
    ]);
  });

  // catalogue: POST /api/v1/vendors/:id/merge-into
  it('merges vendors, moving the purchases, audited', async () => {
    const from = (await create(bob, 'vendors', { name: 'Spinneys Zayed' })).item;
    const into = (await create(bob, 'vendors', { name: 'Spinneys' })).item;
    await own(
      `INSERT INTO public.purchases (location_id, vendor_id, purchased_on) VALUES ($1, $2, '2026-09-01')`,
      [home, from.id],
    );
    const res = await call(t, `/api/v1/vendors/${from.id}/merge-into`, {
      as: bob,
      body: { targetId: into.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ repointed: 1 });
    expect((await accountAudit(bobAccount, from.id)).at(-1)?.action).toBe('vendor.merge');
  });

  // catalogue: PATCH /api/v1/people/:id
  it('renaming a person reindexes where they own things, audited', async () => {
    const { item } = await create(bob, 'people', { displayName: 'Selina' });
    await thing(cabin, { personId: item.id });
    sent.length = 0;
    const res = await call(t, `/api/v1/people/${item.id}`, {
      as: bob,
      method: 'PATCH',
      body: { displayName: 'Selina K' },
      headers: { 'if-match': '1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ displayName: 'Selina K', rowVersion: 2 });
    expect(sent.map((j) => j.data)).toEqual([{ locationId: cabin }]);
    expect((await accountAudit(bobAccount, item.id)).at(-1)?.diff).toMatchObject({
      display_name: { before: 'Selina', after: 'Selina K' },
    });
  });

  // catalogue: DELETE /api/v1/people/:id
  it('a person nothing belongs to is deleted, audited', async () => {
    const { item } = await create(bob, 'people', { displayName: 'Temp' });
    expect(
      (await call(t, `/api/v1/people/${item.id}`, { as: bob, method: 'DELETE' })).statusCode,
    ).toBe(204);
    expect((await accountAudit(bobAccount, item.id)).map((a) => a.action)).toEqual([
      'person.create',
      'person.delete',
    ]);
  });

  // catalogue: POST /api/v1/people/:id/merge-into
  it('merges two people, their things following, audited', async () => {
    const from = (await create(bob, 'people', { displayName: 'Ibrahim H' })).item;
    const into = (await create(bob, 'people', { displayName: 'Ibrahim' })).item;
    const th = await thing(home, { personId: from.id });
    const res = await call(t, `/api/v1/people/${from.id}/merge-into`, {
      as: adam,
      body: { targetId: into.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ repointed: 1 });
    const [row] = await own<{ p: string }>(
      'SELECT belongs_to_person_id AS p FROM public.things WHERE id = $1',
      [th],
    );
    expect(row?.p).toBe(into.id);
    expect((await accountAudit(bobAccount, from.id)).at(-1)?.action).toBe('person.merge');
  });
});

describe('tags', () => {
  // catalogue: POST /api/v1/accounts/:accountId/tags
  it('a member creates one, audited; a normalised duplicate is 409 with the existing id', async () => {
    const { item } = await create<{ colour: string | null }>(mel, 'tags', {
      name: 'Fragile',
      colour: '#AA0000',
    });
    expect(item).toMatchObject({ name: 'Fragile', colour: '#AA0000' });
    expect(await accountAudit(bobAccount, item.id)).toMatchObject([{ action: 'tag.create' }]);
    const res = await call(t, `/api/v1/accounts/${bobAccount}/tags`, {
      as: mel,
      body: { name: 'fragile' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ existingId: item.id });
    const byVic = await call(t, `/api/v1/accounts/${bobAccount}/tags`, {
      as: vic,
      body: { name: 'Mine' },
    });
    expect(byVic.statusCode).toBe(403);
  });

  // catalogue: PATCH /api/v1/tags/:id
  it('only an admin renames one (tags.edit-delete), audited, reindexing its things', async () => {
    const { item } = await create(mel, 'tags', { name: 'Winter' });
    await thing(home, { tagId: item.id });
    const byMel = await call(t, `/api/v1/tags/${item.id}`, {
      as: mel,
      method: 'PATCH',
      body: { name: 'Cold' },
      headers: { 'if-match': '1' },
    });
    expect(byMel.statusCode).toBe(403);
    sent.length = 0;
    const res = await call(t, `/api/v1/tags/${item.id}`, {
      as: adam,
      method: 'PATCH',
      body: { name: 'Cold' },
      headers: { 'if-match': '1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(sent.map((j) => j.data)).toEqual([{ locationId: home }]);
    expect((await accountAudit(bobAccount, item.id)).at(-1)?.action).toBe('tag.update');
  });

  // catalogue: DELETE /api/v1/tags/:id
  it('a tag on a thing is in use; an unused one is deleted, audited', async () => {
    const used = (await create(bob, 'tags', { name: 'Garage' })).item;
    await thing(cabin, { tagId: used.id });
    expect(
      (await call(t, `/api/v1/tags/${used.id}`, { as: adam, method: 'DELETE' })).statusCode,
    ).toBe(409);
    const spare = (await create(bob, 'tags', { name: 'Spare' })).item;
    expect(
      (await call(t, `/api/v1/tags/${spare.id}`, { as: adam, method: 'DELETE' })).statusCode,
    ).toBe(204);
    expect((await accountAudit(bobAccount, spare.id)).map((a) => a.action)).toEqual([
      'tag.create',
      'tag.delete',
    ]);
  });

  // catalogue: POST /api/v1/tags/:id/merge-into
  it('merges two tags, audited', async () => {
    const from = (await create(bob, 'tags', { name: 'Kitchenware' })).item;
    const into = (await create(bob, 'tags', { name: 'Kitchen' })).item;
    await thing(home, { tagId: from.id });
    const res = await call(t, `/api/v1/tags/${from.id}/merge-into`, {
      as: bob,
      body: { targetId: into.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ repointed: 1 });
    expect((await accountAudit(bobAccount, from.id)).at(-1)?.action).toBe('tag.merge');
  });
});

describe('a person’s contact details (D177)', () => {
  let ibrahim: string;

  beforeAll(async () => {
    ibrahim = (await create(bob, 'people', { displayName: 'Ibrahim the neighbour' })).item.id;
  });

  // catalogue: PUT /api/v1/people/:id/contact
  it('an admin of every location that uses them reads and writes them, audited as secret', async () => {
    // Used nowhere yet: any admin of the account may see them (Q5).
    const empty = await call(t, `/api/v1/people/${ibrahim}/contact`, { as: adam });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({ phone: null, email: null, notes: null });

    const res = await call(t, `/api/v1/people/${ibrahim}/contact`, {
      as: adam,
      method: 'PUT',
      body: { phone: '+20 100 555 0199', email: 'ibrahim@example.com' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      phone: '+20 100 555 0199',
      email: 'ibrahim@example.com',
      notes: null,
    });
    const audit = await accountAudit(bobAccount, ibrahim);
    expect(audit.at(-1)?.action).toBe('person.contact_update');
    expect(audit.at(-1)?.diff).toEqual({
      phone: { changed: true, class: 'secret' },
      email: { changed: true, class: 'secret' },
    });
    expect(JSON.stringify(audit)).not.toContain('555');
  });

  it('is a 404 to an admin of only one of the locations that use them, and to members', async () => {
    await thing(home, { personId: ibrahim });
    expect((await call(t, `/api/v1/people/${ibrahim}/contact`, { as: adam })).statusCode).toBe(200);
    await thing(cabin, { personId: ibrahim });
    expect((await call(t, `/api/v1/people/${ibrahim}/contact`, { as: adam })).statusCode).toBe(404);
    const put = await call(t, `/api/v1/people/${ibrahim}/contact`, {
      as: adam,
      method: 'PUT',
      body: { phone: '0' },
    });
    expect(put.statusCode).toBe(404);
    expect((await call(t, `/api/v1/people/${ibrahim}/contact`, { as: mel })).statusCode).toBe(404);
    expect((await call(t, `/api/v1/people/${ibrahim}/contact`, { as: ann })).statusCode).toBe(404);
    const forBob = await call(t, `/api/v1/people/${ibrahim}/contact`, { as: bob });
    expect(forBob.json()).toMatchObject({ email: 'ibrahim@example.com' });
  });
});

describe('route security review (step 2): registries', () => {
  it('answers 400, never 500, to a PATCH that changes nothing', async () => {
    const { item } = await create(bob, 'brands', { name: 'Empty patch brand' });
    for (const body of [{}, { name: undefined }]) {
      const res = await call(t, `/api/v1/brands/${item.id}`, {
        as: bob,
        method: 'PATCH',
        body,
        headers: { 'if-match': '1' },
      });
      expect(res.statusCode, res.body).toBe(400);
    }
  });

  it("names only a person in a 412's changedBy, never another actor that shares an id", async () => {
    const { item } = await create(bob, 'brands', { name: 'Token-touched brand' });
    await own(
      `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id,
                                        action, entity_type, entity_id, diff)
       VALUES (NULL, $1, 'import', $2, 'brand.update', 'brand', $3, '{}')`,
      [bobAccount, mel.userId, item.id],
    );
    const stale = await call(t, `/api/v1/brands/${item.id}`, {
      as: adam,
      method: 'PATCH',
      body: { name: 'Token-touched brand 2' },
      headers: { 'if-match': '7' },
    });
    expect(stale.statusCode, stale.body).toBe(412);
    expect(stale.json().changedBy ?? null).toBeNull();
  });
});
