import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles } from '../../test/files.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import {
  createLocation,
  createThing,
  eventsOf,
  type Loc,
  ok,
  own,
  place,
} from '../../test/things.js';

// T12 through the front door: the paperwork library and expiring documents, as the web calls
// them (apps/web/src/api/household/{types,paths}.ts and mock/paperwork.ts). Rows the routes
// don't make (files and their text) are seeded as kept_owner.
//
// Ibrahim owns Home and Garage (both Household). In Home, Louis is a member and Talia a viewer
// (viewers don't see money there). Garage has Paperwork switched off. Alfred has a location of
// his own and shares nothing with them.

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ibrahim: Person;
let louis: Person;
let talia: Person;
let alfred: Person;
let home: Loc;
let garage: Loc;
let alfreds: Loc;

type Subject = { type: string; id: string; name: string; path: string; shortCode?: string | null };
type Doc = {
  id: string;
  locationId: string;
  subject: Subject;
  kind: string;
  title: string | null;
  expiresOn: string;
  leadDays: number;
  state: string;
  supersededById: string | null;
  history: { id: string; expiresOn: string }[];
  documents: { id: string; role: string; subject: Record<string, string> }[];
  rowVersion: number;
};
type Row = {
  attachment: { id: string; role: string; file: { id: string } | null };
  subject: Subject;
  expiring?: { id: string; kind: string; expiresOn: string; state: string };
  snippet?: string;
};
type Page<T> = { items: T[]; next_cursor: string | null };

const cairoToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

async function switchModule(locationId: string, module: string, enabled: boolean) {
  await own(
    db,
    `INSERT INTO public.location_modules (location_id, module, enabled) VALUES ($1, $2, $3)
     ON CONFLICT (location_id, module) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [locationId, module, enabled],
  );
}

/** A PDF file row uploaded by `by`, with the text the pdf-text job would have read. */
async function pdf(loc: Loc, by: Person, text: string): Promise<string> {
  const id = newId();
  const sha = createHash('sha256').update(id).digest('hex');
  await own(
    db,
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by)
     VALUES ($1, $2, $3, $4, 100, 'application/pdf', 'document', 'not_applicable', $5)`,
    [id, loc.id, `f/${loc.id}/${id}`, sha, by.userId],
  );
  await own(
    db,
    `INSERT INTO public.file_text (file_id, location_id, source, text) VALUES ($1, $2, 'pdf', $3)`,
    [id, loc.id, text],
  );
  return id;
}

async function attach(
  as: Person,
  loc: Loc,
  fileId: string,
  subject: Record<string, unknown>,
  role: string,
): Promise<string> {
  return ok(
    await call(t, '/api/v1/attachments', {
      as,
      body: { locationId: loc.id, fileId, subject, role },
    }),
    201,
  ).id;
}

async function createDoc(as: Person, body: Record<string, unknown>): Promise<Doc> {
  return ok(await call(t, '/api/v1/documents', { as, body }), 201) as unknown as Doc;
}

async function docs(as: Person, query = ''): Promise<Doc[]> {
  return (ok(await call(t, `/api/v1/documents${query}`, { as })) as unknown as Page<Doc>).items;
}

async function library(as: Person, query = ''): Promise<Row[]> {
  return (ok(await call(t, `/api/v1/paperwork${query}`, { as })) as unknown as Page<Row>).items;
}

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
    ...(body === undefined ? {} : { body }),
    headers: { 'if-match': String(rowVersion) },
  });

const undo = (as: Person, eventId: string) =>
  call(t, `/api/v1/audit/${eventId}/undo`, { as, method: 'POST', body: {} });

const auditHeader = (res: { headers: Record<string, unknown> }) =>
  String(res.headers['x-kept-audit-event'] ?? '');

beforeAll(async () => {
  db = await testDb();
  files = await testFiles();
  t = await peopleApp(db, { files });
});

afterAll(async () => {
  await files.cleanup();
});

beforeEach(async () => {
  await db.reset();
  ibrahim = await person(t, db, 'ibrahim');
  louis = await person(t, db, 'louis');
  talia = await person(t, db, 'talia');
  alfred = await person(t, db, 'alfred');
  home = await createLocation(t, db, ibrahim, 'household', 'Home');
  garage = await createLocation(t, db, ibrahim, 'household', 'Garage');
  alfreds = await createLocation(t, db, alfred, 'household', 'بيت العائلة');
  await join(db, home.id, louis.userId, 'member');
  await join(db, home.id, talia.userId, 'viewer');
  await switchModule(garage.id, 'paperwork', false);
});

