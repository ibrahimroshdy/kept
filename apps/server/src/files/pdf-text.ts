import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type pg from 'pg';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { SystemJobDeps } from '../jobs/system.js';
import type { FileStorage } from '../storage/blob-store.js';

// The `pdf-text` tenant job (plan T21, Q19; D77, D157; engineering spec §1.5, §3.1b, §7.2): a
// PDF's text layer, read into `file_text` for document search and for a PDF receipt's extraction
// (extraction/image.ts sends it instead of an image).
//
// The upload sends it in its own transaction (files/upload.ts) with `{fileId}` only, and it runs
// in the uploader's scope, so the file is re-read under row-level security (the rule in
// jobs/boss.ts): a job naming a file the uploader can't see, or may no longer write in, finds
// nothing and ends. Then:
// 1. the original is streamed from the blob store to a scratch file;
// 2. pdf-worker.mjs reads it in a child process: `--max-old-space-size=256`, no inherited
//    environment, killed past PDF_TIMEOUT_MS (20 s) of wall-clock time and as soon as its
//    resident memory passes PDF_MEMORY_MB (256 MB), which also catches what V8's heap flag can't
//    (PDF.js's decoded streams live in ArrayBuffers, outside the heap);
// 3. at most PDF_TEXT_MAX characters (200,000, the table's CHECK) go into `file_text` with source
//    `pdf`.
// A timeout, a memory kill, a crash, an unreadable or encrypted PDF, or one with no text (a scan)
// writes no row, and the job completes: it is logged, never failed, since running it again would
// only fail the same way. Only the blob store or the database failing throws (one retry,
// JOB_POLICIES['pdf-text']).
//
// Why PDF.js (unpdf) and not poppler's pdftotext: the plan names unpdf, and it is one MIT package
// in the lockfile (PDF.js 6.1.200 inside, Apache-2.0), pure JavaScript with no eval, the same on
// amd64 and arm64. poppler-utils is not in the image; in its Debian bookworm base (read from the
// image's own apt index, 2026-09-29) it is 22.12.0-2+deb12u3 and brings 32 packages, GPL.
// Rasterising pages (thumbnails, OCR of scans) stays deferred to 1.x (Q19, D97, D209).

/** Wall-clock limit of one parse (§3.1b). */
export const PDF_TIMEOUT_MS = 20_000;
/** Resident-memory limit of the child, and its V8 heap limit (§3.1b). */
export const PDF_MEMORY_MB = 256;
/** At most this many characters are kept (file_text's CHECK). */
export const PDF_TEXT_MAX = 200_000;
const POLL_MS = 100;
/** stdout kept from the child: the text as JSON (escaped, a few bytes a character) and no more. */
const STDOUT_MAX = PDF_TEXT_MAX * 8 + 4096;

const here = path.dirname(fileURLToPath(import.meta.url));
/** Beside this module in src/ and in dist/ (reports/render/build-assets.ts copies it there). */
export const PDF_WORKER = path.join(here, 'pdf-worker.mjs');

export type PdfTextResult =
  | { status: 'text'; text: string; pages: number; truncated: boolean }
  /** Parsed, but no page has a text layer: a scan, or pictures only. */
  | { status: 'empty'; pages: number }
  | { status: 'encrypted' }
  | { status: 'timeout' }
  | { status: 'memory' }
  /** Not a PDF PDF.js can read, or the child failed. */
  | { status: 'unreadable'; reason: string };

export type PdfTextOptions = {
  timeoutMs?: number;
  memoryMb?: number;
  maxChars?: number;
  /** Another child script (tests: one that spins or hoards memory). */
  worker?: string;
};

const run = promisify(execFile);

/** Resident set size of `pid` in MB, or null once it is gone (as reports/render/render.ts). */
async function rssMb(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      return kb ? Number(kb) / 1024 : null;
    }
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000 });
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
  } catch {
    return null;
  }
}

/** Text Postgres will store: no NULs, no lone surrogate at the cut, at most `max` characters. */
export function storableText(text: string, max = PDF_TEXT_MAX): string {
  let out = text.replaceAll('\u0000', '');
  if (out.length > max) out = out.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out.trim();
}

type Exit = { code: number | null; signal: NodeJS.Signals | null; error?: Error };

/**
 * Reads the text of the PDF at `file` in a limited child process. Never throws for anything the
 * file does, and always settles, whatever the child does: it is SIGKILLed at the limits.
 */
