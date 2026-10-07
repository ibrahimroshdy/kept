import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { type TestFiles, testFiles, upload } from '../../test/files.js';
import { encryptedPdf, flateBombPdf, scannedPdf, textPdf } from '../../test/pdf.js';
import { join, type Person, peopleApp, person, type RecordedJob } from '../../test/people.js';
import { createLocation, type Loc, own } from '../../test/things.js';
import { runJob } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import {
  PDF_MEMORY_MB,
  PDF_TEXT_MAX,
  PDF_TIMEOUT_MS,
  type PdfTextOptions,
  pdfTextJobs,
  readPdfText,
  storableText,
} from './pdf-text.js';

// T21 (Q19; D77, D157; engineering spec §3.1b): a PDF's text, read in a limited child process
// and stored in file_text, and the job the upload sends for it. The hostile cases each end with
// no row and a completed job, never a hung test worker: the child is SIGKILLed at its limits.
//
// Ann owns Home; Bob is a member there, Vic a viewer. Eve shares nothing with them.

let dir: string;
let db: TestDb;
let t: TestApp;
let files: TestFiles;
const sent: RecordedJob[] = [];
let ann: Person;
let bob: Person;
let vic: Person;
let eve: Person;
let home: Loc;

/** A child that never finishes: a parser stuck in a loop. */
const SPIN = 'for (;;) {}\n';
/** A child that hoards memory outside V8's heap, as decoded PDF streams do. */
const HOARD = `const keep = [];
for (;;) { keep.push(Buffer.alloc(16 * 1024 * 1024, 1)); await new Promise((r) => setTimeout(r, 5)); }
`;

async function file(name: string, bytes: Buffer | string): Promise<string> {
  const p = path.join(dir, name);
  await writeFile(p, bytes);
  return p;
}

const logs: { obj: object; msg: string }[] = [];
const jobDeps = (limits?: PdfTextOptions) => ({
  pools: db.pools,
  mailer: { send: async () => {} },
  publicUrl: 'https://kept.example',
  log: {
    info: (obj: object, msg: string) => logs.push({ obj, msg }),
    error: (obj: object, msg: string) => logs.push({ obj, msg }),
  },
  files,
  ...(limits ? { pdfLimits: limits } : {}),
});

/** Runs the `pdf-text` job for `fileId` as `as`, the way a worker would (a tenant job). */
async function work(as: Person, fileId: string, limits?: PdfTextOptions): Promise<void> {
  const job = pdfTextJobs(jobDeps(limits)).find((j) => j.name === 'pdf-text');
  if (!job) throw new Error('no pdf-text job');
  await runJob(job, { userId: as.userId, mfa: false, data: { fileId } }, db.pools);
}

async function uploadPdf(as: Person, loc: Loc, bytes: Buffer): Promise<string> {
  const res = await upload(t, as, loc.id, bytes, {
    cls: 'document',
    contentType: 'application/pdf',
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { id: string }).id;
}

const textOf = async (fileId: string) =>
  (
    await own<{ text: string; source: string; location_id: string }>(
      db,
      'SELECT text, source, location_id FROM public.file_text WHERE file_id = $1',
      [fileId],
    )
  )[0];

const outcomeOf = (fileId: string) =>
  (
    logs.findLast((l) => (l.obj as { fileId?: string }).fileId === fileId)?.obj as
      | { outcome?: string }
      | undefined
  )?.outcome;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'kept-pdf-'));
  db = await testDb();
  await db.reset();
  files = await testFiles();
  t = await peopleApp(db, { sent, files });
  ann = await person(t, db, 'ann');
  bob = await person(t, db, 'bob');
  vic = await person(t, db, 'vic');
  eve = await person(t, db, 'eve');
  home = await createLocation(t, db, ann, 'household', 'Home');
  await join(db, home.id, bob.userId, 'member');
  await join(db, home.id, vic.userId, 'viewer');
});

afterAll(async () => {
  await files?.cleanup();
  await rm(dir, { recursive: true, force: true });
});

describe('the limits (§3.1b)', () => {
  it('are 20 s and 256 MB, with 200,000 characters kept, and one retry of a minute', () => {
    expect(PDF_TIMEOUT_MS).toBe(20_000);
    expect(PDF_MEMORY_MB).toBe(256);
    expect(PDF_TEXT_MAX).toBe(200_000);
    expect(JOB_POLICIES['pdf-text']).toEqual({
      retryLimit: 1,
      retryDelay: 30,
      retryBackoff: true,
      expireInSeconds: 60,
    });
  });
});