// ---------------------------------------------------------------------------------------------

describe('expiring documents: create, read, list', () => {
  // catalogue: POST /api/v1/documents
  it('makes a document on a thing, a place and the location itself (D155), audited', async () => {
    const kitchen = await place(db, home, 'Kitchen');
    const boiler = await createThing(t, ibrahim, home, { name: 'Boiler', placeId: kitchen });
    const onThing = await createDoc(ibrahim, {
      subject: { thingId: boiler.id },
      kind: 'inspection',
      expiresOn: '2027-03-01',
    });
    expect(onThing).toMatchObject({
      locationId: home.id,
      subject: { type: 'thing', id: boiler.id, name: 'Boiler', path: 'Home › Kitchen' },
      kind: 'inspection',
      title: null,
      leadDays: 30,
      state: 'ok',
      supersededById: null,
      history: [],
      documents: [],
    });
    const onPlace = await createDoc(louis, {
      subject: { placeId: kitchen },
      kind: 'contract',
      title: 'Fridge service contract',
      expiresOn: '2027-01-01',
    });
    expect(onPlace.subject).toMatchObject({ type: 'place', name: 'Kitchen', path: 'Home' });
    const lease = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'lease',
      expiresOn: '2027-06-30',
      leadDays: 60,
    });
    expect(lease.subject).toEqual({ type: 'location', id: home.id, name: 'Home', path: '' });

    const events = await eventsOf(db, home.id, lease.id);
    expect(events.map((e) => e.action)).toEqual(['document.create']);
    expect(events[0]?.diff.kind).toEqual({ before: null, after: 'lease', class: 'plain' });
    expect(events[0]?.undoable_until).toBeNull();
  });

  it('computes the state on the location’s date: expiring from the lead, expired after', async () => {
    const today = cairoToday();
    const a = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'insurance',
      expiresOn: today,
    });
    const b = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'licence',
      expiresOn: addDays(today, -1),
    });
    const c = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'registration',
      expiresOn: addDays(today, 31),
    });
    expect([a.state, b.state, c.state]).toEqual(['expiring', 'expired', 'ok']);
    expect((await docs(ibrahim, '?state=expired')).map((d) => d.id)).toEqual([b.id]);
  });

  it('refuses other without a title (Q31), and a viewer (403)', async () => {
    const res = await call(t, '/api/v1/documents', {
      as: ibrahim,
      body: { subject: { locationId: home.id }, kind: 'other', expiresOn: '2027-01-01' },
    });
    expect(res.statusCode, res.body).toBe(400);
    const viewer = await call(t, '/api/v1/documents', {
      as: talia,
      body: { subject: { locationId: home.id }, kind: 'lease', expiresOn: '2027-01-01' },
    });
    expect(viewer.statusCode).toBe(403);
    const outsider = await call(t, '/api/v1/documents', {
      as: alfred,
      body: { subject: { locationId: home.id }, kind: 'lease', expiresOn: '2027-01-01' },
    });
    expect(outsider.statusCode).toBe(404);
  });

  it('Paperwork off in Garage: no rows in the lists, 409 to write, 404 to read', async () => {
    await switchModule(garage.id, 'paperwork', true);
    const doc = await createDoc(ibrahim, {
      subject: { locationId: garage.id },
      kind: 'insurance',
      expiresOn: '2027-01-01',
    });
    await switchModule(garage.id, 'paperwork', false);
    expect((await docs(ibrahim)).map((d) => d.id)).not.toContain(doc.id);
    const created = await call(t, '/api/v1/documents', {
      as: ibrahim,
      body: { subject: { locationId: garage.id }, kind: 'lease', expiresOn: '2027-01-01' },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({ code: 'module_off' });
    expect((await call(t, `/api/v1/documents/${doc.id}`, { as: ibrahim })).statusCode).toBe(404);
    const patched = await write(ibrahim, 'PATCH', `/api/v1/documents/${doc.id}`, doc.rowVersion, {
      leadDays: 10,
    });
    expect(patched.statusCode).toBe(409);
  });

  it('filters by subject (GET /documents?subjectId) and reads one (GET /documents/:id)', async () => {
    const kitchen = await place(db, home, 'Kitchen');
    const onPlace = await createDoc(ibrahim, {
      subject: { placeId: kitchen },
      kind: 'contract',
      expiresOn: '2027-01-01',
    });
    const onHome = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'lease',
      expiresOn: '2027-02-01',
    });
    expect((await docs(ibrahim, `?subjectId=${kitchen}`)).map((d) => d.id)).toEqual([onPlace.id]);
    expect((await docs(ibrahim, `?subjectId=${home.id}`)).map((d) => d.id)).toEqual([onHome.id]);
    expect((await docs(ibrahim, '?subjectType=place')).map((d) => d.id)).toEqual([onPlace.id]);
    expect(ok(await call(t, `/api/v1/documents/${onHome.id}`, { as: talia }))).toMatchObject({
      id: onHome.id,
      kind: 'lease',
    });
    expect((await call(t, `/api/v1/documents/${onHome.id}`, { as: alfred })).statusCode).toBe(404);
  });

  it('pages soonest first', async () => {
    for (const day of ['2027-03-01', '2027-01-01', '2027-02-01']) {
      await createDoc(ibrahim, { subject: { locationId: home.id }, kind: 'lease', expiresOn: day });
    }
    const first = ok(
      await call(t, '/api/v1/documents?limit=2', { as: ibrahim }),
    ) as unknown as Page<Doc>;
    expect(first.items.map((d) => d.expiresOn)).toEqual(['2027-01-01', '2027-02-01']);
    const next = ok(
      await call(t, `/api/v1/documents?limit=2&cursor=${first.next_cursor}`, { as: ibrahim }),
    ) as unknown as Page<Doc>;
    expect(next.items.map((d) => d.expiresOn)).toEqual(['2027-03-01']);
    expect(next.next_cursor).toBeNull();
  });

  it("a trashed thing's document rests with it", async () => {
    const boiler = await createThing(t, ibrahim, home, { name: 'Boiler' });
    const doc = await createDoc(ibrahim, {
      subject: { thingId: boiler.id },
      kind: 'inspection',
      expiresOn: '2027-01-01',
    });
    await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [boiler.id]);
    expect((await docs(ibrahim)).map((d) => d.id)).not.toContain(doc.id);
  });
});