export async function readPdfText(file: string, opts: PdfTextOptions = {}): Promise<PdfTextResult> {
  const timeoutMs = opts.timeoutMs ?? PDF_TIMEOUT_MS;
  const memoryMb = opts.memoryMb ?? PDF_MEMORY_MB;
  const maxChars = opts.maxChars ?? PDF_TEXT_MAX;

  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${memoryMb}`, opts.worker ?? PDF_WORKER, file, String(maxChars)],
    // No inherited environment: the child needs none of the server's settings or secrets.
    { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } },
  );
  let stdout = '';
  let stderr = '';
  let killedFor: 'timeout' | 'memory' | 'output' | null = null;
  const kill = (why: 'timeout' | 'memory' | 'output') => {
    if (killedFor) return;
    killedFor = why;
    child.kill('SIGKILL');
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    if (stdout.length > STDOUT_MAX) kill('output');
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 2000) stderr += chunk;
  });

  const timer = setTimeout(() => kill('timeout'), timeoutMs);
  let polling = false;
  const poll = setInterval(() => {
    if (polling || child.pid === undefined) return;
    polling = true;
    void rssMb(child.pid).then((mb) => {
      polling = false;
      if (mb !== null && mb > memoryMb) kill('memory');
    });
  }, POLL_MS);
  let belt: NodeJS.Timeout | undefined;

  let exit: Exit;
  try {
    exit = await new Promise<Exit>((resolve) => {
      child.once('error', (error) => resolve({ code: null, signal: null, error }));
      // `close`, not `exit`: stdout has been read to its end by then.
      child.once('close', (code, signal) => resolve({ code, signal }));
      // A SIGKILLed child always closes; this is the belt to that brace, so a caller (a job, a
      // test worker) can never wait for ever.
      belt = setTimeout(() => {
        killedFor ??= 'timeout';
        resolve({ code: null, signal: 'SIGKILL' });
      }, timeoutMs + 5000);
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(belt);
    clearInterval(poll);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }

  if (killedFor === 'timeout') return { status: 'timeout' };
  if (killedFor === 'memory') return { status: 'memory' };
  if (killedFor === 'output') return { status: 'unreadable', reason: 'output' };
  if (exit.error) return { status: 'unreadable', reason: `spawn: ${exit.error.message}` };
  if (exit.code === 4) return { status: 'encrypted' };
  if (exit.code !== 0) {
    // V8 aborts when its heap is full; a SIGKILL we didn't send is the OOM killer's.
    if (exit.signal === 'SIGKILL' || /heap out of memory/i.test(stderr)) {
      return { status: 'memory' };
    }
    return {
      status: 'unreadable',
      reason: `${exit.code ?? exit.signal}: ${stderr.trim().slice(0, 300)}`,
    };
  }
  // The last line is the result; PDF.js may have printed something before it.
  const line = stdout.trimEnd().split('\n').at(-1) ?? '';
  let parsed: { pages?: unknown; text?: unknown; truncated?: unknown };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    return { status: 'unreadable', reason: 'no result' };
  }
  const pages = typeof parsed.pages === 'number' ? parsed.pages : 0;
  const text = storableText(typeof parsed.text === 'string' ? parsed.text : '', maxChars);
  if (text === '') return { status: 'empty', pages };
  return { status: 'text', text, pages, truncated: parsed.truncated === true };
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

export const PDF_TEXT_JOB = 'pdf-text';

export type PdfTextJobDeps = {
  files: FileStorage | null;
  /** Limits for tests; production uses the defaults. */
  limits?: PdfTextOptions;
};

export type PdfTextJobOutcome =
  | { status: 'stored'; chars: number; truncated: boolean }
  | { status: 'skipped'; why: 'missing' | 'not_pdf' | 'done' | 'no_storage' }
  | Exclude<PdfTextResult, { status: 'text' }>;

type FileToRead = { id: string; location_id: string; storage_key: string; mime: string };

/** One run for `fileId`, on the job's scoped client (kept_app, in the uploader's scope). */
export async function runPdfText(
  deps: PdfTextJobDeps,
  client: pg.ClientBase,
  fileId: string,
): Promise<PdfTextJobOutcome> {
  // Under the policies: the uploader's own file (attached or not yet), or one attached where
  // they can see it; and only where they may still write, since the row is theirs to insert.
  const { rows } = await client.query<FileToRead>(
    `SELECT f.id, f.location_id, f.storage_key, f.mime FROM public.files f
      WHERE f.id = $1 AND f.location_id IN (SELECT kept.writable_location_ids())`,
    [fileId],
  );
  const file = rows[0];
  if (!file) return { status: 'skipped', why: 'missing' };
  if (file.mime !== 'application/pdf') return { status: 'skipped', why: 'not_pdf' };
  const { rows: done } = await client.query('SELECT 1 FROM public.file_text WHERE file_id = $1', [
    file.id,
  ]);
  if (done.length > 0) return { status: 'skipped', why: 'done' };
  if (!deps.files) return { status: 'skipped', why: 'no_storage' };

  await mkdir(deps.files.tmpDir, { recursive: true });
  const dir = await mkdtemp(path.join(deps.files.tmpDir, 'pdf-'));
  try {
    const local = path.join(dir, 'in.pdf');
    await pipeline(await deps.files.blobs.stream(file.storage_key), createWriteStream(local));
    const result = await readPdfText(local, deps.limits);
    if (result.status !== 'text') return result;
    // A second run of the same job (a retry, a duplicate send) changes nothing.
    await client.query(
      `INSERT INTO public.file_text (file_id, location_id, source, text)
       VALUES ($1, $2, 'pdf', $3) ON CONFLICT (file_id) DO NOTHING`,
      [file.id, file.location_id, result.text],
    );
    return { status: 'stored', chars: result.text.length, truncated: result.truncated };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The `pdf-text` job. Aggregated by jobs/capture.ts. */
export function pdfTextJobs(deps: SystemJobDeps & { pdfLimits?: PdfTextOptions }): JobDefinition[] {
  return [
    defineJob({
      name: PDF_TEXT_JOB,
      kind: 'tenant',
      policy: JOB_POLICIES['pdf-text'],
      handler: async ({ data, client }) => {
        const fileId = (data as { fileId?: unknown } | null)?.fileId;
        if (typeof fileId !== 'string' || !UUID.test(fileId)) {
          throw new Error('pdf-text job: data names no file');
        }
        // The parse may take its full 20 s while runJob()'s scoped transaction waits on it; past
        // the pool's 30 s idle-in-transaction limit the server would end it and fail the job.
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '90s'`);
        const outcome = await runPdfText(
          { files: deps.files ?? null, ...(deps.pdfLimits ? { limits: deps.pdfLimits } : {}) },
          client,
          fileId.toLowerCase(),
        );
        // Logged either way, and never failed for what the file did (see the header).
        deps.log.info({ fileId, outcome: outcome.status }, 'pdf text read');
      },
    }),
  ];
}
