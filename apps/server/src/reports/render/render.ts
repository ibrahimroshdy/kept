import { execFile, spawn } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ensureFonts } from './fonts.js';

// Renders a report in a child process (D201; spike V34, "run the render in a child process").
// Typst's memory lives in the napi addon, outside V8, so no --max-old-space-size can bound it and
// only the child's exit hands it back. The parent therefore:
// - starts child.mjs with its own small V8 heap (the child's JavaScript is a few lines);
// - watches the child's resident memory every POLL_MS (/proc on Linux, `ps` elsewhere) and kills
//   it past `memoryMb` (error `memory`);
// - kills it past `timeoutMs` of wall-clock time (error `timeout`).
// The spike measured 500 things with photos in Arabic at 1.5–1.9 s and 248–278 MB peak, so the
// defaults (512 MB, 60 s) leave room and still stop a runaway on a Pi (engineering spec §3.1).

export const RENDER_MEMORY_MB = 512;
export const RENDER_TIMEOUT_MS = 60_000;
const POLL_MS = 100;
/** The child's own V8 heap: it only reads files and calls the addon. */
const CHILD_HEAP_MB = 64;

export type RenderErrorCode = 'timeout' | 'memory' | 'render';

export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

export type RenderOptions = {
  memoryMb?: number;
  timeoutMs?: number;
};

export type RenderResult = {
  /** `<dir>/out.pdf`. */
  file: string;
  bytes: number;
  /** Wall-clock time of the child, start to exit. */
  ms: number;
  /** The highest resident size seen, in MB (sampled). */
  peakMb: number;
};

const here = path.dirname(fileURLToPath(import.meta.url));
/** Beside this module in src/ and in dist/ (build-assets.ts copies both files there). */
export const CHILD_ENTRY = path.join(here, 'child.mjs');
export const TEMPLATE = path.join(here, '..', 'template', 'report.typ');
/** The templates, by `report_runs.kind` (REPORT_KINDS): the inventory report, the insurance
 * report (D158, step-4 T18) and the vehicle history report (D51, step-5 T15). */
export const TEMPLATES = {
  inventory: TEMPLATE,
  insurance: path.join(here, '..', 'template', 'insurance.typ'),
  vehicle_history: path.join(here, '..', 'template', 'vehicle.typ'),
} as const;
export type TemplateKind = keyof typeof TEMPLATES;

const run = promisify(execFile);

/** Resident set size of `pid` in MB, or null once it is gone. */
async function rssMb(pid: number): Promise<number | null> {
  try {
    if (process.platform === 'linux') {
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const kb = /^VmRSS:\s+(\d+)\s+kB/m.exec(status)?.[1];
      return kb ? Number(kb) / 1024 : null;
    }
    const { stdout } = await run('ps', ['-o', 'rss=', '-p', String(pid)]);
    const kb = Number(stdout.trim());
    return Number.isFinite(kb) && kb > 0 ? kb / 1024 : null;
  } catch {
    return null;
  }
}

/**
 * Renders `<dir>/data.json` (with `<dir>/thumbs/*.jpg` and `<dir>/qr/*.svg`) to `<dir>/out.pdf`
 * with the kind's template (report.typ by default). `dir` is the caller's scratch directory; the
 * caller removes it.
 */
export async function renderPdf(
  dir: string,
  opts: RenderOptions = {},
  template: TemplateKind = 'inventory',
): Promise<RenderResult> {
  const memoryMb = opts.memoryMb ?? RENDER_MEMORY_MB;
  const timeoutMs = opts.timeoutMs ?? RENDER_TIMEOUT_MS;
  const fonts = await ensureFonts();
  const started = performance.now();

  const child = spawn(
    process.execPath,
    [`--max-old-space-size=${CHILD_HEAP_MB}`, CHILD_ENTRY, dir, TEMPLATES[template], fonts],
    // No inherited environment: the child needs none of the server's settings or secrets.
    { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 4000) stderr += chunk;
  });
  child.stdout.resume();

  let killedFor: RenderErrorCode | null = null;
  let peakMb = 0;
  const kill = (why: RenderErrorCode) => {
    if (killedFor) return;
    killedFor = why;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => kill('timeout'), timeoutMs);
  let polling = false;
  const poll = setInterval(() => {
    if (polling || child.pid === undefined) return;
    polling = true;
    void rssMb(child.pid).then((mb) => {
      polling = false;
      if (mb === null) return;
      peakMb = Math.max(peakMb, mb);
      if (mb > memoryMb) kill('memory');
    });
  }, POLL_MS);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  ).finally(() => {
    clearTimeout(timer);
    clearInterval(poll);
  });
  const ms = Math.round(performance.now() - started);

  if (killedFor === 'timeout') {
    throw new RenderError('timeout', `the report took longer than ${timeoutMs} ms to render`);
  }
  if (killedFor === 'memory') {
    throw new RenderError('memory', `the report needed more than ${memoryMb} MB to render`);
  }
  if (exit.code !== 0) {
    // The OOM killer (SIGKILL we didn't send) is memory too.
    if (exit.signal === 'SIGKILL') throw new RenderError('memory', 'the renderer was killed');
    throw new RenderError(
      'render',
      `the renderer failed (${exit.code ?? exit.signal}): ${stderr.trim().slice(0, 1000)}`,
    );
  }
  const file = path.join(dir, 'out.pdf');
  const { size } = await stat(file);
  return { file, bytes: size, ms, peakMb: Math.round(peakMb) };
}

/** Writes the template's data file into `dir`. */
export function writeData(dir: string, data: unknown): Promise<void> {
  return writeFile(path.join(dir, 'data.json'), JSON.stringify(data));
}
