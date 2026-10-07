/**
 * Mock handlers for CSV import (T18): owners and admins only; at most 10,000 rows (413 past it);
 * a dry run reports each row as mapped, as text or skipped, with why (§5), and only before the
 * run starts; the run needs a dry run first (409 on a draft, as the server answers). The run
 * moves one chunk (200 rows) each time it's read, so progress, cancel and resume can be seen; a
 * failed run resumes from where it stopped.
 *
 * The dry run is a small model of the server's row mapper (apps/server/src/imports/dry-run.ts):
 * the same issue codes for no name, a repeated row, a quantity, date or price that doesn't read,
 * types not matched by name, a place that isn't there, and a code used twice.
 */
import {
  CSV_LIMITS,
  type ImportIssue,
  type ImportIssueCode,
  type ImportIssueParams,
  parseAmount,
  parseCsvDate,
  splitPlacePath,
} from '@kept/shared';
import { accessOf, newId, now } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import {
  err,
  forbidden,
  type MockRoute,
  notFound,
  reply,
  route,
  sessionGate,
} from '../../mock/kit';
import { capturePaths as p } from '../paths';
import type { CreateImportBody, DryRunReport, ImportChoices, ImportRun } from '../types';

/** Rows per chunk, as the server's job (imports/job.ts CHUNK). */
const CHUNK = 200;

const EASTERN = /[٠-٩۰-۹]/g;
const fold = (s: string) =>
  s.replace(EASTERN, (d) => {
    const c = d.charCodeAt(0);
    return String(c >= 0x06f0 ? c - 0x06f0 : c - 0x0660);
  });

/** The mock's dry run over parsed rows; see the file's header. */
export function mockDryRun(
  columns: string[],
  rows: string[][],
  mapping: Record<string, string>,
  choices: ImportChoices,
): DryRunReport {
  const report: DryRunReport = {
    summary: { things: 0, places: 0, purchases: 0, legacyCodes: 0, skipped: 0, asText: 0 },
    rows: [],
  };
  const seen = new Map<string, number>();
  const codes = new Set<string>();
  const places = new Set<string>();
  const cellsOf = (row: string[], field: string) =>
    columns
      .map((column, i) => ({ column, value: (row[i] ?? '').trim() }))
      .filter((c) => mapping[c.column] === field && c.value !== '');

  rows.forEach((row, index) => {
    const rowNo = index + 1;
    const issues: ImportIssue[] = [];
    const add = (
      column: string,
      code: ImportIssueCode,
      message: string,
      params?: ImportIssueParams,
    ) => issues.push(params ? { column, code, params, message } : { column, code, message });
    let asText = false;
    const text = (...a: Parameters<typeof add>) => {
      asText = true;
      add(...a);
    };

    const name = cellsOf(row, 'name')[0];
    const key = JSON.stringify(row.map((c) => c.trim()));
    const earlier = seen.get(key);
    if (!name) {
      add(columns.find((c) => mapping[c] === 'name') ?? '', 'no_name', 'No name.');
    } else if (earlier !== undefined) {
      add('', 'same_as_row', `The same as row ${earlier}.`, { row: earlier });
    }
    if (issues.length > 0) {
      report.summary.skipped += 1;
      report.rows.push({ row: rowNo, status: 'skipped', issues });
      return;
    }
    seen.set(key, rowNo);

    for (const c of cellsOf(row, 'quantity')) {
      if (!/^\d{1,9}(?:\.\d{1,3})?$/.test(fold(c.value).replace(/٫/g, '.'))) {
        text(c.column, 'not_quantity', 'Not a quantity.');
      }
    }
    for (const c of cellsOf(row, 'type')) {
      if (!choices.typeByName)
        text(c.column, 'types_not_matched', 'Types are not matched by name.');
    }
    let purchase = false;
    const price = cellsOf(row, 'price')[0];
    const date = cellsOf(row, 'purchased_on')[0];
    if (date && !parseCsvDate(date.value, choices.dateFormat)) {
      text(date.column, 'not_date', `Not a date as ${choices.dateFormat}.`, {
        format: choices.dateFormat,
      });
    }
    if (price) {
      let ok = true;
      try {
        parseAmount(price.value.replace(/\s/g, ''));
      } catch {
        ok = false;
        text(price.column, 'not_price', 'Not a price.');
      }
      if (ok && !date) text(price.column, 'needs_date', 'A price needs a purchase date.');
      purchase = ok && !!date && !!parseCsvDate(date.value, choices.dateFormat);
    }
    const path = cellsOf(row, 'place_path')[0];
    if (path) {
      const names = splitPlacePath(path.value, choices.placeSeparator);
      if (names.length > 0 && !choices.createPlaces) {
        text(path.column, 'no_such_place', 'No such place; it goes to the default place.');
      } else {
        names.forEach((_, i) => {
          places.add(names.slice(0, i + 1).join('\u0000'));
        });
      }
    }
    for (const c of [...cellsOf(row, 'legacy_code'), ...cellsOf(row, 'own_code')]) {
      const code = fold(c.value).toUpperCase();
      if (codes.has(code)) {
        add(c.column, 'code_taken', 'This code is already on something else.');
      } else {
        codes.add(code);
        report.summary.legacyCodes += 1;
      }
    }

    report.summary.things += 1;
    if (purchase) report.summary.purchases += 1;
    if (asText) report.summary.asText += 1;
    report.rows.push({ row: rowNo, status: asText ? 'text' : 'ok', issues });
  });
  report.summary.places = places.size;
  return report;
}

