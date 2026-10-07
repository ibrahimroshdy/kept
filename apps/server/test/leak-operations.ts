import type pg from 'pg';
import type { Tenant } from './tenancy.js';

// Step 8's fixture rows for the leak test (test/leak.test.ts, fillTenant()): instance-scope
// operations rows, one set per tenant filled. Written as kept_owner inside fillTenant()'s
// transaction.

/** Adds a backup run and a release row (a pre-release version per tenant: the key is unique). */
export async function fillOperations(c: pg.ClientBase, _t: Tenant, label: string): Promise<void> {
  await c.query(
    `INSERT INTO public.backup_runs (kind, status, finished_at, storage_mode, target, snapshot_id,
                                     db_bytes, files_total)
     VALUES ('nightly', 'ok', now(), 'local', $1, 'a1b2c3d4e5f6', 1024, 3)`,
    [`/mnt/backups/${label}`],
  );
  await c.query(
    `INSERT INTO public.release_history (version, revision, last_migration)
     VALUES ($1, 'abc1234', '0091_operations_rls')`,
    [`0.9.0-${label}`],
  );
}
