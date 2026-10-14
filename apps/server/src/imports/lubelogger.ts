import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { logFuel } from '../fuel/service.js';
import type { KeptApp } from '../http/app.js';
import { AppError, invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedWrite } from '../http/write.js';
import { createReading } from '../meters/service.js';
import { requireModule } from '../schedules/service.js';
import { createService, noonOf } from '../schedules/services.js';
import { type Ctx, requireRole } from '../things/service.js';
import { liveThingOf, odometerOf } from '../vehicles/meters.js';

// LubeLogger import (1.3, D229; D170: "a LubeLogger CSV importer for fuel, service and odometer
// history"). LubeLogger exports one CSV per record type per vehicle, with no vehicle column
// (read from its source, hargata/lubelog at dd69e59b27: Controllers/Vehicle/ImportController.cs
// ExportFromVehicleToCsv, Helper/StaticHelper.cs Write*ExportModel):
//   - fuel ("gas records"): Date, Odometer, FuelConsumed, Cost, FuelEconomy, IsFillToFull,
//     MissedFuelUp[, StartingSoc, EndingSoc], Notes, Tags, extrafield_…
//   - service, repair and upgrade records: Date, Description, Cost, Notes, Odometer, Tags, …
//   - odometer records: Date, InitialOdometer, Odometer, Notes, Tags, …
// Dates and money are written in the LubeLogger server's culture (`ToShortDateString()`, a gas
// record's `ToString()` with the time, a service's cost as currency `"C"`), and the fuel volume
// in that vehicle's unit, none of which the file says. So the person says: the date order, the
// decimal mark, the fuel unit; the web parses the file (papaparse, as the CSV import does) and
// sends the rows.
//
// POST /api/v1/things/:id/import/lubelogger
//   {kind: 'fuel'|'service'|'odometer', rows: [{column: value}] (≤ 5,000), dateOrder: 'mdy'|'dmy'|
//    'ymd', decimal: '.'|',', fuelUnit?: 'L'|'gal', currency?, dryRun?}
//   → {created, skipped, issues: [{row, code}], dryRun}
// The vehicle's owners and admins (as any import, location.export-import), with Vehicles on (and
// Fuel for fuel). Rows go in oldest first through the same code as by hand (logFuel, createService,
// createReading with source `import`), each audited, each in its own savepoint: a bad row is an
// issue, never the end of the import. What each row became is kept in import_source_ids, keyed by
// the row's own content, so importing the same file again adds nothing. A dry run does it all and
// rolls it back, so its counts and issues are exactly what the import will do.

export const LUBELOGGER_KINDS = ['fuel', 'service', 'odometer'] as const;
export const LUBELOGGER_MAX_ROWS = 5000;