describe('expiring documents: edit, delete, renew and their undo', () => {
  // catalogue: PATCH /api/v1/documents/:id
  it('edits with If-Match, audited and undoable', async () => {
    const doc = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'insurance',
      expiresOn: '2027-01-01',
    });
    const stale = await write(ibrahim, 'PATCH', `/api/v1/documents/${doc.id}`, 99, {
      leadDays: 5,
    });
    expect(stale.statusCode).toBe(412);
    const res = await write(louis, 'PATCH', `/api/v1/documents/${doc.id}`, doc.rowVersion, {
      expiresOn: '2027-02-01',
      title: 'Home insurance',
    });
    const after = ok(res) as unknown as Doc;
    expect(after).toMatchObject({ expiresOn: '2027-02-01', title: 'Home insurance' });
    const events = await eventsOf(db, home.id, doc.id);
    expect(events.at(-1)?.action).toBe('document.update');
    expect(events.at(-1)?.diff.expires_on).toMatchObject({
      before: '2027-01-01',
      after: '2027-02-01',
    });
    expect(auditHeader(res)).toBe(events.at(-1)?.id);
    ok(await undo(louis, auditHeader(res)));
    expect(ok(await call(t, `/api/v1/documents/${doc.id}`, { as: ibrahim }))).toMatchObject({
      expiresOn: '2027-01-01',
      title: null,
    });
  });

  it('refuses a viewer’s edit (403)', async () => {
    const doc = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'insurance',
      expiresOn: '2027-01-01',
    });
    const res = await write(talia, 'PATCH', `/api/v1/documents/${doc.id}`, doc.rowVersion, {
      leadDays: 1,
    });
    expect(res.statusCode).toBe(403);
  });

  // catalogue: DELETE /api/v1/documents/:id
  it('deletes for good, and undo puts it back with its file (Q25)', async () => {
    const doc = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'lease',
      expiresOn: '2027-06-30',
    });
    const file = await pdf(home, ibrahim, 'Tenancy agreement for the flat');
    const attachment = await attach(
      ibrahim,
      home,
      file,
      { expiringDocumentId: doc.id },
      'document',
    );
    const res = await write(ibrahim, 'DELETE', `/api/v1/documents/${doc.id}`, doc.rowVersion);
    expect(res.statusCode, res.body).toBe(204);
    expect((await call(t, `/api/v1/documents/${doc.id}`, { as: ibrahim })).statusCode).toBe(404);
    const events = await eventsOf(db, home.id, doc.id);
    expect(events.at(-1)?.action).toBe('document.delete');
    expect(events.at(-1)?.diff.attachments?.before).toEqual([
      expect.objectContaining({ id: attachment, file_id: file, role: 'document' }),
    ]);
    ok(await undo(ibrahim, auditHeader(res)));
    const back = ok(
      await call(t, `/api/v1/documents/${doc.id}`, { as: ibrahim }),
    ) as unknown as Doc;
    expect(back).toMatchObject({ id: doc.id, kind: 'lease', expiresOn: '2027-06-30' });
    expect(back.documents.map((a) => a.id)).toEqual([attachment]);
  });

  it("undoing someone else's delete brings the document back as theirs, with their file (0056)", async () => {
    const doc = await createDoc(louis, {
      subject: { locationId: home.id },
      kind: 'contract',
      expiresOn: '2027-03-31',
    });
    const file = await pdf(home, louis, 'Boiler cover contract');
    const attachment = await attach(louis, home, file, { expiringDocumentId: doc.id }, 'document');
    const res = await write(ibrahim, 'DELETE', `/api/v1/documents/${doc.id}`, doc.rowVersion);
    expect(res.statusCode, res.body).toBe(204);
    // Louis's file is attached to nothing now, and was never Ibrahim's: the undo links it anyway.
    ok(await undo(ibrahim, auditHeader(res)));
    expect(
      await own(db, 'SELECT created_by FROM public.expiring_documents WHERE id = $1', [doc.id]),
    ).toEqual([{ created_by: louis.userId }]);
    expect(
      await own(db, 'SELECT created_by, file_id FROM public.attachments WHERE id = $1', [
        attachment,
      ]),
    ).toEqual([{ created_by: louis.userId, file_id: file }]);
  });

  // catalogue: POST /api/v1/documents/:id/renew
  it('renews into a new row and keeps the old one in history (D172); undo un-renews', async () => {
    const doc = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'insurance',
      title: 'Home insurance',
      expiresOn: '2026-10-15',
      leadDays: 45,
    });
    const res = await write(ibrahim, 'POST', `/api/v1/documents/${doc.id}/renew`, doc.rowVersion, {
      expiresOn: '2027-10-15',
    });
    const body = ok(res) as unknown as { renewed: Doc; previous: Doc };
    expect(body.renewed).toMatchObject({
      kind: 'insurance',
      title: 'Home insurance',
      expiresOn: '2027-10-15',
      leadDays: 45,
      supersededById: null,
      history: [{ id: doc.id, expiresOn: '2026-10-15' }],
    });
    expect(body.previous).toMatchObject({ id: doc.id, supersededById: body.renewed.id });
    // Current documents only, unless asked.
    expect((await docs(ibrahim)).map((d) => d.id)).toEqual([body.renewed.id]);
    expect((await docs(ibrahim, '?includeSuperseded=1')).map((d) => d.id)).toEqual([
      doc.id,
      body.renewed.id,
    ]);
    // An old term can't be renewed again.
    const again = await write(
      ibrahim,
      'POST',
      `/api/v1/documents/${doc.id}/renew`,
      body.previous.rowVersion,
      { expiresOn: '2028-01-01' },
    );
    expect(again.statusCode).toBe(409);
    const events = await eventsOf(db, home.id, doc.id);
    expect(events.at(-1)?.action).toBe('document.renew');
    expect(events.at(-1)?.diff.superseded_by_id).toMatchObject({
      before: null,
      after: body.renewed.id,
    });

    ok(await undo(ibrahim, auditHeader(res)));
    expect((await docs(ibrahim)).map((d) => d.id)).toEqual([doc.id]);
    expect(
      (await call(t, `/api/v1/documents/${body.renewed.id}`, { as: ibrahim })).statusCode,
    ).toBe(404);
  });

  it('refuses to undo a renewal that was changed since', async () => {
    const doc = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'insurance',
      expiresOn: '2026-10-15',
    });
    const res = await write(ibrahim, 'POST', `/api/v1/documents/${doc.id}/renew`, doc.rowVersion, {
      expiresOn: '2027-10-15',
    });
    const { renewed } = ok(res) as unknown as { renewed: Doc };
    ok(
      await write(ibrahim, 'PATCH', `/api/v1/documents/${renewed.id}`, renewed.rowVersion, {
        leadDays: 7,
      }),
    );
    const refused = await undo(ibrahim, auditHeader(res));
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'undo_refused', reason: 'changed_since' });
  });
});

