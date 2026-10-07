import { newId } from '@kept/shared';
import type pg from 'pg';
import type { Tenant } from './tenancy.js';

// Step 7's fixture rows for the leak test (test/leak.test.ts, fillTenant()), after steps 2–6:
// the portability columns and tables, for each tenant. Written as kept_owner inside
// fillTenant()'s transaction.

/** A sealed value's shape (crypto/envelope.ts); the leak test never opens it. */
const SEALED = { v: 1, kv: 1, dek: 'ZGVr', iv: 'aXY=', ct: 'Y3Q=', tag: 'dGFn' };

/** Fills `t`'s location. The rows of steps 2–6 are already there. */
export async function fillPortability(c: pg.ClientBase, t: Tenant, label: string): Promise<void> {
  // An owner's export of the location with "Include secrets": its passphrase key sealed (T4).
  await c.query(
    `INSERT INTO public.export_runs (location_id, kind, include_secrets, options, status,
                                     created_by, started_at, secrets_key_ciphertext, key_version)
     VALUES ($1, 'location', true, '{"history": true}', 'running', $2, now(), $3, 1)`,
    [t.locationId, t.userId, JSON.stringify(SEALED)],
  );
  // A Homebox archive uploaded but not yet given a target: its creator's alone (T4).
  const draft = newId();
  await c.query(
    `INSERT INTO public.import_runs (id, location_id, source, created_by, archive_bytes,
                                     archive_sha256, archive_ready_at, inspect)
     VALUES ($1, NULL, 'homebox_zip', $2, 4096, $3, now(), '{"collections": []}')`,
    [draft, t.userId, 'a'.repeat(64)],
  );
  // A Homebox run into the location, with a source id both Homebox paths share (Q2).
  const run = newId();
  await c.query(
    `INSERT INTO public.import_runs (id, location_id, source, status, created_by)
     VALUES ($1, $2, 'homebox_zip', 'done', $3)`,
    [run, t.locationId, t.userId],
  );
  await c.query(
    `INSERT INTO public.import_source_ids (location_id, source, source_id, entity_type, entity_id,
                                           run_id)
     VALUES ($1, 'homebox', $2, 'place', $3, $4)`,
    [t.locationId, `${label}-hb-location`, newId(), run],
  );

  // A Kept import running into the location (T5): an event it carried over, with the old
  // actor's name, and a label whose code was taken here, kept as a `kept` legacy code.
  const kept = newId();
  await c.query(
    `INSERT INTO public.import_runs (id, location_id, source, status, created_by, started_at)
     VALUES ($1, $2, 'kept_zip', 'running', $3, now())`,
    [kept, t.locationId, t.userId],
  );
  await c.query(
    `INSERT INTO public.audit_events (location_id, owner_account_id, actor_type, actor_id, action,
                                      entity_type, diff)
     VALUES ($1, $2, 'import', $3, 'update', 'place', '{"_importedActor": "Alfred"}')`,
    [t.locationId, t.accountId, kept],
  );
  const thing = (
    await c.query<{ id: string }>(
      'SELECT id FROM public.things WHERE location_id = $1 ORDER BY id LIMIT 1',
      [t.locationId],
    )
  ).rows[0]?.id;
  await c.query(
    `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id)
     VALUES ($1, 'kept', '', $2, $3)`,
    [t.locationId, `${label.toUpperCase()}KEPT1`, thing],
  );

  // "Keep at least 4" on a pack of batteries, a built-in consumable type (T6).
  const batteries = newId();
  await c.query(
    `INSERT INTO public.things (id, location_id, place_id, name, type_id, quantity)
     SELECT $1, $2, p.id, $3, ty.id, 3
       FROM public.places p, public.types ty
      WHERE p.location_id = $2 AND p.is_unplaced AND ty.owner_account_id IS NULL
        AND ty.builtin_key = 'batteries'`,
    [batteries, t.locationId, `${label} batteries`],
  );
  await c.query(
    `INSERT INTO public.stock_rules (thing_id, location_id, min_quantity, created_by)
     VALUES ($1, $2, 4, $3)`,
    [batteries, t.locationId, t.userId],
  );
}
