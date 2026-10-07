import type pg from 'pg';

// One advisory lock per blob storage key, for as long as the transaction lasts (security review
// #16, #18). A blob can exist with no row naming it for a moment: an upload stores its blobs
// before the transaction that inserts the rows (so a slow store holds no row locks), and a copy
// made by a cross-account move names its source's blobs (D161). Whoever deletes a blob because
// no row names it (deleteUnreferencedBlobs) checks and deletes under these locks, and whoever is
// about to name a blob takes them before checking that it is still there. Keys are locked in
// sorted order, so two holders of overlapping sets can't deadlock.

/** Takes the transaction-scoped locks of `keys` (a no-op for none). */
export async function lockBlobKeys(client: pg.ClientBase, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtext('kept.blobs'), hashtext(k))
       FROM (SELECT DISTINCT unnest($1::text[]) AS k) s ORDER BY k`,
    [[...keys]],
  );
}