describe('the paperwork library (D39, D155)', () => {
  it('finds a lease PDF by a word of its text, with a snippet and its expiry', async () => {
    const lease = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'lease',
      expiresOn: '2027-06-30',
    });
    const file = await pdf(home, ibrahim, 'Tenancy agreement. The landlord Murdock lets the flat.');
    await attach(ibrahim, home, file, { expiringDocumentId: lease.id }, 'document');
    const other = await pdf(home, ibrahim, 'Oven manual: preheat before baking.');
    const oven = await createThing(t, ibrahim, home, { name: 'Oven' });
    await attach(ibrahim, home, other, { thingId: oven.id }, 'manual');

    const found = await library(ibrahim, '?q=landlord');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      subject: { type: 'location', id: home.id },
      expiring: { id: lease.id, kind: 'lease', expiresOn: '2027-06-30', state: 'ok' },
    });
    expect(found[0]?.snippet).toContain('landlord Murdock');
    // By the subject's name too.
    expect((await library(ibrahim, '?q=oven')).map((r) => r.attachment.file?.id)).toEqual([other]);
    // Everything, newest first.
    expect((await library(ibrahim)).map((r) => r.attachment.file?.id)).toEqual([other, file]);
    // The location's own attachments list doesn't take the lease's file for the location's.
    const own = ok(
      await call(t, `/api/v1/locations/${home.id}/attachments`, { as: ibrahim }),
    ) as unknown as Page<{ id: string }>;
    expect(own.items).toEqual([]);
  });

  it("a viewer of Home: no receipt at all, no snippet, the manual's row (money gate)", async () => {
    const dishwasher = await createThing(t, ibrahim, home, { name: 'Dishwasher' });
    const manual = await pdf(home, ibrahim, 'Dishwasher manual: descale monthly.');
    const receipt = await pdf(home, ibrahim, 'Dishwasher receipt total 24,999 EGP');
    await attach(ibrahim, home, manual, { thingId: dishwasher.id }, 'manual');
    await attach(ibrahim, home, receipt, { thingId: dishwasher.id }, 'receipt');

    const mine = await library(ibrahim, '?q=dishwasher');
    expect(mine.map((r) => r.attachment.role).sort()).toEqual(['manual', 'receipt']);
    expect(mine.every((r) => typeof r.snippet === 'string')).toBe(true);

    const hers = await library(talia, '?q=dishwasher');
    expect(hers.map((r) => r.attachment.role)).toEqual(['manual']);
    expect(hers[0]?.snippet).toBeUndefined();
    expect(await library(talia, '?role=receipt')).toEqual([]);
  });

  it("Paperwork off in Garage hides Garage's rows; others' locations never show", async () => {
    const mower = await createThing(t, ibrahim, garage, { name: 'Mower' });
    await attach(
      ibrahim,
      garage,
      await pdf(garage, ibrahim, 'Mower manual'),
      { thingId: mower.id },
      'manual',
    );
    const kettle = await createThing(t, alfred, alfreds, { name: 'Kettle' });
    await attach(
      alfred,
      alfreds,
      await pdf(alfreds, alfred, 'Kettle manual'),
      { thingId: kettle.id },
      'manual',
    );
    expect(await library(ibrahim, '?q=manual')).toEqual([]);
    await switchModule(garage.id, 'paperwork', true);
    expect((await library(ibrahim, '?q=manual')).map((r) => r.subject.name)).toEqual(['Mower']);
  });

  it('filters by location, role, subject type and expiry, and leaves photos out', async () => {
    const kitchen = await place(db, home, 'Kitchen');
    const today = cairoToday();
    const lease = await createDoc(ibrahim, {
      subject: { locationId: home.id },
      kind: 'lease',
      expiresOn: addDays(today, 10),
    });
    const leaseFile = await pdf(home, ibrahim, 'Lease');
    await attach(ibrahim, home, leaseFile, { expiringDocumentId: lease.id }, 'document');
    const placeFile = await pdf(home, ibrahim, 'Kitchen plan');
    await attach(ibrahim, home, placeFile, { placeId: kitchen }, 'document');
    const photo = await pdf(home, ibrahim, 'not a photo, but attached as one');
    await attach(ibrahim, home, photo, { placeId: kitchen }, 'photo');

    const ids = (rows: Row[]) => rows.map((r) => r.attachment.file?.id);
    expect(ids(await library(ibrahim, '?expiry=expiring'))).toEqual([leaseFile]);
    expect(ids(await library(ibrahim, '?expiry=expired'))).toEqual([]);
    expect(ids(await library(ibrahim, '?subjectType=place'))).toEqual([placeFile]);
    expect(ids(await library(ibrahim, `?locationId=${garage.id}`))).toEqual([]);
    expect(ids(await library(ibrahim, '?role=document')).sort()).toEqual(
      [leaseFile, placeFile].sort(),
    );
  });
});
