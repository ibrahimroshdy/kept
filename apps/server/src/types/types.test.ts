import { newId } from '@kept/shared';
import type pg from 'pg';
import { beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { ownerTx } from '../../test/tenancy.js';

// Task 11 through the front door: types, their fields and place kinds, as the web's type editor
// calls them (apps/web/src/api/inventory/{types,paths}.ts and mock/registries.ts).
//
// The household: Bob owns an account with "Bob home" and "Bob cabin". Adam administers Bob home
// only, so he manages the account's types without seeing all of it (D123); Mel is a member and
// Vic a viewer there. Ann has her own account and sees nothing of Bob's.

let db: TestDb;
let t: TestApp;
const sent: RecordedJob[] = [];
let ann: Person;
let bob: Person;
let adam: Person;
let mel: Person;
let vic: Person;
let bobAccount: string;
let home: string;
let cabin: string;

type Field = {
  id: string;
  key: string;
  label: string | null;
  labelKey: string | null;
  kind: string;
  secret: boolean;
  required: boolean;
  archivedAt: string | null;
  source: { typeId: string; via: string };
  rowVersion: number;
};
type Detail = {
  id: string;
  parentId: string | null;
  builtinKey: string | null;
  name: string | null;
  capabilities: string[];
  resolvedCapabilities: string[];
  copiedFromId: string | null;
  inUse: number;
  rowVersion: number;
  fields: Field[];
};

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

async function builtin(key: string): Promise<string> {
  const [row] = await own<{ id: string }>(
    'SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $1',
    [key],
  );
  return row?.id as string;
}

async function thing(locationId: string, typeId: string): Promise<string> {
  const id = newId();
  await own(
    `INSERT INTO public.things (id, location_id, place_id, name, type_id)
     VALUES ($1, $2, (SELECT id FROM public.places WHERE location_id = $2 AND is_unplaced), 'Thing', $3)`,
    [id, locationId, typeId],
  );
  return id;
}

function accountAudit(
  entityId: string,
): Promise<
  { action: string; location_id: string | null; actor_id: string; diff: Record<string, unknown> }[]
> {
  return own(
    `SELECT action, location_id, actor_id, diff FROM public.audit_events
      WHERE owner_account_id = $1 AND entity_id = $2 ORDER BY at, id`,
    [bobAccount, entityId],
  );
}

async function createType(as: Person, body: object): Promise<Detail> {
  const res = await call(t, `/api/v1/accounts/${bobAccount}/types`, { as, body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as Detail;
}

const gadget = (name: string, parentId: string | null = null) => ({
  parentId,
  name,
  icon: 'lucide:box',
  capabilities: [],
});

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db, { sent });
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  adam = await person(t, db, 'adam');
  mel = await person(t, db, 'mel');
  vic = await person(t, db, 'vic');
  const [acct] = await own<{ id: string }>(
    'SELECT id FROM public.owner_accounts WHERE user_id = $1',
    [bob.userId],
  );
  bobAccount = acct?.id as string;
  home = await createLocation(bob, 'Bob home');
  cabin = await createLocation(bob, 'Bob cabin');
  await join(db, home, adam.userId, 'admin');
  await join(db, home, mel.userId, 'member');
  await join(db, home, vic.userId, 'viewer');
});

