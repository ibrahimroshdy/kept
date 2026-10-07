/**
 * Reads a CSV file on the phone or desktop (plan T30, Q18): papaparse, loaded only when a file is
 * chosen, and run in a worker for a large file so the page stays responsive. The file is read as
 * UTF-8, with its byte-order mark dropped (spreadsheet apps write one).
 *
 * Everything the server would refuse is refused here first, before anything is sent: a file over
 * 8 MB, more than 10,000 rows (not counting the header), more than 200 columns, or a cell over
 * 10,000 characters. Headers are made unique and never blank ("Notes", "Notes (2)", "Column 3"),
 * because the mapping names columns by their header; every row gets exactly one cell per column.
 */
import { CSV_LIMITS } from '@kept/shared';
import type { WorkerAnswer } from './parse-config';

/** The server's limits (apps/server/src/imports/csv.ts). */
export const COLUMNS_MAX = 200;
export const CELL_MAX = 10_000;
const HEADER_MAX = 200;
/** From this size, the file is parsed in a worker. */
const WORKER_FROM_BYTES = 256 * 1024;

export type ParsedCsv = {
  columns: string[];
  rows: string[][];
  /** The data row (1-based) of a quote that's never closed, when there is one. */
  unclosedQuoteRow: number | null;
};

export type ParseProblem =
  | { kind: 'too_big'; bytes: number }
  | { kind: 'too_many_rows'; rows: number }
  | { kind: 'too_many_columns'; columns: number }
  | { kind: 'cell_too_long'; row: number; column: string }
  | { kind: 'empty' }
  | { kind: 'unreadable' };

export class ParseError extends Error {
  constructor(readonly problem: ParseProblem) {
    super(problem.kind);
  }
}

/** Blank headers named by position, repeats numbered, all cut to the server's 200 characters. */
export function uniqueColumns(header: readonly string[], blank: (n: number) => string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  header.forEach((raw, i) => {
    const base = (raw.trim() || blank(i + 1)).slice(0, HEADER_MAX - 6);
    let name = base;
    for (let n = 2; seen.has(name); n++) name = `${base} (${n})`;
    seen.add(name);
    out.push(name);
  });
  return out;
}

async function parseText(text: string, size: number): Promise<WorkerAnswer> {
  if (size >= WORKER_FROM_BYTES && typeof Worker !== 'undefined') {
    const worker = new Worker(new URL('./csv.worker.ts', import.meta.url), { type: 'module' });
    try {
      return await new Promise<WorkerAnswer>((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<WorkerAnswer>) => resolve(e.data);
        worker.onerror = () => reject(new ParseError({ kind: 'unreadable' }));
        worker.postMessage(text);
      });
    } finally {
      worker.terminate();
    }
  }
  const [{ default: Papa }, { PARSE_CONFIG }] = await Promise.all([
    import('papaparse'),
    import('./parse-config'),
  ]);
  const result = Papa.parse<string[]>(text, PARSE_CONFIG);
  return { rows: result.data, error: result.errors.find((e) => e.type === 'Quotes')?.row ?? null };
}

/**
 * The file's columns and rows, or a ParseError saying what's wrong with it. `blank` names a
 * column with no header ("Column 3", translated).
 */
export async function parseCsvFile(file: Blob, blank: (n: number) => string): Promise<ParsedCsv> {
  if (file.size > CSV_LIMITS.bytes) throw new ParseError({ kind: 'too_big', bytes: file.size });
  let text: string;
  try {
    // Blob.text() decodes UTF-8 and drops a leading byte-order mark; the replace is for a file
    // that carries a second one.
    text = (await file.text()).replace(/^﻿/, '');
  } catch {
    throw new ParseError({ kind: 'unreadable' });
  }
  const { rows: all, error } = await parseText(text, file.size);
  const [header, ...data] = all;
  if (!header || data.length === 0) throw new ParseError({ kind: 'empty' });
  if (data.length > CSV_LIMITS.rows) {
    throw new ParseError({ kind: 'too_many_rows', rows: data.length });
  }
  // A row longer than the header adds columns with no header (named by position).
  let width = header.length;
  for (const r of data) if (r.length > width) width = r.length;
  if (width > COLUMNS_MAX) throw new ParseError({ kind: 'too_many_columns', columns: width });
  const columns = uniqueColumns(
    Array.from({ length: width }, (_, i) => header[i] ?? ''),
    blank,
  );
  const rows = data.map((r, i) => {
    const row = columns.map((_, c) => r[c] ?? '');
    const long = row.findIndex((cell) => cell.length > CELL_MAX);
    if (long >= 0) {
      throw new ParseError({ kind: 'cell_too_long', row: i + 1, column: columns[long] ?? '' });
    }
    return row;
  });
  // papaparse counts rows from 0 including the header; a data row is 1-based without it.
  return { columns, rows, unclosedQuoteRow: error === null ? null : Math.max(1, error) };
}
