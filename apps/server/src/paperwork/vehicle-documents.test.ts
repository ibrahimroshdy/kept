import { newId } from '@kept/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  builtinType,
  createLocation,
  createThing,
  eventsOf,
  type Json,
  type Loc,
  ok,
  own,
} from '../../test/things.js';

// Step 5, T12 through the front door, as the web calls it (apps/web/src/api/vehicles/types.ts:
// ExpiringDocumentV5, CreateDocumentBodyV5, UpdateDocumentBodyV5, RenewDocumentBodyV5,
// DocumentsParamsV5): a document's issue date and cost (money, behind the gate), a vehicle's
// Documents tab (`thingId`), and a vehicle's documents with Paperwork or Vehicles on.

let db: TestDb;
let t: TestApp;
let ibrahim: Person; // owner of the Garage
let louis: Person; // member
let talia: Person; // viewer
let alfred: Person; // owner of بيت العائلة, a stranger to the Garage
let garage: Loc; // household: Vehicles, Paperwork, Money
let family: Loc;
let carType: string;

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  t = await peopleApp(db);
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  garage = await createLocation(t, db, ibrahim, 'household', 'Garage');
  family = await createLocation(t, db, alfred, 'household', 'بيت العائلة');
  await join(db, garage.id, louis.userId, 'member');
  await join(db, garage.id, talia.userId, 'viewer');
  carType = await builtinType(db, 'car');
});

afterAll(async () => {
  await t.app.close();
});

