import { createHash } from 'node:crypto';
import { newId } from '@kept/shared';
import type pg from 'pg';
import type { Tenant } from './tenancy.js';

// Step 4's fixture rows for the leak test (test/leak.test.ts, fillTenant()), after steps 2 and 3
// (test/leak-inventory.ts, test/leak-capture.ts): one or more rows in every household table, for
// each tenant. Written as kept_owner inside fillTenant()'s transaction.

/** Fills `t`'s account and location. The inventory and capture rows are already there. */
export async function fillHousehold(c: pg.ClientBase, t: Tenant, label: string): Promise<void> {
  const one = async (sql: string, values: unknown[]) =>
    (await c.query<{ id: string }>(sql, values)).rows[0]?.id as string;
  const thing = await one('SELECT id FROM public.things WHERE location_id = $1 AND name = $2', [
    t.locationId,
    `${label} thing`,
  ]);

  // Money (T4): a rate on the account, a valuation of the room thing, an incident that touched
  // it, and a claim pack of that incident with a live link.
  await c.query(
    `INSERT INTO public.fx_rates (owner_account_id, from_ccy, to_ccy, rate, valid_from, created_by)
     VALUES ($1, 'USD', 'EGP', 48.5, '2026-09-01', $2)`,
    [t.accountId, t.userId],
  );
  await c.query(
    `INSERT INTO public.valuations (location_id, thing_id, value, currency, valued_on, source,
                                    created_by)
     VALUES ($1, $2, 1200, 'EGP', '2026-09-15', 'estimate', $3)`,
    [t.locationId, thing, t.userId],
  );
  const incident = newId();
  await c.query(
    `INSERT INTO public.incidents (id, location_id, kind, occurred_on, created_by)
     VALUES ($1, $2, 'flood', '2026-09-20', $3)`,
    [incident, t.locationId, t.userId],
  );
  await c.query(
    `INSERT INTO public.incident_things (location_id, incident_id, thing_id) VALUES ($1, $2, $3)`,
    [t.locationId, incident, thing],
  );
  const run = newId();
  await c.query(
    `INSERT INTO public.export_runs (id, location_id, kind, incident_id, status, storage_key,
                                     bytes, created_by, token_hash, token_expires_at, finished_at)
     VALUES ($1, $2, 'claim_pack', $3, 'done', $4, 2048, $5, $6, now() + interval '3 days', now())`,
    [
      run,
      t.locationId,
      incident,
      `x/${run}.zip`,
      t.userId,
      createHash('sha256').update(`${label}-pack`).digest('hex'),
    ],
  );

  // Brand logos (0057): the account brand's PNG (a 1×1 pixel).
  await c.query(
    `INSERT INTO public.brand_logos (brand_id, owner_account_id, png, width, height, sha256,
                                     created_by)
     SELECT b.id, b.owner_account_id, decode($3, 'base64'), 1, 1, $4, $5
       FROM public.brands b WHERE b.owner_account_id = $1 AND b.name = $2`,
    [
      t.accountId,
      `${label} brand`,
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      createHash('sha256').update(`${label}-logo`).digest('hex'),
      t.userId,
    ],
  );

  // Records (T5): a warranty on the room thing, a claim under it at the account's vendor, an
  // open loan of it to the account's person, a service of it with one line, and a link
  // attachment on each new subject.
  const vendor = await one(
    'SELECT id FROM public.vendors WHERE owner_account_id = $1 AND name = $2',
    [t.accountId, `${label} vendor`],
  );
  const person = await one(
    'SELECT id FROM public.people WHERE owner_account_id = $1 AND display_name = $2',
    [t.accountId, `${label} person`],
  );
  const warranty = newId();
  await c.query(
    `INSERT INTO public.warranties (id, location_id, thing_id, kind, starts_on, term_months,
                                    created_by)
     VALUES ($1, $2, $3, 'manufacturer', '2026-01-15', 24, $4)`,
    [warranty, t.locationId, thing, t.userId],
  );
  const claim = newId();
  await c.query(
    `INSERT INTO public.claims (id, location_id, thing_id, warranty_id, incident_id, opened_on,
                                vendor_id, status, created_by)
     VALUES ($1, $2, $3, $4, $5, '2026-09-21', $6, 'in_repair', $7)`,
    [claim, t.locationId, thing, warranty, incident, vendor, t.userId],
  );
  const loan = newId();
  await c.query(
    `INSERT INTO public.loans (id, location_id, thing_id, direction, person_id, started_at, due_on,
                               created_by)
     VALUES ($1, $2, $3, 'out', $4, now() - interval '10 days', current_date - 1, $5)`,
    [loan, t.locationId, thing, person, t.userId],
  );
  const service = newId();
  await c.query(
    `INSERT INTO public.service_records (id, location_id, thing_id, serviced_on, vendor_id, total,
                                         currency, logged_by)
     VALUES ($1, $2, $3, '2026-09-10', $4, 350, 'EGP', $5)`,
    [service, t.locationId, thing, vendor, t.userId],
  );
  await c.query(
    `INSERT INTO public.service_lines (location_id, service_record_id, kind, description, quantity,
                                       unit_cost)
     VALUES ($1, $2, 'part', 'Filter', 1, 350)`,
    [t.locationId, service],
  );
  const valuation = await one('SELECT id FROM public.valuations WHERE thing_id = $1 LIMIT 1', [
    thing,
  ]);

  // Schedules (T6): a boiler service every 12 months on the room, completed by a service of the
  // room; a one-off on the room thing; a home-insurance document on the location itself.
  const room = await one('SELECT id FROM public.places WHERE location_id = $1 AND name = $2', [
    t.locationId,
    `${label} room`,
  ]);
  const boiler = newId();
  await c.query(
    `INSERT INTO public.schedules (id, location_id, place_id, name, every_months, anchor_on,
                                   created_by)
     VALUES ($1, $2, $3, 'Boiler service', 12, '2025-10-01', $4)`,
    [boiler, t.locationId, room, t.userId],
  );
  await c.query(
    `INSERT INTO public.schedules (location_id, thing_id, name, due_on, anchor_on, created_by)
     VALUES ($1, $2, 'Descale', current_date + 3, current_date, $3)`,
    [t.locationId, thing, t.userId],
  );
  const roomService = newId();
  await c.query(
    `INSERT INTO public.service_records (id, location_id, place_id, serviced_on, logged_by)
     VALUES ($1, $2, $3, '2026-09-01', $4)`,
    [roomService, t.locationId, room, t.userId],
  );
  await c.query(
    `INSERT INTO public.service_completions (location_id, service_record_id, schedule_id)
     VALUES ($1, $2, $3)`,
    [t.locationId, roomService, boiler],
  );
  const document = newId();
  await c.query(
    `INSERT INTO public.expiring_documents (id, location_id, kind, expires_on, created_by)
     VALUES ($1, $2, 'insurance', current_date + 20, $3)`,
    [document, t.locationId, t.userId],
  );

  // Reminders (T7): the overdue loan's occurrence, the tenant user's three channels, a push
  // device, a preference, the centre's row, a delivery, a digest and a calendar link.
  const occurrence = newId();
  await c.query(
    `INSERT INTO public.reminder_occurrences (id, location_id, thing_id, source_type, source_id,
                                              kind, due_period, due_on)
     VALUES ($1, $2, $3, 'loan', $4, 'overdue', 'date:' || (current_date - 1)::text,
             current_date - 1)`,
    [occurrence, t.locationId, thing, loan],
  );
  const email = newId();
  await c.query(
    `INSERT INTO public.notification_channels (id, user_id, kind) VALUES ($1, $2, 'email')`,
    [email, t.userId],
  );
  await c.query(`INSERT INTO public.notification_channels (user_id, kind) VALUES ($1, 'webpush')`, [
    t.userId,
  ]);
  await c.query(
    `INSERT INTO public.notification_channels (user_id, kind, label, display_host,
                                               config_ciphertext, key_version)
     VALUES ($1, 'webhook', 'n8n', 'hooks.example.test', '{"v": 1, "c": "not a url"}', 1)`,
    [t.userId],
  );
  await c.query(
    `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
     VALUES ($1, $2, 'p256dh-key', 'auth-key')`,
    [t.userId, `https://push.example.test/${label}/${newId()}`],
  );
  await c.query(
    `INSERT INTO public.notification_preferences (user_id, location_id, kind, channel, enabled)
     VALUES ($1, $2, 'loan', 'email', true), ($1, NULL, 'ai_summary', 'email', false)`,
    [t.userId, t.locationId],
  );
  await c.query(
    `INSERT INTO public.notifications (user_id, location_id, occurrence_id, kind, payload)
     VALUES ($1, $2, $3, 'reminder', jsonb_build_object('sourceType', 'loan'))`,
    [t.userId, t.locationId, occurrence],
  );
  await c.query(
    `INSERT INTO public.reminder_deliveries (occurrence_id, user_id, channel_id, status)
     VALUES ($1, $2, $3, 'digest')`,
    [occurrence, t.userId, email],
  );
  await c.query(
    `INSERT INTO public.notification_digests (user_id, digest_on, channel_id, sent_at)
     VALUES ($1, current_date - 1, $2, now())`,
    [t.userId, email],
  );
  await c.query(`INSERT INTO public.calendar_feeds (user_id, token_hash) VALUES ($1, $2)`, [
    t.userId,
    createHash('sha256').update(`${label}-feed`).digest('hex'),
  ]);

  for (const [column, subject] of [
    ['warranty_id', warranty],
    ['claim_id', claim],
    ['loan_id', loan],
    ['incident_id', incident],
    ['valuation_id', valuation],
    ['service_record_id', service],
    ['expiring_document_id', document],
  ] as const) {
    await c.query(
      `INSERT INTO public.attachments (location_id, url, ${column}, role, created_by)
       VALUES ($1, $2, $3, 'document', $4)`,
      [t.locationId, `https://example.test/${label}/${column}`, subject, t.userId],
    );
  }
}
