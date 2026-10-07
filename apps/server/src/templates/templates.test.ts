import { newId } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { builtinType, createLocation, createThing, type Loc, ok, own } from '../../test/things.js';

// T19: account templates shared per location, save-as-template and quick add, through the front
// door in the web contract's shapes (apps/web/src/api/capture/types.ts "templates and quick add").
//
// The household: Ibrahim owns Home and Garage (one account). In Home, Bruce is an admin, Louis a
// member and Talia a viewer; the Garage is Ibrahim's alone, so Bruce administers the account
// without administering every location. Alfred has his own household, بيت العائلة, and sees
// nothing of Ibrahim's.

let db: TestDb;
let t: TestApp;
let ibrahim: Person;
let bruce: Person;
let louis: Person;
let talia: Person;
let alfred: Person;
let home: Loc;
let garage: Loc;
let family: Loc;
let furniture: string;
let computer: string;
let valuables: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  bruce = await person(t, db, 'bruce');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'household', 'Garage');
  family = await createLocation(t, db, alfred, 'household', 'بيت العائلة');
  await join(db, home.id, bruce.userId, 'admin');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  furniture = await builtinType(db, 'furniture');
  computer = await builtinType(db, 'computer');
  valuables = await builtinType(db, 'valuables');
});

afterAll(async () => {
  await t.app.close();
});

type Template = {
  id: string;
  name: string;
  typeId: string | null;
  typeIcon: string | null;
  payload: Record<string, unknown>;
};
type AccountTemplate = Template & {
  locations: { id: string; name: string }[];
  rowVersion: number;
};

const answer = (res: LightMyRequestResponse) => ({ status: res.statusCode, body: res.body });

const createTemplate = (as: Person, accountId: string, body: Record<string, unknown>) =>
  call(t, `/api/v1/accounts/${accountId}/templates`, { as, body });

const patchTemplate = (
  as: Person,
  id: string,
  body: Record<string, unknown>,
  rowVersion: number | null,
) =>
  call(t, `/api/v1/templates/${id}`, {
    as,
    method: 'PATCH',
    body,
    headers: rowVersion === null ? {} : { 'if-match': String(rowVersion) },
  });

const deleteTemplate = (as: Person, id: string) =>
  call(t, `/api/v1/templates/${id}`, { as, method: 'DELETE' });

const saveAs = (as: Person, thingId: string, body: Record<string, unknown>) =>
  call(t, `/api/v1/things/${thingId}/save-as-template`, { as, body });

const usable = async (as: Person, loc: { id: string }) =>
  (
    ok(await call(t, `/api/v1/templates?locationId=${loc.id}`, { as })) as unknown as {
      items: Template[];
    }
  ).items;

const adminList = async (as: Person, accountId: string) =>
  (
    ok(await call(t, `/api/v1/accounts/${accountId}/templates`, { as })) as unknown as {
      items: AccountTemplate[];
    }
  ).items;

/** A template in Ibrahim's account, made by Ibrahim. */
async function template(
  over: Record<string, unknown> = {},
  locations: Loc[] = [home],
): Promise<AccountTemplate> {
  const res = await createTemplate(ibrahim, home.accountId, {
    name: 'Kitchen chair',
    payload: {},
    locationIds: locations.map((l) => l.id),
    ...over,
  });
  return ok(res, 201) as unknown as AccountTemplate;
}

/** The account-level audit rows of an entity, oldest first. */
const templateAudit = (entityId: string) =>
  own<{
    action: string;
    location_id: string | null;
    owner_account_id: string | null;
    actor_id: string;
    diff: Record<string, unknown>;
  }>(
    db,
    `SELECT action, location_id, owner_account_id, actor_id, diff FROM public.audit_events
      WHERE entity_id = $1 ORDER BY at, id`,
    [entityId],
  );