const Body = z
  .object({
    kind: z.enum(LUBELOGGER_KINDS),
    rows: z
      .array(z.record(z.string().max(200), z.string().max(4000)))
      .min(1)
      .max(LUBELOGGER_MAX_ROWS),
    dateOrder: z.enum(['mdy', 'dmy', 'ymd']),
    decimal: z.enum(['.', ',']),
    fuelUnit: z.enum(['L', 'gal']).optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();
type Body = z.infer<typeof Body>;

const Result = z.object({
  created: z.number().int(),
  skipped: z.number().int(),
  issues: z.array(z.object({ row: z.number().int(), code: z.string() })),
  dryRun: z.boolean(),
});

/** The columns each kind can't do without. */
const REQUIRED: Record<Body['kind'], string[]> = {
  fuel: ['Date', 'FuelConsumed'],
  service: ['Date', 'Description'],
  odometer: ['Date', 'Odometer'],
};

/** `YYYY-MM-DD` from a culture-formatted date (a time after it is ignored), or null. */
export function lubeDate(raw: string | undefined, order: Body['dateOrder']): string | null {
  const m = /^\s*(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})/.exec(raw ?? '');
  if (!m) return null;
  const [a, b, c] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
  let [y, mo, d] =
    order === 'ymd' ? [a, b, c] : order === 'mdy' ? [c, a, b] : ([c, b, a] as number[]);
  if ((y as number) < 100) y = 2000 + (y as number);
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const back = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(back.getTime()) || back.toISOString().slice(0, 10) !== iso ? null : iso;
}

/** A decimal string from a culture-formatted number ("$1,234.56", "1.234,56 €"), or null. A
 * blank is null too; a negative is refused by the caller. */
export function lubeNumber(raw: string | undefined, decimal: Body['decimal']): string | null {
  const kept = (raw ?? '').replace(/[^\d.,-]/g, '');
  if (!kept) return null;
  const plain =
    decimal === '.' ? kept.replace(/,/g, '') : kept.replace(/\./g, '').replace(',', '.');
  return /^-?\d+(\.\d+)?$/.test(plain) ? plain : null;
}

const truthy = (raw: string | undefined, fallback: boolean) => {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes') return true;
  if (v === 'false' || v === '0' || v === 'no') return false;
  return fallback;
};

/** The row's own content, hashed: the same row in a second import is the same id. */
const sourceIdOf = (kind: Body['kind'], row: Record<string, string>) =>
  `${kind}:${createHash('sha256')
    .update(JSON.stringify(Object.entries(row).sort(([x], [y]) => x.localeCompare(y))))
    .digest('hex')
    .slice(0, 48)}`;

const ENTITY: Record<Body['kind'], 'fuel_entry' | 'service_record' | 'reading'> = {
  fuel: 'fuel_entry',
  service: 'service_record',
  odometer: 'reading',
};

/** Thrown at the end of a dry run to roll everything back through the savepoint. */
class DryRun extends Error {}

export async function lubeloggerRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  app.post(
    '/api/v1/things/:id/import/lubelogger',
    {
      bodyLimit: 8 * 1024 * 1024,
      schema: { params: z.object({ id: z.uuid() }), body: Body, response: { 200: Result } },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const ctx: Ctx = {
          tx,
          client,
          scope,
          requestId: req.id,
          jobs: deps.jobs,
          files: deps.files,
        };
        const body = req.body;
        const thing = await liveThingOf(client, req.params.id);
        const locationId = thing.location_id;
        await requireRole(client, locationId, 'location.export-import');
        await requireModule(ctx, locationId, 'vehicles', 'write');
        if (body.kind === 'fuel') await requireModule(ctx, locationId, 'fuel', 'write');
        const missing = REQUIRED[body.kind].filter((c) => !(c in (body.rows[0] ?? {})));
        if (missing.length > 0) {
          throw invalid(`This isn't a LubeLogger ${body.kind} export: no ${missing.join(', ')}.`);
        }
        if (body.kind === 'fuel' && !body.fuelUnit) throw invalid('fuelUnit: litres or gallons.');
        const meter = await odometerOf(client, thing.id);
        // Money without a currency is in the location's own (a service needs one said).
        const currency =
          body.currency ??
          (
            await client.query<{ currency: string }>(
              'SELECT currency FROM public.locations WHERE id = $1',
              [locationId],
            )
          ).rows[0]?.currency;

        const issues: Array<{ row: number; code: string }> = [];
        // Oldest first, so the odometer only goes forwards.
        const dated = body.rows
          .map((row, i) => ({ row, n: i + 1, day: lubeDate(row.Date, body.dateOrder) }))
          .filter((r) => {
            if (!r.day) issues.push({ row: r.n, code: 'date' });
            return r.day !== null;
          })
          .sort((x, y) => (x.day as string).localeCompare(y.day as string) || x.n - y.n);

        let created = 0;
        let skipped = 0;
        const runId = newId();
        const work = async () => {
          await client.query(
            `INSERT INTO public.import_runs (id, location_id, source, status, created_by, choices,
                                             total, started_at)
             VALUES ($1, $2, 'lubelogger_csv', 'running', kept.current_user_id(), $3::jsonb, $4,
                     now())`,
            [
              runId,
              locationId,
              JSON.stringify({
                kind: body.kind,
                thingId: thing.id,
                dateOrder: body.dateOrder,
                decimal: body.decimal,
                fuelUnit: body.fuelUnit ?? null,
              }),
              body.rows.length,
            ],
          );
          for (const { row, n, day } of dated) {
            const sid = sourceIdOf(body.kind, row);
            const seen = await client.query(
              `SELECT 1 FROM public.import_source_ids
                WHERE location_id = $1 AND source = 'lubelogger_csv' AND source_id = $2`,
              [locationId, sid],
            );
            if ((seen.rowCount ?? 0) > 0) {
              skipped += 1;
              continue;
            }
            const odometer = lubeNumber(row.Odometer, '.');
            const cost = lubeNumber(row.Cost, body.decimal);
            if (cost?.startsWith('-')) {
              issues.push({ row: n, code: 'cost' });
              continue;
            }
            try {
              const entityId = await withSavepoint(client, async () => {
                if (body.kind === 'fuel') {
                  const amount = lubeNumber(row.FuelConsumed, body.decimal);
                  if (!amount || Number(amount) <= 0) throw new RowIssue('amount');
                  const made = await logFuel(ctx, thing.id, {
                    takenAt: await noonOf(client, locationId, day as string),
                    amount,
                    unit: body.fuelUnit as 'L' | 'gal',
                    ...(cost && Number(cost) > 0
                      ? { cost, ...(currency ? { currency } : {}) }
                      : {}),
                    isFull: truthy(row.IsFillToFull, true),
                    missedBefore: truthy(row.MissedFuelUp, false),
                    ...(meter && odometer && Number(odometer) > 0
                      ? { reading: { meterId: meter.id, value: odometer } }
                      : {}),
                    ...(row.Notes?.trim() ? { note: row.Notes.trim().slice(0, 500) } : {}),
                  });
                  return made.entry.id;
                }
                if (body.kind === 'service') {
                  const description = (row.Description ?? '').trim().slice(0, 200);
                  if (!description) throw new RowIssue('description');
                  const made = await createService(ctx, {
                    subject: { thingId: thing.id },
                    servicedOn: day as string,
                    ...(meter && odometer && Number(odometer) > 0
                      ? { reading: { meterId: meter.id, value: odometer } }
                      : {}),
                    ...(cost && Number(cost) > 0
                      ? { total: cost, ...(currency ? { currency } : {}) }
                      : {}),
                    lines: [{ kind: 'other', description }],
                    ...(row.Notes?.trim() ? { notes: row.Notes.trim().slice(0, 2000) } : {}),
                  });
                  return made.id;
                }
                if (!meter) throw new RowIssue('no_odometer');
                if (!odometer || Number(odometer) <= 0) throw new RowIssue('odometer');
                const made = await createReading(
                  ctx,
                  meter.id,
                  {
                    value: odometer,
                    takenAt: await noonOf(client, locationId, day as string),
                    ...(row.Notes?.trim() ? { note: row.Notes.trim().slice(0, 500) } : {}),
                  },
                  'import',
                );
                return made.reading.id;
              });
              await client.query(
                `INSERT INTO public.import_source_ids
                   (location_id, source, source_id, entity_type, entity_id, run_id)
                 VALUES ($1, 'lubelogger_csv', $2, $3, $4, $5)`,
                [locationId, sid, ENTITY[body.kind], entityId, runId],
              );
              created += 1;
            } catch (err) {
              issues.push({ row: n, code: issueCode(err) });
            }
          }
          await client.query(
            `UPDATE public.import_runs SET status = 'done', progress = $2, finished_at = now()
              WHERE id = $1`,
            [runId, body.rows.length],
          );
          if (body.dryRun) throw new DryRun();
        };
        try {
          await withSavepoint(client, work);
        } catch (err) {
          if (!(err instanceof DryRun)) throw err;
        }
        issues.sort((a, b) => a.row - b.row);
        return {
          status: 200,
          body: { created, skipped, issues: issues.slice(0, 500), dryRun: body.dryRun === true },
        };
      }),
  );
}

let savepoints = 0;
/** Runs `fn` inside a savepoint: undone on a throw (which goes on), kept otherwise. */
async function withSavepoint<T>(client: pg.ClientBase, fn: () => Promise<T>): Promise<T> {
  const name = `lube_${++savepoints}`;
  await client.query(`SAVEPOINT ${name}`);
  try {
    const out = await fn();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return out;
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
    throw err;
  }
}

/** A row that can't go in, with its reason. */
class RowIssue extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function issueCode(err: unknown): string {
  if (err instanceof RowIssue) return err.code;
  if (err instanceof AppError) {
    // A reading that runs backwards, a day in the future, a currency the location lacks…
    if (err.code === 'conflict') return 'odometer_backwards';
    return err.code;
  }
  return 'internal';
}
