import type pg from 'pg';
import { allocateShortId } from '../../places/short-id.js';

// Printed labels on a Kept import (D45, D120; step-7 plan T14, Q9). Labels are permanent, and a
// short ID is unique on the whole instance:
// - each exported code is adopted through kept.adopt_short_code() (0083) where it is free on this
//   server: moving to a new server keeps every label as it was;
// - where it is taken (the export came back to the server it left, or a one-in-a-billion clash),
//   the thing or place gets a new primary code (when the taken one was its primary), and the old
//   code is kept as a `kept` legacy code, which the scanner and the phone resolve (scan/resolve.ts),
//   so the old label still opens it here;
// - a taken blank or retired code is dropped and counted (a retired label opened nothing there).
// The door says only whether a code was free, never where it is used (accepted, Q9).
//
// The dry run asks the same question without writing: codesFree() tries the codes as retired
// rows of the target location inside a savepoint it rolls back. That is the side channel the door
// already has (`ON CONFLICT (code)` sees every row, whatever RLS shows), and no more.

export type CodeState = 'assigned' | 'blank' | 'retired';

/** One exported code, its ids already this server's. */
export type ImportedCode = {
  code: string;
  state: CodeState;
  thingId: string | null;
  placeId: string | null;
  isPrimary: boolean;
  printedAt: string | null;
};

export type CodeOutcome = 'adopted' | 'reissued' | 'kept_legacy' | 'dropped';

const CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

async function hasPrimary(
  client: pg.ClientBase,
  target: { thingId: string } | { placeId: string },
): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM public.short_ids
      WHERE ${'thingId' in target ? 'thing_id' : 'place_id'} = $1
        AND state = 'assigned' AND is_primary`,
    ['thingId' in target ? target.thingId : target.placeId],
  );
  return (rowCount ?? 0) > 0;
}

async function keepAsLegacy(
  client: pg.ClientBase,
  locationId: string,
  code: string,
  target: { thingId: string | null; placeId: string | null },
): Promise<void> {
  await client.query(
    `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id,
                                      place_id)
     VALUES ($1, 'kept', '', $2, $3, $4)
     ON CONFLICT ON CONSTRAINT legacy_codes_pk DO NOTHING`,
    [locationId, code, target.thingId, target.placeId],
  );
}

/**
 * Adopts one exported code for run `runId` (running, the caller's), or re-issues its target's
 * label. `retired` keeps at most one target, `assigned` exactly one (the door checks).
 */
export async function adoptCode(
  client: pg.ClientBase,
  runId: string,
  locationId: string,
  c: ImportedCode,
): Promise<CodeOutcome> {
  if (!CODE.test(c.code)) return 'dropped';
  const target =
    c.state === 'blank'
      ? { thingId: null, placeId: null }
      : { thingId: c.thingId, placeId: c.thingId ? null : c.placeId };
  const { rows } = await client.query<{ ok: boolean }>(
    'SELECT kept.adopt_short_code($1, $2, $3, $4, $5) AS ok',
    [runId, c.code, c.state, target.thingId, target.placeId],
  );
  if (rows[0]?.ok) {
    if (c.printedAt) {
      await client.query(
        'UPDATE public.short_ids SET printed_at = $2 WHERE code = $1 AND printed_at IS NULL',
        [c.code, c.printedAt],
      );
    }
    return 'adopted';
  }
  // A retired label opened nothing there, so it opens nothing here either.
  const on = target.thingId
    ? { thingId: target.thingId }
    : target.placeId
      ? { placeId: target.placeId }
      : null;
  if (!on || c.state !== 'assigned') return 'dropped';
  let reissued = false;
  if (!(await hasPrimary(client, on))) {
    await allocateShortId(client, locationId, on);
    reissued = true;
  }
  await keepAsLegacy(client, locationId, c.code, target);
  return reissued ? 'reissued' : 'kept_legacy';
}

/**
 * Gives a primary code to every live thing of the location that has none (an export that held no
 * code for it, or one whose code was dropped). Returns how many were given.
 */
export async function ensurePrimaryCodes(
  client: pg.ClientBase,
  locationId: string,
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT t.id FROM public.things t
      WHERE t.location_id = $1
        AND NOT EXISTS (SELECT 1 FROM public.short_ids s
                         WHERE s.thing_id = t.id AND s.state = 'assigned' AND s.is_primary)
      ORDER BY t.id`,
    [locationId],
  );
  for (const r of rows) await allocateShortId(client, locationId, { thingId: r.id });
  return rows.length;
}

/**
 * Which of `codes` are free on this server, without writing anything: each is tried as a retired
 * code of `locationId` (a location the caller writes) inside a savepoint that is rolled back.
 */
export async function codesFree(
  client: pg.ClientBase,
  locationId: string,
  codes: readonly string[],
): Promise<Set<string>> {
  const wanted = [...new Set(codes.filter((c) => CODE.test(c)))];
  const free = new Set<string>();
  if (wanted.length === 0) return free;
  await client.query('SAVEPOINT kept_codes_probe');
  try {
    for (let i = 0; i < wanted.length; i += 1000) {
      const { rows } = await client.query<{ code: string }>(
        `INSERT INTO public.short_ids (code, location_id, state, is_primary)
         SELECT c, $1, 'retired', false FROM unnest($2::text[]) c
         ON CONFLICT (code) DO NOTHING
         RETURNING code`,
        [locationId, wanted.slice(i, i + 1000)],
      );
      for (const r of rows) free.add(r.code);
    }
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT kept_codes_probe');
    await client.query('RELEASE SAVEPOINT kept_codes_probe');
  }
  return free;
}