describe('reading types', () => {
  it('lists the built-ins and the account’s own, with capabilities and use counts', async () => {
    const phone = await builtin('phone');
    await thing(home, phone);
    const res = await call(t, `/api/v1/accounts/${bobAccount}/types`, { as: vic });
    expect(res.statusCode, res.body).toBe(200);
    const { types } = res.json() as {
      types: (Detail & { isFieldGroup: boolean; fields?: unknown })[];
    };
    const node = types.find((x) => x.id === phone);
    expect(node).toMatchObject({ builtinKey: 'phone', name: null, copiedFromId: null, inUse: 1 });
    expect(node?.resolvedCapabilities).toEqual(expect.arrayContaining(['warranty', 'serialized']));
    expect(node?.fields).toBeUndefined();
    expect(types.find((x) => x.builtinKey === 'device')?.isFieldGroup).toBe(true);
    expect((await call(t, `/api/v1/accounts/${bobAccount}/types`, { as: ann })).statusCode).toBe(
      404,
    );
    const withArchived = await call(
      t,
      `/api/v1/accounts/${bobAccount}/types?includeArchived=true`,
      {
        as: vic,
      },
    );
    expect(withArchived.statusCode, withArchived.body).toBe(200);
  });

  it('resolves a type’s fields along its chain and field groups, translated by key', async () => {
    const res = await call(t, `/api/v1/types/${await builtin('phone')}`, { as: mel });
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json() as Detail;
    const imei = detail.fields.find((f) => f.key === 'imei');
    expect(imei).toMatchObject({ label: null, labelKey: 'imei', source: { via: 'own' } });
    expect(typeof imei?.rowVersion).toBe('number');
    const os = detail.fields.find((f) => f.key === 'os');
    expect(os?.source.via).toBe('group');
    expect(detail.fields.find((f) => f.key === 'linked_account')?.secret).toBe(true);
  });
});

