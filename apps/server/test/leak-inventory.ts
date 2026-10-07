import { createHash } from 'node:crypto';
import { newId, randomShortCode } from '@kept/shared';
import type pg from 'pg';
import type { Tenant } from './tenancy.js';

// Step 2's fixture rows for the leak test (test/leak.test.ts, fillTenant()): one or more rows in
// every inventory table, for each tenant, so the catalogue-driven checks there have something of
// every table to aim at (a new table fails "has fixture rows" until a row is added here).
// Written as kept_owner inside fillTenant()'s transaction.

/** Fills `t`'s account and location. `room` is the place fillTenant() made. */
export async function fillInventory(
  c: pg.ClientBase,
  t: Tenant,
  label: string,
  room: string,
): Promise<void> {
  // Account registries (task 5): a place kind, a custom type under a built-in with a field of its
  // own, a brand, a vendor, a person with contact details, a tag.
  const kind = newId();
  await c.query(
    `INSERT INTO public.place_kinds (id, owner_account_id, key, name, icon)
     VALUES ($1, $2, 'shelf', $3, 'lucide:box')`,
    [kind, t.accountId, `${label} shelf`],
  );
  await c.query(
    `INSERT INTO public.type_fields (owner_account_id, place_kind_id, key, label, kind)
     VALUES ($1, $2, 'depth', 'Depth', 'number')`,
    [t.accountId, kind],
  );
  const type = newId();
  await c.query(
    `INSERT INTO public.types (id, owner_account_id, parent_id, name, icon)
     VALUES ($1, $2, (SELECT id FROM public.types
                       WHERE owner_account_id IS NULL AND builtin_key = 'electronics'),
             $3, 'lucide:box')`,
    [type, t.accountId, `${label} gadget`],
  );
  await c.query(
    `INSERT INTO public.type_fields (owner_account_id, type_id, key, label, kind)
     VALUES ($1, $2, 'gadget_code', 'Gadget code', 'text')`,
    [t.accountId, type],
  );
  const pinField = newId();
  await c.query(
    `INSERT INTO public.type_fields (id, owner_account_id, type_id, key, label, kind, secret)
     VALUES ($1, $2, $3, 'gadget_pin', 'PIN', 'text', true)`,
    [pinField, t.accountId, type],
  );
  await c.query(`INSERT INTO public.brands (owner_account_id, name) VALUES ($1, $2)`, [
    t.accountId,
    `${label} brand`,
  ]);
  await c.query(`INSERT INTO public.vendors (owner_account_id, name) VALUES ($1, $2)`, [
    t.accountId,
    `${label} vendor`,
  ]);
  const person = newId();
  await c.query(
    `INSERT INTO public.people (id, owner_account_id, display_name) VALUES ($1, $2, $3)`,
    [person, t.accountId, `${label} person`],
  );
  await c.query(
    `INSERT INTO public.person_contacts (person_id, owner_account_id, phone) VALUES ($1, $2, '1')`,
    [person, t.accountId],
  );
  const tag = newId();
  await c.query(`INSERT INTO public.tags (id, owner_account_id, name) VALUES ($1, $2, $3)`, [
    tag,
    t.accountId,
    `${label} tag`,
  ]);
  // A second tag, so the definer sweep has two rows of one registry to try merging.
  await c.query(`INSERT INTO public.tags (owner_account_id, name) VALUES ($1, $2)`, [
    t.accountId,
    `${label} other tag`,
  ]);

  // Things (task 6): one in the room, of the custom type, with a tag and a short ID; a box with a
  // thing inside; a link between the room thing and the box.
  const thing = newId();
  await c.query(
    `INSERT INTO public.things (id, location_id, place_id, type_id, name, belongs_to_person_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [thing, t.locationId, room, type, `${label} thing`, person],
  );
  await c.query(
    `INSERT INTO public.thing_tags (location_id, thing_id, tag_id) VALUES ($1, $2, $3)`,
    [t.locationId, thing, tag],
  );
  await c.query(`INSERT INTO public.short_ids (code, location_id, thing_id) VALUES ($1, $2, $3)`, [
    randomShortCode(),
    t.locationId,
    thing,
  ]);
  const box = newId();
  await c.query(
    `INSERT INTO public.things (id, location_id, place_id, type_id, name)
     VALUES ($1, $2, $3, (SELECT id FROM public.types
                           WHERE owner_account_id IS NULL AND builtin_key = 'box_bin'), $4)`,
    [box, t.locationId, room, `${label} box`],
  );
  await c.query(`INSERT INTO public.things (location_id, container_id, name) VALUES ($1, $2, $3)`, [
    t.locationId,
    box,
    `${label} inside`,
  ]);
  await c.query(
    `INSERT INTO public.thing_links (location_id, from_thing_id, to_thing_id, kind)
     VALUES ($1, $2, $3, 'related')`,
    [t.locationId, thing, box],
  );

  // Purchases and meters (task 7): a purchase from the vendor with a line the room thing came
  // from; a meter on the box, with a reading and a replacement event.
  const purchase = newId();
  await c.query(
    `INSERT INTO public.purchases (id, location_id, vendor_id, purchased_on, currency, total)
     VALUES ($1, $2, (SELECT id FROM public.vendors WHERE owner_account_id = $3), '2026-09-01',
             'EGP', 100)`,
    [purchase, t.locationId, t.accountId],
  );
  const line = newId();
  await c.query(
    `INSERT INTO public.purchase_lines (id, location_id, purchase_id, description, unit_price)
     VALUES ($1, $2, $3, 'Gadget', 100)`,
    [line, t.locationId, purchase],
  );
  await c.query('UPDATE public.things SET purchase_line_id = $1 WHERE id = $2', [line, thing]);
  const meter = newId();
  await c.query(
    `INSERT INTO public.meters (id, location_id, thing_id, kind, unit) VALUES ($1, $2, $3, 'hours', 'h')`,
    [meter, t.locationId, box],
  );
  await c.query(
    `INSERT INTO public.meter_readings (location_id, meter_id, value, taken_at)
     VALUES ($1, $2, 12.5, now())`,
    [t.locationId, meter],
  );
  await c.query(
    `INSERT INTO public.meter_events (location_id, meter_id, kind, at, "offset")
     VALUES ($1, $2, 'replaced', now(), 12.5)`,
    [t.locationId, meter],
  );

  // Files, secrets, views and hints (task 8): an uploaded photo with its thumbnail, attached to
  // the room thing; the thing's secret PIN with the location's policy for it; a shared saved
  // view; a hint the user dismissed.
  const file = newId();
  const sha = createHash('sha256').update(`${label}-${file}`).digest('hex');
  await c.query(
    `INSERT INTO public.files (id, location_id, storage_key, sha256, bytes, mime, class,
                               derivative_state, created_by)
     VALUES ($1, $2, $3, $4, 10, 'image/jpeg', 'photo', 'ready', $5)`,
    [file, t.locationId, `f/${t.locationId}/${file}`, sha, t.userId],
  );
  await c.query(
    `INSERT INTO public.file_derivatives (file_id, variant, location_id, storage_key, width,
                                          height, bytes)
     VALUES ($1, 'thumb', $2, $3, 10, 10, 5)`,
    [file, t.locationId, `d/${file}/thumb.jpg`],
  );
  await c.query(
    `INSERT INTO public.attachments (location_id, file_id, thing_id, role, created_by)
     VALUES ($1, $2, $3, 'photo', $4)`,
    [t.locationId, file, thing, t.userId],
  );
  // The same file as the purchase's receipt: what kept.thing_receipt_file() serves (D115, D117).
  await c.query(
    `INSERT INTO public.attachments (location_id, file_id, purchase_id, role, created_by)
     VALUES ($1, $2, $3, 'receipt', $4)`,
    [t.locationId, file, purchase, t.userId],
  );
  await c.query(
    `INSERT INTO public.secret_values (location_id, thing_id, type_field_id, field_key, ciphertext,
                                       key_version, updated_by)
     VALUES ($1, $2, $3, 'gadget_pin', '{"v": 1, "c": "x"}', 1, $4)`,
    [t.locationId, thing, pinField, t.userId],
  );
  await c.query(
    `INSERT INTO public.secret_field_policies (location_id, type_field_id) VALUES ($1, $2)`,
    [t.locationId, pinField],
  );
  const view = newId();
  await c.query(
    `INSERT INTO public.saved_views (id, user_id, location_id, name, shared)
     VALUES ($1, $2, $3, 'Garden tools', true)`,
    [view, t.userId, t.locationId],
  );
  // The filter strip's pins and default (D205): the shared view, on the search list.
  await c.query(
    `INSERT INTO public.saved_view_prefs (user_id, surface, default_view_id, pinned)
     VALUES ($1, 'search', $2, ARRAY[$2::uuid])`,
    [t.userId, view],
  );
  await c.query(
    `INSERT INTO public.user_hints (user_id, hint_key, dismissed) VALUES ($1, 'home.checklist', true)`,
    [t.userId],
  );
  // Generated reports (task 32): one of the location, one of the account.
  await c.query(
    `INSERT INTO public.report_runs (user_id, location_id, location_ids, status)
     VALUES ($1, $2, ARRAY[$2::uuid], 'done')`,
    [t.userId, t.locationId],
  );
  await c.query(
    `INSERT INTO public.report_runs (user_id, owner_account_id, location_ids)
     VALUES ($1, $2, ARRAY[$3::uuid])`,
    [t.userId, t.accountId, t.locationId],
  );
}
