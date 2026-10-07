import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, upload } from '../../test/files.js';
import { textPdf } from '../../test/pdf.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { createLocation, createThing, type Loc, ok, own } from '../../test/things.js';
import { pdfTextJobs } from '../files/pdf-text.js';
import { runJob } from '../jobs/boss.js';
import { snippetOf } from './documents.js';

// T21 (Q19; D77; engineering spec §7.2): the `documents` group of GET /api/v1/search, over the
// text the pdf-text job read from real uploads.
//
// Ann owns Home (Household: money on). In Home Bob is a member and Vic a viewer; viewers don't
// see money there. Eve has a location of her own and shares nothing with them. Home's dishwasher
// has a manual and a receipt, both PDFs; Eve's kettle has a manual that also says "dishwasher".

let db: TestDb;
let t: TestApp;
let files: TestFiles;
let ann: Person;
let bob: Person;
let vic: Person;
let eve: Person;
let home: Loc;
let eves: Loc;
let dishwasher: string;
let manual: { attachment: string; file: string };
let receipt: { attachment: string; file: string };
let eveManual: { attachment: string; file: string };

type Doc = {
  attachmentId: string;
  fileId: string;
  locationId: string;
  subject: { kind: string; id: string; name: string | null };
  role: string;
  snippet?: string;
  moneyHidden?: true;
};

async function work(as: Person, fileId: string): Promise<void> {
  const job = pdfTextJobs({
    pools: db.pools,
    mailer: { send: async () => {} },
    publicUrl: 'https://kept.example',
    log: { info: () => {}, error: () => {} },
    files,
  }).find((j) => j.name === 'pdf-text');
  if (!job) throw new Error('no pdf-text job');
  await runJob(job, { userId: as.userId, mfa: false, data: { fileId } }, db.pools);
}

/** Uploads a text PDF, reads its text, and attaches it to a thing (by id) or `subject` as `role`. */
async function document(
  as: Person,
  loc: Loc,
  on: string | Record<string, string>,
  role: string,
  lines: string[],
): Promise<{ attachment: string; file: string }> {
  const subject = typeof on === 'string' ? { thingId: on } : on;
  const res = await upload(t, as, loc.id, textPdf([lines]), {
    cls: 'document',
    contentType: 'application/pdf',
  });
  expect(res.statusCode, res.body).toBe(201);
  const file = (res.json() as { id: string }).id;
  await work(as, file);
  const attachment = ok(
    await call(t, '/api/v1/attachments', {
      as,
      body: { locationId: loc.id, fileId: file, subject, role },
    }),
    201,
  ).id;
  return { attachment, file };
}

async function documents(as: Person, q: string, extra = ''): Promise<Doc[]> {
  const res = await call(t, `/api/v1/search?q=${encodeURIComponent(q)}${extra}`, { as });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { documents: { items: Doc[] } }).documents.items;
}

beforeAll(async () => {
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { files });
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  vic = await person(t, db, 'vic');
  eve = await person(t, db, 'eve');
  home = await createLocation(t, db, ann, 'household', 'Home');
  eves = await createLocation(t, db, eve, 'household', 'Flat');
  await join(db, home.id, bob.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');

  dishwasher = (await createThing(t, ann, home, { name: 'Dishwasher' })).id;
  manual = await document(ann, home, dishwasher, 'manual', [
    'Bosch dishwasher SMS46 user manual',
    'Descale the dishwasher every three months.',
  ]);
  receipt = await document(ann, home, dishwasher, 'receipt', [
    'Ace Appliances invoice 7731',
    'Dishwasher SMS46 total 24999.00 EGP',
  ]);
  const kettle = (await createThing(t, eve, eves, { name: 'Kettle' })).id;
  eveManual = await document(eve, eves, kettle, 'manual', [
    'Kettle manual. Never put the kettle in the dishwasher.',
  ]);
});

afterAll(async () => {
  await files?.cleanup();
});