/** A live thing seeded as kept_owner (its custom values untouched by the routes' checks). */
async function seedThing(
  loc: Loc,
  f: { name: string; typeId: string; custom: Record<string, unknown>; model?: string },
): Promise<string> {
  const id = newId();
  await own(
    db,
    `INSERT INTO public.things (id, location_id, place_id, name, type_id, model, custom)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, loc.id, loc.unplacedId, f.name, f.typeId, f.model ?? null, JSON.stringify(f.custom)],
  );
  return id;
}

describe('POST /api/v1/accounts/:accountId/templates', () => {
  // catalogue: POST /api/v1/accounts/:accountId/templates
  it('makes a template shared into a location, audited on the account', async () => {
    const res = await createTemplate(ibrahim, home.accountId, {
      name: 'Oak chair',
      typeId: furniture,
      payload: {
        model: 'Windsor',
        colour: 'Natural',
        quantity: '4',
        notes: 'Kitchen set',
        custom: { material: 'Oak' },
      },
      locationIds: [home.id],
    });
    const out = ok(res, 201) as unknown as AccountTemplate;
    expect(out).toMatchObject({
      name: 'Oak chair',
      typeId: furniture,
      typeIcon: 'lucide:sofa',
      payload: {
        model: 'Windsor',
        colour: 'Natural',
        quantity: '4',
        notes: 'Kitchen set',
        custom: { material: 'Oak' },
      },
      locations: [{ id: home.id, name: 'Home' }],
      rowVersion: 1,
    });
    const audit = await templateAudit(out.id);
    expect(audit).toMatchObject([
      {
        action: 'template.create',
        location_id: null,
        owner_account_id: home.accountId,
        actor_id: ibrahim.userId,
      },
    ]);
  });

  it('refuses money, secrets, unknown keys and fields a template cannot hold', async () => {
    const bad: Record<string, unknown>[] = [
      // money: a money field of the type, and a price key
      {
        typeId: valuables,
        payload: { custom: { appraisal_value: { amount: '100', currency: 'EGP' } } },
      },
      { payload: { price: '100' } },
      // a secret field
      { typeId: computer, payload: { custom: { licence_key: 'ABCD-1234' } } },
      // a date field, a field the type lacks, custom without a type
      { typeId: valuables, payload: { custom: { appraisal_date: '2026-01-01' } } },
      { typeId: furniture, payload: { custom: { cpu: 'M4' } } },
      { payload: { custom: { material: 'Oak' } } },
      // a quantity a serialized type refuses; no location
      { typeId: computer, payload: { quantity: '2' } },
      { payload: {}, locationIds: [] },
    ];
    for (const over of bad) {
      const res = await createTemplate(ibrahim, home.accountId, {
        name: 'Probe',
        payload: {},
        locationIds: [home.id],
        ...over,
      });
      expect(res.statusCode, JSON.stringify(over)).toBe(400);
    }
    const money = await createTemplate(ibrahim, home.accountId, {
      name: 'Probe',
      typeId: computer,
      payload: { custom: { licence_key: 'ABCD-1234' } },
      locationIds: [home.id],
    });
    expect(money.json()).toMatchObject({ hint: 'Templates never hold prices or secrets.' });
    const rows = await own(db, "SELECT 1 FROM public.templates WHERE name = 'Probe'");
    expect(rows).toHaveLength(0);
  });

  it('needs an owner or admin, sharing only into locations they administer', async () => {
    // A member manages nothing.
    expect(
      (
        await createTemplate(louis, home.accountId, {
          name: 'X',
          payload: {},
          locationIds: [home.id],
        })
      ).statusCode,
    ).toBe(403);
    // Bruce administers Home, not the Garage (which he can't even see).
    ok(
      await createTemplate(bruce, home.accountId, {
        name: 'Bruce drill',
        payload: {},
        locationIds: [home.id],
      }),
      201,
    );
    expect(
      (
        await createTemplate(bruce, home.accountId, {
          name: 'X',
          payload: {},
          locationIds: [home.id, garage.id],
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('GET /api/v1/templates?locationId (quick add list)', () => {
  it('shows a member the templates shared with their location, and nothing shared elsewhere', async () => {
    const both = await template({ name: 'Shared both' }, [home, garage]);
    const garageOnly = await template({ name: 'Garage only' }, [garage]);
    const listed = await usable(louis, home);
    const ids = listed.map((x) => x.id);
    expect(ids).toContain(both.id);
    expect(ids).not.toContain(garageOnly.id);
    // The public shape: no locations, no version.
    const one = listed.find((x) => x.id === both.id);
    expect(Object.keys(one ?? {}).sort()).toEqual(['id', 'name', 'payload', 'typeIcon', 'typeId']);
    // Louis isn't in the Garage; Talia only views Home.
    expect(await usable(louis, garage)).toEqual([]);
    expect(await usable(talia, home)).toEqual([]);
    // Ibrahim sees the Garage's.
    expect((await usable(ibrahim, garage)).map((x) => x.id)).toContain(garageOnly.id);
  });
});

describe('GET /api/v1/accounts/:accountId/templates (admin view)', () => {
  it('lists only the templates the caller can change', async () => {
    const homeOnly = await template({ name: 'Home only' }, [home]);
    const both = await template({ name: 'Both places' }, [home, garage]);
    const mine = await adminList(ibrahim, home.accountId);
    expect(mine.map((x) => x.id)).toEqual(expect.arrayContaining([homeOnly.id, both.id]));
    expect(
      mine
        .find((x) => x.id === both.id)
        ?.locations.map((l) => l.id)
        .sort(),
    ).toEqual([home.id, garage.id].sort());
    // Bruce administers Home only: the one shared with the Garage is left out.
    const his = (await adminList(bruce, home.accountId)).map((x) => x.id);
    expect(his).toContain(homeOnly.id);
    expect(his).not.toContain(both.id);
    // A member changes none; another household's account is a 404.
    expect(await adminList(louis, home.accountId)).toEqual([]);
    expect(
      (await call(t, `/api/v1/accounts/${home.accountId}/templates`, { as: alfred })).statusCode,
    ).toBe(404);
  });
});

describe('PATCH /api/v1/templates/:id', () => {
  // catalogue: PATCH /api/v1/templates/:id
  it('edits with If-Match, answers 412 on a stale version and audits the change', async () => {
    const tpl = await template({ name: 'Desk lamp', payload: { colour: 'Black' } });
    expect((await patchTemplate(ibrahim, tpl.id, { name: 'Lamp' }, null)).statusCode).toBe(428);
    const out = ok(
      await patchTemplate(
        ibrahim,
        tpl.id,
        { name: 'Reading lamp', payload: { colour: 'White' }, locationIds: [home.id, garage.id] },
        tpl.rowVersion,
      ),
    ) as unknown as AccountTemplate;
    expect(out).toMatchObject({
      name: 'Reading lamp',
      payload: { colour: 'White' },
      rowVersion: tpl.rowVersion + 1,
    });
    expect(out.locations.map((l) => l.id).sort()).toEqual([home.id, garage.id].sort());

    // The version it started from is stale now.
    const stale = await patchTemplate(ibrahim, tpl.id, { name: 'Again' }, tpl.rowVersion);
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ conflicts: ['name'], row_version: out.rowVersion });

    const audit = await templateAudit(tpl.id);
    expect(audit.map((a) => a.action)).toEqual(['template.create', 'template.update']);
    expect(audit[1]).toMatchObject({ location_id: null, owner_account_id: home.accountId });
  });

  it('refuses money and secrets on an edit too', async () => {
    const tpl = await template({ typeId: computer, payload: { custom: { cpu: 'M4' } } });
    const res = await patchTemplate(
      ibrahim,
      tpl.id,
      { payload: { custom: { cpu: 'M4', licence_key: 'X' } } },
      tpl.rowVersion,
    );
    expect(res.statusCode).toBe(400);
  });

  it('lets an admin of every location edit, and refuses one who administers only some', async () => {
    const homeOnly = await template({ name: 'Bruce can' }, [home]);
    const both = await template({ name: 'Bruce cannot' }, [home, garage]);
    ok(await patchTemplate(bruce, homeOnly.id, { name: 'Bruce did' }, homeOnly.rowVersion));
    expect((await patchTemplate(bruce, both.id, { name: 'No' }, both.rowVersion)).statusCode).toBe(
      403,
    );
    // A member of Home sees it (it's shared there) but can't change it.
    expect((await patchTemplate(louis, homeOnly.id, { name: 'No' }, 2)).statusCode).toBe(403);
    // Bruce can't share it into a location he doesn't administer.
    expect(
      (
        await patchTemplate(
          bruce,
          homeOnly.id,
          { locationIds: [home.id, garage.id] },
          homeOnly.rowVersion + 1,
        )
      ).statusCode,
    ).toBe(404);
  });
});

describe('DELETE /api/v1/templates/:id', () => {
  // catalogue: DELETE /api/v1/templates/:id
  it('deletes for an admin of every location, audited on the account', async () => {
    const both = await template({ name: 'To delete' }, [home, garage]);
    expect((await deleteTemplate(bruce, both.id)).statusCode).toBe(403);
    expect((await deleteTemplate(louis, both.id)).statusCode).toBe(403);
    expect((await deleteTemplate(ibrahim, both.id)).statusCode).toBe(204);
    expect(await own(db, 'SELECT 1 FROM public.templates WHERE id = $1', [both.id])).toEqual([]);
    const audit = await templateAudit(both.id);
    expect(audit.map((a) => a.action)).toEqual(['template.create', 'template.delete']);
    expect(audit[1]).toMatchObject({ location_id: null, owner_account_id: home.accountId });
  });
});

describe('POST /api/v1/things/:id/save-as-template', () => {
  // catalogue: POST /api/v1/things/:id/save-as-template
  it("builds the payload from the thing's details, leaving money and secrets behind", async () => {
    const ring = await seedThing(home, {
      name: 'Ring',
      typeId: valuables,
      model: 'Solitaire',
      custom: {
        appraisal_value: { amount: '25000', currency: 'EGP' },
        appraisal_date: '2026-02-01',
      },
    });
    const out = ok(
      await saveAs(ibrahim, ring, { name: 'Ring template', locationIds: [home.id] }),
      201,
    ) as unknown as AccountTemplate;
    expect(out).toMatchObject({
      name: 'Ring template',
      typeId: valuables,
      payload: { model: 'Solitaire' },
      locations: [{ id: home.id, name: 'Home' }],
    });
    expect(out.payload.custom).toBeUndefined();
    const [stored] = await own<{ payload: Record<string, unknown> }>(
      db,
      'SELECT payload FROM public.templates WHERE id = $1',
      [out.id],
    );
    expect(JSON.stringify(stored?.payload)).not.toContain('25000');

    // A computer's CPU goes; its licence key is a secret, kept in the secret store and never in
    // custom (the database refuses it there), so nothing of it can reach a template.
    const laptop = await seedThing(home, {
      name: 'Laptop',
      typeId: computer,
      custom: { cpu: 'M4' },
    });
    const fromLaptop = ok(
      await saveAs(ibrahim, laptop, { name: 'Laptop template', locationIds: [home.id] }),
      201,
    ) as unknown as AccountTemplate;
    expect(fromLaptop.payload).toEqual({ custom: { cpu: 'M4' } });

    const audit = await templateAudit(out.id);
    expect(audit).toMatchObject([
      { action: 'template.create', location_id: null, owner_account_id: home.accountId },
    ]);
  });

  it("needs an owner or admin of the thing's location", async () => {
    const chair = await seedThing(home, { name: 'Chair', typeId: furniture, custom: {} });
    expect((await saveAs(louis, chair, { name: 'X', locationIds: [home.id] })).statusCode).toBe(
      403,
    );
    expect((await saveAs(talia, chair, { name: 'X', locationIds: [home.id] })).statusCode).toBe(
      403,
    );
    ok(await saveAs(bruce, chair, { name: 'Chair template', locationIds: [home.id] }), 201);
  });
});

describe('quick add: POST /api/v1/things with templateId', () => {
  it("starts from the template's payload, and explicit fields win", async () => {
    const tag = (
      await own<{ id: string }>(
        db,
        `INSERT INTO public.tags (owner_account_id, name) VALUES ($1, 'Kitchen') RETURNING id`,
        [home.accountId],
      )
    )[0]?.id as string;
    const tpl = await template({
      name: 'Dining chair',
      typeId: furniture,
      payload: {
        model: 'Windsor',
        colour: 'Natural',
        quantity: '4',
        notes: 'From the kitchen set',
        tagIds: [tag],
        custom: { material: 'Oak', dimensions: '45 × 50 cm' },
      },
    });
    const thing = await createThing(t, louis, home, {
      name: 'Chair by the window',
      colour: 'Green',
      custom: { material: 'Pine' },
      templateId: tpl.id,
    });
    expect(thing).toMatchObject({
      name: 'Chair by the window',
      model: 'Windsor',
      colour: 'Green',
      notes: 'From the kitchen set',
    });
    const [row] = await own<{
      type_id: string;
      quantity: string;
      custom: Record<string, unknown>;
    }>(db, 'SELECT type_id, quantity::text AS quantity, custom FROM public.things WHERE id = $1', [
      thing.id,
    ]);
    expect(row).toEqual({
      type_id: furniture,
      quantity: '4.000',
      custom: { material: 'Pine', dimensions: '45 × 50 cm' },
    });
    const tags = await own<{ tag_id: string }>(
      db,
      'SELECT tag_id FROM public.thing_tags WHERE thing_id = $1',
      [thing.id],
    );
    expect(tags).toEqual([{ tag_id: tag }]);
  });

  it('refuses a template not shared with the location, like one that does not exist', async () => {
    const garageOnly = await template({ name: 'Garage shelf' }, [garage]);
    const res = await call(t, '/api/v1/things', {
      as: ibrahim,
      body: { locationId: home.id, placeId: home.unplacedId, name: 'X', templateId: garageOnly.id },
    });
    const random = await call(t, '/api/v1/things', {
      as: ibrahim,
      body: { locationId: home.id, placeId: home.unplacedId, name: 'X', templateId: newId() },
    });
    expect(res.statusCode).toBe(404);
    expect(answer(res)).toEqual(answer(random));
  });
});

describe('quick add: a capture with templateId', () => {
  const capture = (as: Person, over: Record<string, unknown>) =>
    call(t, '/api/v1/captures', {
      as,
      headers: { 'idempotency-key': newId() },
      body: {
        id: newId(),
        locationId: home.id,
        target: { unplaced: true },
        mode: 'thing',
        batchId: newId(),
        files: [],
        ...over,
      },
    });
  const thingOf = async (id: string) =>
    (
      await own<{
        name: string | null;
        type_id: string | null;
        model: string | null;
        colour: string | null;
        review_state: string;
        custom: Record<string, unknown>;
      }>(
        db,
        `SELECT name, type_id, model, colour, review_state, custom FROM public.things
          WHERE id = $1`,
        [id],
      )
    )[0];

  it('applies the whole payload, the typed name winning', async () => {
    const tpl = await template({
      name: 'Bookshelf',
      typeId: furniture,
      payload: { model: 'Billy', colour: 'White', custom: { material: 'Birch' } },
    });
    const typed = ok(
      await capture(louis, { name: 'Hall shelf', templateId: tpl.id }),
      201,
    ) as unknown as {
      thing: { id: string };
    };
    expect(await thingOf(typed.thing.id)).toEqual({
      name: 'Hall shelf',
      type_id: furniture,
      model: 'Billy',
      colour: 'White',
      review_state: 'confirmed',
      custom: { material: 'Birch' },
    });
    // No name typed: the template's own names the thing, which is not a draft.
    const bare = ok(await capture(louis, { templateId: tpl.id }), 201) as unknown as {
      thing: { id: string };
      inboxItemId?: string;
    };
    expect(await thingOf(bare.thing.id)).toMatchObject({
      name: 'Bookshelf',
      review_state: 'confirmed',
    });
    expect(bare.inboxItemId).toBeUndefined();
  });

  it('answers a template shared elsewhere like a random one', async () => {
    const garageOnly = await template({ name: 'Garage bin' }, [garage]);
    const res = await capture(ibrahim, { name: 'X', templateId: garageOnly.id });
    const random = await capture(ibrahim, { name: 'X', templateId: newId() });
    expect(res.statusCode).toBe(404);
    expect(answer(res)).toEqual(answer(random));
  });
});

describe('leak: the template routes answer another household exactly as nothing', () => {
  it("treats Alfred's ids like random ids on every template route", async () => {
    const res = await createTemplate(alfred, family.accountId, {
      name: 'قالب',
      payload: { model: 'X1' },
      locationIds: [family.id],
    });
    const theirs = ok(res, 201) as unknown as AccountTemplate;
    const theirThing = (await createThing(t, alfred, family, { name: 'كرسي' })).id;
    const same = async (
      mine: () => Promise<LightMyRequestResponse>,
      random: () => Promise<LightMyRequestResponse>,
    ) => {
      const a = await mine();
      const b = await random();
      expect(answer(a)).toEqual(answer(b));
      return a;
    };

    // GET /templates?locationId: his location lists nothing, like a random one.
    await same(
      () => call(t, `/api/v1/templates?locationId=${family.id}`, { as: ibrahim }),
      () => call(t, `/api/v1/templates?locationId=${newId()}`, { as: ibrahim }),
    );
    // The admin view and a create in his account.
    const acct = await same(
      () => call(t, `/api/v1/accounts/${family.accountId}/templates`, { as: ibrahim }),
      () => call(t, `/api/v1/accounts/${newId()}/templates`, { as: ibrahim }),
    );
    expect(acct.statusCode).toBe(404);
    const body = { name: 'Probe', payload: {}, locationIds: [family.id] };
    await same(
      () => createTemplate(ibrahim, family.accountId, body),
      () => createTemplate(ibrahim, newId(), body),
    );
    // Sharing one of mine into his location.
    await same(
      () => createTemplate(ibrahim, home.accountId, { ...body, locationIds: [family.id] }),
      () => createTemplate(ibrahim, home.accountId, { ...body, locationIds: [newId()] }),
    );
    // Editing and deleting his template.
    const patched = await same(
      () => patchTemplate(ibrahim, theirs.id, { name: 'Mine now' }, theirs.rowVersion),
      () => patchTemplate(ibrahim, newId(), { name: 'Mine now' }, theirs.rowVersion),
    );
    expect(patched.statusCode).toBe(404);
    await same(
      () => deleteTemplate(ibrahim, theirs.id),
      () => deleteTemplate(ibrahim, newId()),
    );
    // Saving his thing as a template, and quick add from his template.
    await same(
      () => saveAs(ibrahim, theirThing, { name: 'Probe', locationIds: [home.id] }),
      () => saveAs(ibrahim, newId(), { name: 'Probe', locationIds: [home.id] }),
    );
    const thingBody = (templateId: string) => ({
      locationId: home.id,
      placeId: home.unplacedId,
      name: 'Probe',
      templateId,
    });
    await same(
      () => call(t, '/api/v1/things', { as: ibrahim, body: thingBody(theirs.id) }),
      () => call(t, '/api/v1/things', { as: ibrahim, body: thingBody(newId()) }),
    );
    // His template is untouched, and nothing of it reached Ibrahim's lists.
    const [row] = await own<{ name: string }>(
      db,
      'SELECT name FROM public.templates WHERE id = $1',
      [theirs.id],
    );
    expect(row?.name).toBe('قالب');
    expect((await adminList(ibrahim, home.accountId)).some((x) => x.id === theirs.id)).toBe(false);
    expect((await usable(ibrahim, home)).some((x) => x.id === theirs.id)).toBe(false);
  });
});
