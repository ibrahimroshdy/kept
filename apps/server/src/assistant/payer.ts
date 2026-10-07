import type pg from 'pg';

// Who pays for one model step of a turn (step-6 plan Q3; D121, D167, D206). Resolved per step,
// because a turn's locations are only known as the model calls tools:
// - the locations the turn has touched so far, plus the context's;
// - one location, or several with the same owner account → that location's cascade (its owner's
//   key, then the instance, ai/resolve.ts);
// - several owners, or none (a private thread with no location) → the asker's own cascade (their
//   key, their account's, the instance): `locationId` null.
// Each ledger row then names its payer, so a turn that crosses owners shows where the money went.

/** The location whose cascade pays for the next step, or null for the asker's own. */
export async function payingLocation(
  client: pg.ClientBase,
  touched: readonly string[],
): Promise<string | null> {
  const ids = [...new Set(touched.map((id) => id.toLowerCase()))];
  if (ids.length === 0) return null;
  const { rows } = await client.query<{ id: string; owner_account_id: string }>(
    `SELECT id, owner_account_id FROM public.locations
      WHERE id = ANY ($1::uuid[]) AND deleted_at IS NULL
      ORDER BY id`,
    [ids],
  );
  // A location the person no longer sees can't be paid for by its owner.
  if (rows.length !== ids.length) return null;
  const owners = new Set(rows.map((r) => r.owner_account_id));
  if (owners.size !== 1) return null;
  const first = ids[0] as string;
  return rows.some((r) => r.id === first) ? first : (rows[0]?.id ?? null);
}