describe('GET /search: documents', () => {
  it('finds a document by its text, with a snippet, for someone who sees money', async () => {
    const found = await documents(bob, 'descale');
    expect(found).toEqual([
      {
        attachmentId: manual.attachment,
        fileId: manual.file,
        locationId: home.id,
        subject: { kind: 'thing', id: dishwasher, name: 'Dishwasher' },
        role: 'manual',
        snippet: 'Bosch dishwasher SMS46 user manual Descale the dishwasher every three months.',
      },
    ]);
  });

  it('finds the receipt by what it says only where money shows', async () => {
    const forAnn = await documents(ann, '24999');
    expect(forAnn.map((d) => d.attachmentId)).toEqual([receipt.attachment]);
    expect(forAnn[0]?.snippet).toContain('total 24999.00 EGP');

    // A viewer where viewers don't see money: the receipt isn't a result at all.
    expect(await documents(vic, '24999')).toEqual([]);
    expect(await documents(vic, 'invoice')).toEqual([]);
  });

  it('shows a viewer without money the document, but no snippet', async () => {
    const found = await documents(vic, 'dishwasher');
    expect(found).toEqual([
      {
        attachmentId: manual.attachment,
        fileId: manual.file,
        locationId: home.id,
        subject: { kind: 'thing', id: dishwasher, name: 'Dishwasher' },
        role: 'manual',
        moneyHidden: true,
      },
    ]);
    expect(JSON.stringify(found)).not.toContain('Descale');

    // With the location's "viewers may see money" on, the receipt and the snippets come back.
    await own(db, 'UPDATE public.locations SET money_visible_to_viewers = true WHERE id = $1', [
      home.id,
    ]);
    try {
      const seen = await documents(vic, 'dishwasher');
      expect(seen.map((d) => d.attachmentId).sort()).toEqual(
        [manual.attachment, receipt.attachment].sort(),
      );
      expect(seen.every((d) => typeof d.snippet === 'string' && !d.moneyHidden)).toBe(true);
    } finally {
      await own(db, 'UPDATE public.locations SET money_visible_to_viewers = false WHERE id = $1', [
        home.id,
      ]);
    }
  });

  it("never matches another tenant's documents, either way", async () => {
    const forEve = await documents(eve, 'dishwasher');
    expect(forEve.map((d) => d.attachmentId)).toEqual([eveManual.attachment]);
    expect(await documents(eve, 'descale')).toEqual([]);
    expect(await documents(eve, '24999')).toEqual([]);

    const forAnn = await documents(ann, 'kettle');
    expect(forAnn).toEqual([]);
  });

  it('answers kind=documents alone, and narrows by location', async () => {
    const res = await call(t, '/api/v1/search?q=dishwasher&kind=documents', { as: ann });
    const body = ok(res) as unknown as {
      things: { items: unknown[] };
      documents: { items: Doc[] };
    };
    expect(body.things.items).toEqual([]);
    expect(body.documents.items).toHaveLength(2);
    expect(await documents(ann, 'dishwasher', `&locationId=${home.id}&not=locationId`)).toEqual([]);
    // Naming a location she can't see is a 404, as for every group (review #36).
    const res404 = await call(t, `/api/v1/search?q=dishwasher&locationId=${home.id}`, { as: eve });
    expect(res404.statusCode).toBe(404);
  });

  it("names a warranty's document by the thing it covers, and opens that thing", async () => {
    const tv = (await createThing(t, ann, home, { name: 'Samsung TV' })).id;
    const res = await call(t, `/api/v1/things/${tv}/warranties`, {
      as: ann,
      body: { kind: 'manufacturer', startsOn: '2026-01-01', termMonths: 24 },
    });
    expect(res.statusCode, res.body).toBe(201);
    const warrantyId = (res.json() as { id: string }).id;
    const card = await document(ann, home, { warrantyId }, 'warranty_doc', [
      'Samsung warranty certificate QN90 panel',
    ]);
    const found = await documents(ann, 'certificate');
    expect(found.map((d) => [d.attachmentId, d.subject])).toEqual([
      [card.attachment, { kind: 'thing', id: tv, name: 'Samsung TV' }],
    ]);
  });

  it("names an incident's document as the incident's", async () => {
    const res = await call(t, `/api/v1/locations/${home.id}/incidents`, {
      as: ann,
      body: { kind: 'burglary', occurredOn: '2026-09-20' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const incidentId = (res.json() as { id: string }).id;
    await document(ann, home, { incidentId }, 'document', ['Police report 4471 back door forced']);
    const found = await documents(ann, 'forced');
    expect(found.map((d) => d.subject)).toEqual([{ kind: 'incident', id: incidentId, name: null }]);
  });

  it("drops a trashed thing's documents", async () => {
    await own(db, 'UPDATE public.things SET deleted_at = now() WHERE id = $1', [dishwasher]);
    try {
      expect(await documents(ann, 'dishwasher')).toEqual([]);
    } finally {
      await own(db, 'UPDATE public.things SET deleted_at = NULL WHERE id = $1', [dishwasher]);
    }
  });
});

describe('snippetOf', () => {
  it('cuts around the first matching word, in the document’s own spelling', () => {
    const text = `${'Lorem ipsum dolor sit amet. '.repeat(10)}The WARRANTY lasts two years.${' Filler words here.'.repeat(20)}`;
    const s = snippetOf(text, 'warr');
    expect(s).toContain('The WARRANTY lasts two years.');
    expect(s.length).toBeLessThanOrEqual(220);
    expect(s.startsWith('Lorem')).toBe(false);
  });

  it('matches Arabic through the normaliser, prefixes and all', () => {
    const s = snippetOf('فاتورة شراء الغسالة من المتجر', 'غساله');
    expect(s).toBe('فاتورة شراء الغسالة من المتجر');
  });

  it('opens the document when no single word matches', () => {
    expect(snippetOf('HDMI 2.1 cable, two metres', '2.1')).toBe('HDMI 2.1 cable, two metres');
  });
});