describe('readPdfText', () => {
  it('reads a text PDF, page by page', async () => {
    const pdf = await file(
      'text.pdf',
      textPdf([['Dishwasher SMS46 manual', 'Serial (A) 12345'], ['Page two: descaling']]),
    );
    expect(await readPdfText(pdf)).toEqual({
      status: 'text',
      text: 'Dishwasher SMS46 manual\nSerial (A) 12345\n\nPage two: descaling',
      pages: 2,
      truncated: false,
    });
  });

  it('finds no text in a scanned PDF', async () => {
    expect(await readPdfText(await file('scan.pdf', scannedPdf()))).toEqual({
      status: 'empty',
      pages: 1,
    });
  });

  it('keeps the first 200,000 characters of a long PDF, and stops reading there', async () => {
    const pages = Array.from({ length: 80 }, (_, p) =>
      Array.from({ length: 50 }, (_, i) => `page ${p} line ${i} `.padEnd(90, 'x')),
    );
    const result = await readPdfText(await file('long.pdf', textPdf(pages)));
    expect(result.status).toBe('text');
    if (result.status !== 'text') return;
    expect(result.text).toHaveLength(PDF_TEXT_MAX);
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith('page 0 line 0 ')).toBe(true);
    expect(result.text).not.toContain('page 79 ');
  });

  it('refuses an encrypted PDF', async () => {
    expect(await readPdfText(await file('locked.pdf', encryptedPdf()))).toEqual({
      status: 'encrypted',
    });
  });

  it('calls a file that only starts like a PDF unreadable', async () => {
    const result = await readPdfText(await file('junk.pdf', '%PDF-1.4\nnot really a PDF\n'));
    expect(result.status).toBe('unreadable');
  });

  it('kills a decompression bomb at the memory limit', async () => {
    // 400 KB that inflates to 400 MB of blanks in one content stream.
    const bomb = await flateBombPdf(400);
    expect(bomb.length).toBeLessThan(1024 * 1024);
    const started = performance.now();
    const result = await readPdfText(await file('bomb.pdf', bomb), { timeoutMs: 10_000 });
    expect(result).toEqual({ status: 'memory' });
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it('kills a parse that never ends at the time limit', async () => {
    const worker = await file('spin.mjs', SPIN);
    const started = performance.now();
    const result = await readPdfText(await file('any.pdf', scannedPdf()), {
      worker,
      timeoutMs: 1500,
    });
    const took = performance.now() - started;
    expect(result).toEqual({ status: 'timeout' });
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(5000);
  });

  it('kills a child whose memory grows outside the heap', async () => {
    const worker = await file('hoard.mjs', HOARD);
    const result = await readPdfText(await file('any2.pdf', scannedPdf()), {
      worker,
      memoryMb: 128,
      timeoutMs: 15_000,
    });
    expect(result).toEqual({ status: 'memory' });
  });

  it('stores text Postgres accepts', () => {
    expect(storableText('a\u0000b ')).toBe('ab');
    expect(storableText(`${'x'.repeat(4)}\u{1F4E6}`, 5)).toBe('xxxx');
  });
});

describe('the pdf-text job', () => {
  it('is sent by a PDF upload, and stores the text as the uploader', async () => {
    sent.length = 0;
    const fileId = await uploadPdf(bob, home, textPdf([['Kettle warranty card', 'Two years']]));
    expect(sent).toEqual([{ name: 'pdf-text', data: { fileId } }]);
    await work(bob, fileId);
    expect(await textOf(fileId)).toEqual({
      text: 'Kettle warranty card\nTwo years',
      source: 'pdf',
      location_id: home.id,
    });
    expect(outcomeOf(fileId)).toBe('stored');

    // Again (a retry, a duplicate send): nothing changes.
    await work(bob, fileId);
    expect(outcomeOf(fileId)).toBe('skipped');
  });

  it('is not sent for a photo', async () => {
    sent.length = 0;
    const { uniqueJpeg } = await import('../../test/files.js');
    const res = await upload(t, ann, home.id, await uniqueJpeg());
    expect(res.statusCode, res.body).toBe(201);
    expect(sent).toEqual([]);
  });

  it('finds nothing for someone who can’t write where the file is', async () => {
    const fileId = await uploadPdf(ann, home, textPdf([['Boiler service record']]));
    await work(eve, fileId);
    expect(outcomeOf(fileId)).toBe('skipped');
    await work(vic, fileId);
    expect(outcomeOf(fileId)).toBe('skipped');
    expect(await textOf(fileId)).toBeUndefined();
  });

  it('completes with no row for a scan, an encrypted PDF, a bomb and a runaway', async () => {
    const scan = await uploadPdf(ann, home, scannedPdf());
    await work(ann, scan);
    expect(outcomeOf(scan)).toBe('empty');

    const locked = await uploadPdf(ann, home, encryptedPdf());
    await work(ann, locked);
    expect(outcomeOf(locked)).toBe('encrypted');

    const bomb = await uploadPdf(ann, home, await flateBombPdf(400));
    await work(ann, bomb, { timeoutMs: 10_000 });
    expect(outcomeOf(bomb)).toBe('memory');

    const runaway = await uploadPdf(ann, home, textPdf([['Looks fine']]));
    await work(ann, runaway, { worker: await file('spin2.mjs', SPIN), timeoutMs: 1000 });
    expect(outcomeOf(runaway)).toBe('timeout');

    for (const id of [scan, locked, bomb, runaway]) expect(await textOf(id)).toBeUndefined();
  });
});