export function importsRoutes(state: MockState): MockRoute[] {
  const cap = () => state.capture;
  const access = () => accessOf(state);
  /** The run's rows, kept until it's done (the server clears them then). */
  const rowsOf = new Map<string, { columns: string[]; rows: string[][] }>();
  const find = (id: string | undefined) => {
    const run = cap().imports.find((r) => r.id === id);
    return run && access().isAdmin(run.locationId) ? run : undefined;
  };
  const touch = (run: ImportRun) => {
    run.updatedAt = now();
    run.rowVersion += 1;
  };
  /** A running run moves one chunk each time it's read. */
  const tick = (run: ImportRun) => {
    if (run.status !== 'running') return;
    run.progress = Math.min(run.total ?? 0, run.progress + CHUNK);
    if (run.progress >= (run.total ?? 0)) {
      run.status = 'done';
      run.finishedAt = now();
      rowsOf.delete(run.id);
    }
    touch(run);
  };

  return [
    route('POST', p.importsCsv, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as CreateImportBody;
      if (!access().visible(b.locationId)) return notFound();
      if (!access().isAdmin(b.locationId)) return forbidden();
      if (b.rows.length > CSV_LIMITS.rows)
        return err(413, 'payload_too_large', `At most ${CSV_LIMITS.rows} rows.`);
      if (!Object.values(b.mapping).includes('name'))
        return err(400, 'validation', 'Check body.mapping: map a column to name.');
      const run: ImportRun = {
        id: b.id ?? newId(),
        locationId: b.locationId,
        source: 'csv',
        status: 'draft',
        mapping: b.mapping,
        choices: b.choices,
        progress: 0,
        total: b.rows.length,
        createdAt: now(),
        startedAt: null,
        finishedAt: null,
        error: null,
        updatedAt: now(),
        rowVersion: 1,
      };
      rowsOf.set(run.id, { columns: b.columns, rows: b.rows });
      cap().imports.unshift(run);
      return reply(201, run);
    }),

    route('POST', p.importDryRun(':id'), ({ params }) => {
      const run = find(params.id);
      if (!run) return notFound();
      if (run.status !== 'draft' && run.status !== 'checked')
        return err(409, 'conflict', `This import is ${run.status}; a dry run is before it starts.`);
      const data = rowsOf.get(run.id) ?? { columns: [], rows: [] };
      const report = mockDryRun(data.columns, data.rows, run.mapping, run.choices);
      run.status = 'checked';
      run.report = report;
      touch(run);
      return { report };
    }),

    route('POST', p.importStart(':id'), ({ params }) => {
      const run = find(params.id);
      if (!run) return notFound();
      if (run.status !== 'checked' && run.status !== 'failed')
        return err(
          409,
          'conflict',
          run.status === 'draft' ? 'Run the dry run first.' : `This import is ${run.status}.`,
        );
      run.status = 'running';
      run.startedAt ??= now();
      run.error = null;
      touch(run);
      return reply(202, run);
    }),

    route('GET', p.importRun(':id'), ({ params }) => {
      const run = find(params.id);
      if (!run) return notFound();
      tick(run);
      return run;
    }),

    route('GET', p.imports, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = query.get('locationId');
      return {
        items: cap()
          .imports.filter(
            (r) => access().isAdmin(r.locationId) && (!locationId || r.locationId === locationId),
          )
          .map(({ report: _r, ...r }) => r),
        next_cursor: null,
      };
    }),

    route('POST', p.importCancel(':id'), ({ params }) => {
      const run = find(params.id);
      if (!run) return notFound();
      if (run.status !== 'done' && run.status !== 'cancelled') {
        run.status = 'cancelled';
        run.finishedAt = now();
        rowsOf.delete(run.id);
        touch(run);
      }
      return run;
    }),
  ];
}
