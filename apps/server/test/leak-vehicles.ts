import type pg from 'pg';
import type { Tenant } from './tenancy.js';

// Step 5's fixture rows for the leak test (test/leak.test.ts, fillTenant()), after steps 2–4
// (test/leak-inventory.ts, test/leak-capture.ts, test/leak-household.ts): the vehicle columns and
// tables, for each tenant. Written as kept_owner inside fillTenant()'s transaction.

/** Fills `t`'s location. The inventory, capture and household rows are already there. */
export async function fillVehicles(c: pg.ClientBase, t: Tenant, label: string): Promise<void> {
  const one = async (sql: string, values: unknown[]) =>
    (await c.query<{ id: string }>(sql, values)).rows[0]?.id as string;
  const meter = await one(
    `SELECT m.id FROM public.meters m JOIN public.things x ON x.id = m.thing_id
      WHERE m.location_id = $1 AND x.name = $2`,
    [t.locationId, `${label} box`],
  );

  // Meters and readings (T4): the box's nudge, and a reading with its proof photo on it.
  await c.query('UPDATE public.meters SET nudge_days = 45 WHERE id = $1', [meter]);
  const reading = await one(
    `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, source, logged_by)
     VALUES ($1, $2, 14, now() - interval '1 hour', 'photo', $3) RETURNING id`,
    [t.locationId, meter, t.userId],
  );
  await c.query(
    `INSERT INTO public.attachments (location_id, url, meter_reading_id, role, created_by)
     VALUES ($1, $2, $3, 'proof', $4)`,
    [t.locationId, `https://example.test/${label}/proof`, reading, t.userId],
  );

  // Service drafts (T5): a draft service of the box with its invoice, read by an extraction.
  const draft = await one(
    `INSERT INTO public.service_records (location_id, thing_id, serviced_on, review_state,
                                         logged_by)
     SELECT $1, x.id, '2026-09-25', 'draft', $3 FROM public.things x
      WHERE x.location_id = $1 AND x.name = $2
     RETURNING id`,
    [t.locationId, `${label} box`, t.userId],
  );
  const invoice = await one(
    `INSERT INTO public.attachments (location_id, url, service_record_id, role, created_by)
     VALUES ($1, $2, $3, 'receipt', $4) RETURNING id`,
    [t.locationId, `https://example.test/${label}/invoice`, draft, t.userId],
  );
  await c.query(
    `INSERT INTO public.extractions (location_id, attachment_id, service_record_id, mode, status,
                                     requested_by)
     VALUES ($1, $2, $3, 'receipt', 'succeeded', $4)`,
    [t.locationId, invoice, draft, t.userId],
  );

  // Fuel, document costs and the report's thing (T6): a fill of the box at the account's vendor
  // with its own reading and a pump receipt, a cost on the location's insurance document, and a
  // vehicle history report of the box.
  const box = await one('SELECT thing_id AS id FROM public.meters WHERE id = $1', [meter]);
  const odometer = await one(
    `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at, source, logged_by)
     VALUES ($1, $2, 15, now() - interval '30 minutes', 'fuel', $3) RETURNING id`,
    [t.locationId, meter, t.userId],
  );
  const fill = await one(
    `INSERT INTO public.fuel_entries (location_id, thing_id, taken_at, amount, unit, currency,
                                      cost, vendor_id, meter_reading_id, logged_by)
     VALUES ($1, $2, now() - interval '30 minutes', 38.5, 'L', 'EGP', 577.5,
             (SELECT id FROM public.vendors WHERE owner_account_id = $3 AND name = $4), $5, $6)
     RETURNING id`,
    [t.locationId, box, t.accountId, `${label} vendor`, odometer, t.userId],
  );
  await c.query(
    `INSERT INTO public.attachments (location_id, url, fuel_entry_id, role, created_by)
     VALUES ($1, $2, $3, 'receipt', $4)`,
    [t.locationId, `https://example.test/${label}/pump`, fill, t.userId],
  );
  await c.query(
    `UPDATE public.expiring_documents SET issued_on = expires_on - 365, cost = 1250,
                                          currency = 'EGP'
      WHERE location_id = $1`,
    [t.locationId],
  );
  await c.query(
    `INSERT INTO public.report_runs (user_id, location_id, location_ids, kind, thing_id, status)
     VALUES ($1, $2, ARRAY[$2::uuid], 'vehicle_history', $3, 'done')`,
    [t.userId, t.locationId, box],
  );
}