async function switchModule(locationId: string, module: string, enabled: boolean) {
  await own(
    db,
    `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (location_id, module) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [locationId, module, enabled],
  );
}

const cairoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
const inDays = (n: number) => {
  const d = new Date(`${cairoToday()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type Doc = Json & {
  issuedOn: string | null;
  cost?: string;
  currency?: string;
  moneyHidden?: true;
  state: string;
  rowVersion: number;
};

const create = (as: Person, body: Record<string, unknown>) =>
  call(t, '/api/v1/documents', { as, body: { id: newId(), ...body } });
const write = (
  as: Person,
  method: 'PATCH' | 'DELETE' | 'POST',
  url: string,
  rowVersion: number,
  body?: unknown,
) =>
  call(t, url, {
    as,
    method,
    headers: { 'if-match': String(rowVersion) },
    ...(body !== undefined ? { body } : {}),
  });

async function car(loc = garage, as = ibrahim): Promise<string> {
  return (await createThing(t, as, loc, { name: 'Toyota Corolla', typeId: carType })).id;
}

describe('issue dates and costs', () => {
  // catalogue: POST /api/v1/documents
  it('keeps a licence’s issue date and cost (the location’s currency by default), audited as money', async () => {
    const id = await car();
    const doc = ok(
      await create(louis, {
        subject: { thingId: id },
        kind: 'licence',
        expiresOn: inDays(23),
        leadDays: 30,
        issuedOn: inDays(-342),
        cost: '1200',
      }),
      201,
    ) as Doc;
    expect(doc).toMatchObject({
      state: 'expiring',
      issuedOn: inDays(-342),
      cost: '1200',
      currency: 'EGP',
    });
    const [event] = await eventsOf(db, garage.id, doc.id);
    expect(event?.action).toBe('document.create');
    expect(event?.diff.cost).toMatchObject({ after: '1200', class: 'money' });
    const later = ok(
      await create(louis, {
        subject: { thingId: id },
        kind: 'inspection',
        expiresOn: inDays(31),
        leadDays: 30,
      }),
      201,
    ) as Doc;
    expect(later).toMatchObject({ state: 'ok', issuedOn: null });
    expect(later).not.toHaveProperty('cost');
  });

  it('refuses an issue date after the expiry, and a currency that is off', async () => {
    const id = await car();
    const late = await create(louis, {
      subject: { thingId: id },
      kind: 'insurance',
      expiresOn: inDays(10),
      issuedOn: inDays(11),
    });
    expect(late.statusCode, late.body).toBe(400);
    const unknown = await create(louis, {
      subject: { thingId: id },
      kind: 'insurance',
      expiresOn: inDays(10),
      cost: '5',
      currency: 'JPY',
    });
    expect(unknown.statusCode, unknown.body).toBe(400);
  });

  // catalogue: POST /api/v1/documents/:id/renew
  it('renews with the new term’s own issue date and cost, audited', async () => {
    const id = await car();
    const old = ok(
      await create(louis, {
        subject: { thingId: id },
        kind: 'licence',
        expiresOn: inDays(5),
        issuedOn: inDays(-360),
        cost: '1100',
      }),
      201,
    ) as Doc;
    const out = ok(
      await write(louis, 'POST', `/api/v1/documents/${old.id}/renew`, old.rowVersion, {
        expiresOn: inDays(370),
        issuedOn: inDays(0),
        cost: '1250.5',
      }),
    ) as unknown as { renewed: Doc; previous: Doc };
    expect(out.renewed).toMatchObject({ issuedOn: inDays(0), cost: '1250.5', currency: 'EGP' });
    expect(out.previous).toMatchObject({ issuedOn: inDays(-360), cost: '1100' });
    const events = await eventsOf(db, garage.id, old.id);
    expect(events.at(-1)?.action).toBe('document.renew');
    expect(events.at(-1)?.diff.renewed_cost).toMatchObject({ after: '1250.5', class: 'money' });
  });

  // catalogue: PATCH /api/v1/documents/:id
  it('edits the cost with If-Match, audited, and undo puts it back', async () => {
    const id = await car();
    const doc = ok(
      await create(louis, {
        subject: { thingId: id },
        kind: 'insurance',
        expiresOn: inDays(200),
        issuedOn: inDays(-165),
        cost: '3500',
      }),
      201,
    ) as Doc;
    const edited = ok(
      await write(louis, 'PATCH', `/api/v1/documents/${doc.id}`, doc.rowVersion, {
        cost: '3600',
        currency: 'usd',
      }),
    ) as Doc;
    expect(edited).toMatchObject({ cost: '3600', currency: 'USD', rowVersion: 2 });
    const update = (await eventsOf(db, garage.id, doc.id)).find(
      (e) => e.action === 'document.update',
    );
    expect(update?.diff).toMatchObject({
      cost: { before: '3500', after: '3600', class: 'money' },
      currency: { before: 'EGP', after: 'USD' },
    });
    ok(await call(t, `/api/v1/audit/${update?.id}/undo`, { as: louis, body: {} }));
    const back = ok(await call(t, `/api/v1/documents/${doc.id}`, { as: louis })) as Doc;
    expect(back).toMatchObject({ cost: '3500', currency: 'EGP' });
  });
});

describe('the money gate', () => {
  it('shows a viewer the issue date and no cost; a member with Money off writes no cost', async () => {
    const id = await car();
    const doc = ok(
      await create(louis, {
        subject: { thingId: id },
        kind: 'insurance',
        expiresOn: inDays(100),
        issuedOn: inDays(-5),
        cost: '900',
      }),
      201,
    ) as Doc;
    const seen = ok(await call(t, `/api/v1/documents/${doc.id}`, { as: talia })) as Doc;
    expect(seen).toMatchObject({ issuedOn: inDays(-5), moneyHidden: true });
    expect(seen).not.toHaveProperty('cost');
    expect(seen).not.toHaveProperty('currency');
    await switchModule(garage.id, 'money', false);
    try {
      const refused = await write(louis, 'PATCH', `/api/v1/documents/${doc.id}`, doc.rowVersion, {
        cost: '1',
      });
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toMatchObject({ code: 'module_off' });
      // Its dates still change; its cost stays as it was.
      ok(
        await write(louis, 'PATCH', `/api/v1/documents/${doc.id}`, doc.rowVersion, {
          leadDays: 14,
        }),
      );
      const [row] = await own<{ cost: string }>(
        db,
        'SELECT trim_scale(cost)::text AS cost FROM public.expiring_documents WHERE id = $1',
        [doc.id],
      );
      expect(row?.cost).toBe('900');
    } finally {
      await switchModule(garage.id, 'money', true);
    }
  });
});

describe('a vehicle’s documents', () => {
  it('lists one thing’s documents for its Documents tab (thingId)', async () => {
    const a = await car();
    const b = await car();
    await create(louis, { subject: { thingId: a }, kind: 'licence', expiresOn: inDays(40) });
    await create(louis, { subject: { thingId: b }, kind: 'licence', expiresOn: inDays(41) });
    const page = ok(await call(t, `/api/v1/documents?thingId=${a}`, { as: talia })) as unknown as {
      items: Doc[];
    };
    expect(page.items.map((d) => (d.subject as { id: string }).id)).toEqual([a]);
  });

  it('with Paperwork off and Vehicles on, keeps working for a vehicle and nothing else', async () => {
    const id = await car();
    const kettle = (await createThing(t, ibrahim, garage, { name: 'Kettle' })).id;
    await switchModule(garage.id, 'paperwork', false);
    try {
      const doc = ok(
        await create(louis, { subject: { thingId: id }, kind: 'licence', expiresOn: inDays(60) }),
        201,
      ) as Doc;
      ok(await call(t, `/api/v1/documents/${doc.id}`, { as: talia }));
      const tab = ok(
        await call(t, `/api/v1/documents?thingId=${id}`, { as: talia }),
      ) as unknown as {
        items: Doc[];
      };
      expect(tab.items.map((d) => d.id)).toEqual([doc.id]);
      const all = ok(await call(t, '/api/v1/documents', { as: louis })) as unknown as {
        items: Doc[];
      };
      expect(all.items.map((d) => d.id)).toContain(doc.id);
      const renewed = ok(
        await write(louis, 'POST', `/api/v1/documents/${doc.id}/renew`, doc.rowVersion, {
          expiresOn: inDays(420),
        }),
      ) as unknown as { renewed: Doc };
      expect(renewed.renewed.expiresOn).toBe(inDays(420));
      const other = await create(louis, {
        subject: { thingId: kettle },
        kind: 'other',
        title: 'Warranty card',
        expiresOn: inDays(60),
      });
      expect(other.statusCode).toBe(409);
      expect(other.json()).toMatchObject({ code: 'module_off' });
      const kettleTab = await call(t, `/api/v1/documents?thingId=${kettle}`, { as: louis });
      expect(kettleTab.statusCode).toBe(404);
      expect(kettleTab.json()).toMatchObject({ code: 'module_off' });
      await switchModule(garage.id, 'vehicles', false);
      const gone = await call(t, `/api/v1/documents/${doc.id}`, { as: louis });
      expect(gone.statusCode).toBe(404);
      expect(gone.json()).toMatchObject({ code: 'module_off' });
    } finally {
      await switchModule(garage.id, 'paperwork', true);
      await switchModule(garage.id, 'vehicles', true);
    }
  });

  it('is a 404 for a document on another household’s car', async () => {
    const theirs = await car(family, alfred);
    const doc = ok(
      await create(alfred, {
        subject: { thingId: theirs },
        kind: 'licence',
        expiresOn: inDays(30),
      }),
      201,
    ) as Doc;
    expect((await call(t, `/api/v1/documents/${doc.id}`, { as: louis })).statusCode).toBe(404);
    expect((await call(t, `/api/v1/documents?thingId=${theirs}`, { as: louis })).statusCode).toBe(
      404,
    );
    const w = await write(louis, 'PATCH', `/api/v1/documents/${doc.id}`, 1, { cost: '1' });
    expect(w.statusCode).toBe(404);
  });
});
