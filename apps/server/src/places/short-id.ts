import { randomShortCode } from '@kept/shared';
import type pg from 'pg';

// Short-ID allocation (D112, D120, D183), shared by places (T13) and things (T15).
//
// A code is 6 Crockford base32 characters, unique across the whole instance and never reissued.
// kept_app can't see other tenants' codes, so a fresh code is tried with INSERT … ON CONFLICT
// (code) DO NOTHING: a collision with a code anywhere (visible or not) inserts nothing and reveals
// nothing, and the next random code is tried. 32^6 ≈ 1.07e9 codes make eight misses in a row a
// sign of something broken, not bad luck: that is a 500.

export const SHORT_ID_TRIES = 8;

export type ShortIdTarget = { thingId: string } | { placeId: string };

/**
 * Allocates a new primary code for a thing or a place in `locationId`, on the request's
 * transaction. The caller checks first that the target has no primary code (a second primary
 * would break short_ids_primary_*_uq, a 409). `generate` is for tests.
 */
export async function allocateShortId(
  client: pg.ClientBase,
  locationId: string,
  target: ShortIdTarget,
  generate: () => string = randomShortCode,
): Promise<string> {
  const thingId = 'thingId' in target ? target.thingId : null;
  const placeId = 'placeId' in target ? target.placeId : null;
  for (let i = 0; i < SHORT_ID_TRIES; i++) {
    const { rows } = await client.query<{ code: string }>(
      `INSERT INTO public.short_ids (code, location_id, thing_id, place_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING
       RETURNING code`,
      [generate(), locationId, thingId, placeId],
    );
    const code = rows[0]?.code;
    if (code) return code;
  }
  throw new Error(`no free short code after ${SHORT_ID_TRIES} tries`);
}