describe('writing types', () => {
  // catalogue: POST /api/v1/accounts/:accountId/types
  it('an admin creates one under a built-in, audited on the account; members and viewers get 403', async () => {
    const electronics = await builtin('electronics');
    const created = await createType(adam, {
      ...gadget('Drone', electronics),
      capabilities: ['metered'],
      colour: '#112233',
      defaultMeter: { kind: 'hours', unit: 'h' },
    });
    expect(created).toMatchObject({
      name: 'Drone',
      parentId: electronics,
      builtinKey: null,
      capabilities: ['metered'],
      rowVersion: 1,
    });
    expect(created.resolvedCapabilities).toEqual(expect.arrayContaining(['warranty', 'metered']));
    const audit = await accountAudit(created.id);
    expect(audit).toMatchObject([
      { action: 'type.create', location_id: null, actor_id: adam.userId },
    ]);
    for (const as of [mel, vic]) {
      const res = await call(t, `/api/v1/accounts/${bobAccount}/types`, {
        as,
        body: gadget('Nope'),
      });
      expect(res.statusCode).toBe(403);
    }
    const byAnn = await call(t, `/api/v1/accounts/${bobAccount}/types`, {
      as: ann,
      body: gadget('Nope'),
    });
    expect(byAnn.statusCode).toBe(404);
    expect((await call(t, `/api/v1/types/${created.id}`, { as: ann })).statusCode).toBe(404);
  });

  // catalogue: PATCH /api/v1/types/:id
  it('renames with If-Match, audited, and reindexes where things use it', async () => {
    const lamp = await createType(bob, gadget('Lamp'));
    await thing(cabin, lamp.id);
    sent.length = 0;
    const res = await call(t, `/api/v1/types/${lamp.id}`, {
      as: adam,
      method: 'PATCH',
      body: { name: 'Lamps', icon: 'lucide:lamp' },
      headers: { 'if-match': '1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Lamps', rowVersion: 2 });
    expect((await accountAudit(lamp.id)).at(-1)).toMatchObject({
      action: 'type.update',
      diff: { name: { before: 'Lamp', after: 'Lamps' }, icon: { after: 'lucide:lamp' } },
    });
    expect(sent.map((j) => j.data)).toEqual([{ locationId: cabin }]);

    const stale = await call(t, `/api/v1/types/${lamp.id}`, {
      as: bob,
      method: 'PATCH',
      body: { colour: '#000000' },
      headers: { 'if-match': '1' },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json()).toMatchObject({ conflicts: ['colour'], row_version: 2 });
    expect((stale.json() as { changedBy: { displayName: string } }).changedBy.displayName).toMatch(
      /^adam-/,
    );
    const bare = await call(t, `/api/v1/types/${lamp.id}`, {
      as: bob,
      method: 'PATCH',
      body: { colour: '#000000' },
    });
    expect(bare.statusCode).toBe(428);
  });

  it('refuses a loop with reason cycle, and editing a built-in with reason builtin', async () => {
    const outer = await createType(bob, gadget('Outer'));
    const inner = await createType(bob, gadget('Inner', outer.id));
    const res = await call(t, `/api/v1/types/${outer.id}`, {
      as: bob,
      method: 'PATCH',
      body: { parentId: inner.id },
      headers: { 'if-match': '1' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ code: 'conflict', reason: 'cycle' });
    expect(res.json()).toHaveProperty('hint');

    const phone = await builtin('phone');
    const builtinEdit = await call(t, `/api/v1/types/${phone}`, {
      as: bob,
      method: 'PATCH',
      body: { name: 'Mobile' },
      headers: { 'if-match': '1' },
    });
    expect(builtinEdit.statusCode).toBe(409);
    expect(builtinEdit.json()).toMatchObject({ reason: 'builtin' });
  });

  // catalogue: POST /api/v1/types/:id/fields
  it('adds a field, audited; a key inherited or defined below is 409 field_redefined', async () => {
    const phoneChild = await createType(bob, gadget('Rugged phone', await builtin('phone')));
    const dupe = await call(t, `/api/v1/types/${phoneChild.id}/fields`, {
      as: adam,
      body: { key: 'imei', label: 'IMEI', kind: 'text' },
    });
    expect(dupe.statusCode, dupe.body).toBe(409);
    expect(dupe.json()).toMatchObject({ reason: 'field_redefined', key: 'imei' });
    const fromGroup = await call(t, `/api/v1/types/${phoneChild.id}/fields`, {
      as: adam,
      body: { key: 'firmware', label: 'Firmware', kind: 'text' },
    });
    expect(fromGroup.json()).toMatchObject({ reason: 'field_redefined', key: 'firmware' });

    const res = await call(t, `/api/v1/types/${phoneChild.id}/fields`, {
      as: adam,
      body: { key: 'ip_rating', label: 'IP rating', kind: 'select', options: ['IP67', 'IP68'] },
    });
    expect(res.statusCode, res.body).toBe(201);
    const field = res.json() as Field;
    expect(field).toMatchObject({
      key: 'ip_rating',
      label: 'IP rating',
      labelKey: null,
      kind: 'select',
      secret: false,
      rowVersion: 1,
      source: { typeId: phoneChild.id, via: 'own' },
    });
    expect(await accountAudit(field.id)).toMatchObject([{ action: 'type_field.create' }]);

    // A parent may not add a key a child already has.
    const parent = await createType(bob, gadget('Parent'));
    const child = await createType(bob, gadget('Child', parent.id));
    await call(t, `/api/v1/types/${child.id}/fields`, {
      as: bob,
      body: { key: 'size', label: 'Size', kind: 'text' },
    });
    const clash = await call(t, `/api/v1/types/${parent.id}/fields`, {
      as: bob,
      body: { key: 'size', label: 'Size', kind: 'text' },
    });
    expect(clash.json()).toMatchObject({ reason: 'field_redefined', key: 'size' });
    // … and re-parenting may not bring two together.
    const other = await createType(bob, gadget('Other'));
    await call(t, `/api/v1/types/${other.id}/fields`, {
      as: bob,
      body: { key: 'size', label: 'Size', kind: 'text' },
    });
    const move = await call(t, `/api/v1/types/${child.id}`, {
      as: bob,
      method: 'PATCH',
      body: { parentId: other.id },
      headers: { 'if-match': '1' },
    });
    expect(move.statusCode).toBe(409);
    expect(move.json()).toMatchObject({ reason: 'field_redefined', key: 'size' });
  });

  it('makes a field secret for the account owner only, and only a text field (D177)', async () => {
    const vault = await createType(bob, gadget('Router'));
    const byAdam = await call(t, `/api/v1/types/${vault.id}/fields`, {
      as: adam,
      body: { key: 'admin_password', label: 'Admin password', kind: 'text', secret: true },
    });
    expect(byAdam.statusCode).toBe(403);
    const notText = await call(t, `/api/v1/types/${vault.id}/fields`, {
      as: bob,
      body: { key: 'pin', label: 'PIN', kind: 'number', secret: true },
    });
    expect(notText.statusCode).toBe(400);
    const res = await call(t, `/api/v1/types/${vault.id}/fields`, {
      as: bob,
      body: { key: 'admin_password', label: 'Admin password', kind: 'text', secret: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ secret: true });
  });

  // catalogue: PATCH /api/v1/type-fields/:id
  it('edits a field with If-Match, audited; a stale one is 412 with who changed it', async () => {
    const type = await createType(bob, gadget('Plant'));
    const created = (
      await call(t, `/api/v1/types/${type.id}/fields`, {
        as: bob,
        body: { key: 'water', label: 'Water', kind: 'text' },
      })
    ).json() as Field;
    const res = await call(t, `/api/v1/type-fields/${created.id}`, {
      as: adam,
      method: 'PATCH',
      body: { label: 'Watering', required: true },
      headers: { 'if-match': String(created.rowVersion) },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ label: 'Watering', required: true, rowVersion: 2 });
    expect((await accountAudit(created.id)).at(-1)).toMatchObject({
      action: 'type_field.update',
      diff: { label: { before: 'Water', after: 'Watering' } },
    });
    const stale = await call(t, `/api/v1/type-fields/${created.id}`, {
      as: bob,
      method: 'PATCH',
      body: { unit: 'ml' },
      headers: { 'if-match': '1' },
    });
    expect(stale.statusCode).toBe(412);
    expect((stale.json() as { changedBy: { displayName: string } }).changedBy.displayName).toMatch(
      /^adam-/,
    );
    const byMel = await call(t, `/api/v1/type-fields/${created.id}`, {
      as: mel,
      method: 'PATCH',
      body: { unit: 'ml' },
      headers: { 'if-match': '2' },
    });
    expect(byMel.statusCode).toBe(403);
  });

  // catalogue: POST /api/v1/type-fields/:id/archive
  it('archives a field (never deletes it), audited', async () => {
    const type = await createType(bob, gadget('Book'));
    const f = (
      await call(t, `/api/v1/types/${type.id}/fields`, {
        as: bob,
        body: { key: 'isbn', label: 'ISBN', kind: 'text' },
      })
    ).json() as Field;
    const res = await call(t, `/api/v1/type-fields/${f.id}/archive`, { as: adam, method: 'POST' });
    expect(res.statusCode, res.body).toBe(204);
    const detail = (await call(t, `/api/v1/types/${type.id}`, { as: vic })).json() as Detail;
    expect(detail.fields.find((x) => x.key === 'isbn')?.archivedAt).not.toBeNull();
    expect((await accountAudit(f.id)).at(-1)?.action).toBe('type_field.archive');
  });

  // catalogue: POST /api/v1/type-fields/:id/restore
  it('restores an archived field, audited', async () => {
    const type = await createType(bob, gadget('Record'));
    const f = (
      await call(t, `/api/v1/types/${type.id}/fields`, {
        as: bob,
        body: { key: 'label_name', label: 'Label', kind: 'text' },
      })
    ).json() as Field;
    await call(t, `/api/v1/type-fields/${f.id}/archive`, { as: bob, method: 'POST' });
    const res = await call(t, `/api/v1/type-fields/${f.id}/restore`, { as: bob, method: 'POST' });
    expect(res.statusCode).toBe(204);
    const detail = (await call(t, `/api/v1/types/${type.id}`, { as: bob })).json() as Detail;
    expect(detail.fields.find((x) => x.key === 'label_name')?.archivedAt).toBeNull();
    expect((await accountAudit(f.id)).map((a) => a.action)).toEqual([
      'type_field.create',
      'type_field.archive',
      'type_field.restore',
    ]);
  });

  it('shows the impact of a change, counting hidden locations without naming them', async () => {
    const tools = await createType(bob, gadget('Tools'));
    const drills = await createType(bob, gadget('Drills', tools.id));
    await call(t, `/api/v1/types/${tools.id}/fields`, {
      as: bob,
      body: { key: 'voltage', label: 'Voltage', kind: 'number' },
    });
    await thing(home, tools.id);
    await thing(home, drills.id);
    await thing(cabin, drills.id);
    const res = await call(t, `/api/v1/types/${drills.id}/preview`, {
      as: adam,
      body: { parentId: null },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      descendants: [],
      perLocation: [{ locationId: home, name: 'Bob home', things: 1 }],
      hiddenLocations: 1,
      fieldsToArchive: ['voltage'],
    });
    const forTools = (
      await call(t, `/api/v1/types/${tools.id}/preview`, { as: bob, body: {} })
    ).json() as {
      descendants: { id: string; name: string; builtinKey: string | null }[];
      perLocation: { locationId: string; things: number }[];
      hiddenLocations: number;
    };
    expect(forTools.descendants).toEqual([{ id: drills.id, name: 'Drills', builtinKey: null }]);
    expect(forTools.hiddenLocations).toBe(0);
    expect(forTools.perLocation.map((p) => p.things).sort()).toEqual([1, 2]);
  });

  // catalogue: POST /api/v1/types/:id/customise
  it('customises a built-in, repointing things in locations the admin can’t see, audited once', async () => {
    const phone = await builtin('phone');
    const hidden = await thing(cabin, phone);
    const byMel = await call(t, `/api/v1/types/${phone}/customise`, {
      as: mel,
      body: { accountId: bobAccount },
    });
    expect(byMel.statusCode).toBe(403);
    const res = await call(t, `/api/v1/types/${phone}/customise`, {
      as: adam,
      body: { accountId: bobAccount },
    });
    expect(res.statusCode, res.body).toBe(200);
    const { typeId } = res.json() as { typeId: string };
    expect(typeId).not.toBe(phone);
    // Checked as the owner: Adam can't see the cabin.
    const [row] = await own<{ type_id: string }>(
      'SELECT type_id FROM public.things WHERE id = $1',
      [hidden],
    );
    expect(row?.type_id).toBe(typeId);
    const copy = (await call(t, `/api/v1/types/${typeId}`, { as: adam })).json() as Detail;
    expect(copy).toMatchObject({ builtinKey: 'phone', name: null, copiedFromId: phone });
    expect(copy.fields.find((f) => f.key === 'imei')?.source.via).toBe('own');
    expect(await accountAudit(typeId)).toMatchObject([{ action: 'type.customise' }]);

    const again = await call(t, `/api/v1/types/${phone}/customise`, {
      as: bob,
      body: { accountId: bobAccount },
    });
    expect(again.json()).toEqual({ typeId });
    expect(await accountAudit(typeId)).toHaveLength(1);
    const notBuiltin = await call(t, `/api/v1/types/${typeId}/customise`, {
      as: bob,
      body: { accountId: bobAccount },
    });
    expect(notBuiltin.statusCode).toBe(409);
  });

  // catalogue: POST /api/v1/types/:id/merge-into
  it('merges one type into another, moving its things and children, audited', async () => {
    const from = await createType(bob, gadget('Speakers'));
    const into = await createType(bob, gadget('Audio'));
    const child = await createType(bob, gadget('Soundbars', from.id));
    const a = await thing(cabin, from.id);
    const res = await call(t, `/api/v1/types/${from.id}/merge-into`, {
      as: adam,
      body: { targetId: into.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ repointed: 1 });
    const [row] = await own<{ type_id: string }>(
      'SELECT type_id FROM public.things WHERE id = $1',
      [a],
    );
    expect(row?.type_id).toBe(into.id);
    const moved = (await call(t, `/api/v1/types/${child.id}`, { as: adam })).json() as Detail;
    expect(moved.parentId).toBe(into.id);
    expect((await accountAudit(from.id)).at(-1)).toMatchObject({ action: 'type.merge' });
    expect((await call(t, `/api/v1/types/${from.id}`, { as: adam })).statusCode).toBe(404);

    const under = await createType(bob, gadget('Under', into.id));
    const loop = await call(t, `/api/v1/types/${into.id}/merge-into`, {
      as: bob,
      body: { targetId: under.id },
    });
    expect(loop.statusCode).toBe(409);
    expect(loop.json()).toMatchObject({ reason: 'cycle' });
  });

  // catalogue: DELETE /api/v1/types/:id
  it('deletes an unused type, audited; one in use anywhere in the account is 409 in_use', async () => {
    const used = await createType(bob, gadget('Kettles'));
    await thing(cabin, used.id);
    const refused = await call(t, `/api/v1/types/${used.id}`, { as: adam, method: 'DELETE' });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'in_use', reason: 'in_use' });
    const parent = await createType(bob, gadget('Parents'));
    await createType(bob, gadget('Kids', parent.id));
    expect(
      (await call(t, `/api/v1/types/${parent.id}`, { as: adam, method: 'DELETE' })).statusCode,
    ).toBe(409);

    const spare = await createType(bob, gadget('Spare'));
    expect(
      (await call(t, `/api/v1/types/${spare.id}`, { as: mel, method: 'DELETE' })).statusCode,
    ).toBe(403);
    const res = await call(t, `/api/v1/types/${spare.id}`, { as: adam, method: 'DELETE' });
    expect(res.statusCode, res.body).toBe(204);
    expect((await accountAudit(spare.id)).map((a) => a.action)).toEqual([
      'type.create',
      'type.delete',
    ]);
  });
});

describe('place kinds (D160)', () => {
  type Kind = {
    id: string;
    key: string;
    builtinKey: string | null;
    ownerAccountId: string | null;
    name: string | null;
    rowVersion: number;
    fields: Field[];
  };
  const kinds = async (as: Person) => {
    const res = await call(t, `/api/v1/accounts/${bobAccount}/place-kinds`, { as });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { placeKinds: Kind[] }).placeKinds;
  };

  // catalogue: POST /api/v1/accounts/:accountId/place-kinds
  it('lists the built-ins; an admin adds a kind, audited; a taken key is 409', async () => {
    const list = await kinds(vic);
    expect(
      list
        .map((k) => k.builtinKey)
        .filter(Boolean)
        .sort(),
    ).toEqual(['closet', 'floor', 'room', 'zone']);
    const res = await call(t, `/api/v1/accounts/${bobAccount}/place-kinds`, {
      as: adam,
      body: { key: 'shed', name: 'Shed', icon: 'lucide:warehouse' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const shed = res.json() as Kind;
    expect(shed).toMatchObject({
      key: 'shed',
      builtinKey: null,
      ownerAccountId: bobAccount,
      name: 'Shed',
      fields: [],
      rowVersion: 1,
    });
    expect(await accountAudit(shed.id)).toMatchObject([{ action: 'place_kind.create' }]);
    const room = list.find((k) => k.key === 'room');
    const taken = await call(t, `/api/v1/accounts/${bobAccount}/place-kinds`, {
      as: adam,
      body: { key: 'room', name: 'Room', icon: 'lucide:door-open' },
    });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ existingId: room?.id });
    const byMel = await call(t, `/api/v1/accounts/${bobAccount}/place-kinds`, {
      as: mel,
      body: { key: 'attic', name: 'Attic', icon: 'lucide:house' },
    });
    expect(byMel.statusCode).toBe(403);
  });

  // catalogue: PATCH /api/v1/place-kinds/:id
  it('renames an account kind with If-Match, audited; a built-in is 409 builtin', async () => {
    const created = (
      await call(t, `/api/v1/accounts/${bobAccount}/place-kinds`, {
        as: bob,
        body: { key: 'loft', name: 'Loft', icon: 'lucide:layers' },
      })
    ).json() as Kind;
    const res = await call(t, `/api/v1/place-kinds/${created.id}`, {
      as: adam,
      method: 'PATCH',
      body: { name: 'Attic loft' },
      headers: { 'if-match': '1' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ name: 'Attic loft', rowVersion: 2 });
    expect((await accountAudit(created.id)).at(-1)?.action).toBe('place_kind.update');
    const room = (await kinds(bob)).find((k) => k.key === 'floor') as Kind;
    const builtinEdit = await call(t, `/api/v1/place-kinds/${room.id}`, {
      as: bob,
      method: 'PATCH',
      body: { name: 'Level' },
      headers: { 'if-match': '1' },
    });
    expect(builtinEdit.statusCode).toBe(409);
    expect(builtinEdit.json()).toMatchObject({ reason: 'builtin' });
  });

  // catalogue: POST /api/v1/place-kinds/:id/fields
  it('adds a field to an account kind, audited; a key twice is 409', async () => {
    const created = (
      await call(t, `/api/v1/accounts/${bobAccount}/place-kinds`, {
        as: bob,
        body: { key: 'pantry', name: 'Pantry', icon: 'lucide:box' },
      })
    ).json() as Kind;
    const res = await call(t, `/api/v1/place-kinds/${created.id}/fields`, {
      as: adam,
      body: { key: 'shelves', label: 'Shelves', kind: 'number' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const field = res.json() as Field;
    expect(field).toMatchObject({ key: 'shelves', source: { typeId: created.id, via: 'own' } });
    expect(await accountAudit(field.id)).toMatchObject([{ action: 'type_field.create' }]);
    const again = await call(t, `/api/v1/place-kinds/${created.id}/fields`, {
      as: adam,
      body: { key: 'shelves', label: 'Shelves', kind: 'number' },
    });
    expect(again.json()).toMatchObject({ reason: 'field_redefined', key: 'shelves' });
    const listed = (await kinds(vic)).find((k) => k.id === created.id);
    expect(listed?.fields.map((f) => f.key)).toEqual(['shelves']);
  });

  // catalogue: POST /api/v1/accounts/:accountId/place-kinds/:builtinKey/customise
  it('customises a built-in kind once, audited; the copy stands in for it and takes fields', async () => {
    const before = (await kinds(bob)).find((k) => k.key === 'room') as Kind;
    // A built-in has no owner account; the account's copy says whose it is.
    expect(before).toMatchObject({ builtinKey: 'room', ownerAccountId: null });
    const byMel = await call(t, `/api/v1/accounts/${bobAccount}/place-kinds/room/customise`, {
      as: mel,
      method: 'POST',
    });
    expect(byMel.statusCode).toBe(403);
    const res = await call(t, `/api/v1/accounts/${bobAccount}/place-kinds/room/customise`, {
      as: adam,
      method: 'POST',
    });
    expect(res.statusCode, res.body).toBe(200);
    const { placeKindId } = res.json() as { placeKindId: string };
    expect(placeKindId).not.toBe(before.id);
    const rooms = (await kinds(vic)).filter((k) => k.key === 'room');
    expect(rooms).toEqual([
      expect.objectContaining({
        id: placeKindId,
        builtinKey: 'room',
        name: null,
        ownerAccountId: bobAccount,
      }),
    ]);
    expect(await accountAudit(placeKindId)).toMatchObject([{ action: 'place_kind.customise' }]);
    const again = await call(t, `/api/v1/accounts/${bobAccount}/place-kinds/room/customise`, {
      as: bob,
      method: 'POST',
    });
    expect(again.json()).toEqual({ placeKindId });
    const field = await call(t, `/api/v1/place-kinds/${placeKindId}/fields`, {
      as: bob,
      body: { key: 'paint', label: 'Paint colour', kind: 'text' },
    });
    expect(field.statusCode, field.body).toBe(201);
    expect(
      (
        await call(t, `/api/v1/accounts/${bobAccount}/place-kinds/garage/customise`, {
          as: bob,
          method: 'POST',
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('route security review (step 2): types', () => {
  it('previews a change only for those who may make it: 403 for a member or viewer, 404 outside', async () => {
    const shelf = await createType(bob, gadget('Review shelf'));
    for (const as of [mel, vic]) {
      const res = await call(t, `/api/v1/types/${shelf.id}/preview`, { as, body: {} });
      expect(res.statusCode, res.body).toBe(403);
    }
    const outside = await call(t, `/api/v1/types/${shelf.id}/preview`, { as: ann, body: {} });
    expect(outside.statusCode).toBe(404);
    const byAdmin = await call(t, `/api/v1/types/${shelf.id}/preview`, { as: adam, body: {} });
    expect(byAdmin.statusCode, byAdmin.body).toBe(200);
  });
});
