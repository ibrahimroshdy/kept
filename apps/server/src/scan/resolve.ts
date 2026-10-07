import { can, parseScan, type ScanResult } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { legacyCodeOf } from '../imports/csv.js';
import { callerMembership } from '../locations/access.js';

// What a scan means (plan T17; D120, D137, D146, D208; engineering spec §2.4). The web contract is
// apps/web/src/api/capture/types.ts `ScanOutcome`; the phone answers from its snapshot first and
// asks here online (apps/web/src/components/scan/resolve.ts).
//
// `parseScan()` (@kept/shared) classifies the text, then one resolver per kind answers:
// - `kept` (a short ID, any host, D120): a live thing or place the caller sees → `open`; a blank
//   in a location where the caller may use labels → `claim`; else the code as a `kept` legacy
//   code, an imported export's label re-issued here (step-7 plan T14, Q9);
// - `homebox` (`/a/<assetId>`, `/item/<uuid>`, `/location/<uuid>`, D146): the Homebox legacy
//   codes the caller sees: one live target → `open`, several (an asset ID repeats per collection)
//   → `legacy_ambiguous` with the candidates, each with its location (so the phone can queue
//   `mark_seen` for a pick offline);
// - `barcode`: `barcode` with whether lookup is on (the lookup is its own call);
// - `other`: `not_kept` with the text (D137: "Not a Kept label", nothing hidden).
// Before a miss is answered, the text as typed is looked up among every legacy code the caller
// sees (a CSV import's old codes, T18; a Homebox asset ID typed by hand; own codes later, D208 /
// plan T17a, which are `legacy_codes` rows with `source = 'own'` and so resolve here unchanged).
// A short ID always wins over a legacy code of the same text.
//
// A miss is `not_in_your_kept`, identical for a missing, retired or trashed code, another
// household's code or blank, and a blank the caller may only view (D137): every lookup runs as
// the caller under RLS, so another tenant's rows are never read, and each miss path answers the
// same body. Nothing here marks anything seen: the phone calls `POST /things/:id/seen` after
// opening (D40), or queues `mark_seen`.
//
// Every query is an equality on an indexed key (short_ids' primary key, legacy_codes(source,
// code) and its primary key), which PostgreSQL treats as leakproof, so RLS keeps the index
// (§7.2).

export const ResolveScanBody = z.object({
  text: z.string().max(2048),
  format: z.string().max(40).optional(),
});

const Target = z.object({
  kind: z.enum(['thing', 'place']),
  id: z.uuid(),
  locationId: z.uuid(),
});

export const ScanOutcomeSchema = z.union([
  z.object({ outcome: z.literal('open'), target: Target }),
  z.object({ outcome: z.literal('claim'), locationId: z.uuid() }),
  z.object({ outcome: z.literal('not_in_your_kept') }),
  z.object({
    outcome: z.literal('legacy_ambiguous'),
    candidates: z.array(
      z.object({
        locationName: z.string(),
        locationId: z.uuid(),
        name: z.string(),
        kind: z.enum(['thing', 'place']),
        id: z.uuid(),
      }),
    ),
  }),
  z.object({
    outcome: z.literal('barcode'),
    barcode: z.object({ code: z.string(), lookupEnabled: z.boolean() }),
  }),
  z.object({ outcome: z.literal('not_kept'), text: z.string() }),
]);
export type ScanOutcome = z.infer<typeof ScanOutcomeSchema>;

const MISS: ScanOutcome = Object.freeze({ outcome: 'not_in_your_kept' });

export type ResolveDeps = {
  /** Whether barcode lookup is on (barcode.ts readBarcodeSettings). */
  lookupEnabled: () => Promise<boolean>;
};

/** A short ID: a live thing or place, or a blank the caller may claim. Null when it's none. */
async function byShortCode(client: pg.ClientBase, code: string): Promise<ScanOutcome | null> {
  const { rows } = await client.query<{
    state: string;
    location_id: string;
    thing_id: string | null;
    place_id: string | null;
  }>(
    `SELECT s.state, s.location_id,
            (SELECT t.id FROM public.things t
              WHERE t.id = s.thing_id AND t.deleted_at IS NULL) AS thing_id,
            (SELECT p.id FROM public.places p
              WHERE p.id = s.place_id AND p.deleted_at IS NULL) AS place_id
       FROM public.short_ids s WHERE s.code = $1`,
    [code],
  );
  const s = rows[0];
  if (!s) return null;
  if (s.state === 'assigned' && (s.thing_id || s.place_id)) {
    return {
      outcome: 'open',
      target: s.thing_id
        ? { kind: 'thing', id: s.thing_id, locationId: s.location_id }
        : { kind: 'place', id: s.place_id as string, locationId: s.location_id },
    };
  }
  if (s.state === 'blank') {
    const member = await callerMembership(client, s.location_id);
    if (member && can(member.role, 'labels.use')) {
      return { outcome: 'claim', locationId: s.location_id };
    }
  }
  return null;
}

type LegacyHit = {
  location_id: string;
  location_name: string | null;
  thing_id: string | null;
  place_id: string | null;
  name: string | null;
};

/** Legacy codes equal to `code` (as stored: legacyCodeOf) of `sources` (every source when null)
 * with a live target; one target once, whatever codes point at it. */
async function byLegacy(
  client: pg.ClientBase,
  code: string,
  sources: readonly string[] | null,
): Promise<ScanOutcome | null> {
  if (!code || code.length > 100) return null;
  const { rows } = await client.query<LegacyHit>(
    `SELECT DISTINCT c.location_id, l.name AS location_name, t.id AS thing_id, p.id AS place_id,
            coalesce(t.name, p.name) AS name
       FROM public.legacy_codes c
       JOIN public.locations l ON l.id = c.location_id
       LEFT JOIN public.things t ON t.id = c.thing_id AND t.deleted_at IS NULL
       LEFT JOIN public.places p ON p.id = c.place_id AND p.deleted_at IS NULL
      WHERE c.code = $1 AND ($2::text[] IS NULL OR c.source = ANY ($2::text[]))
        AND (t.id IS NOT NULL OR p.id IS NOT NULL)
      ORDER BY l.name, name`,
    [code, sources ? [...sources] : null],
  );
  const hits = rows.map((r) => ({
    kind: r.thing_id ? ('thing' as const) : ('place' as const),
    id: (r.thing_id ?? r.place_id) as string,
    locationId: r.location_id,
    locationName: r.location_name ?? '',
    name: r.name ?? '',
  }));
  const [only] = hits;
  if (!only) return null;
  if (hits.length === 1) {
    return {
      outcome: 'open',
      target: { kind: only.kind, id: only.id, locationId: only.locationId },
    };
  }
  return {
    outcome: 'legacy_ambiguous',
    candidates: hits.map((h) => ({
      locationName: h.locationName,
      locationId: h.locationId,
      name: h.name,
      kind: h.kind,
      id: h.id,
    })),
  };
}

/** The legacy codes a scan's text may be, as typed (every source). */
const anyLegacy = (client: pg.ClientBase, text: string) =>
  byLegacy(client, legacyCodeOf(text), null);

/**
 * One resolver per scan kind; each answers or misses. T17a's own codes need no entry of their
 * own: they are legacy codes, found by `anyLegacy` for every kind.
 */
const RESOLVERS: {
  [K in ScanResult['kind']]: (
    client: pg.ClientBase,
    scan: Extract<ScanResult, { kind: K }>,
    text: string,
    deps: ResolveDeps,
  ) => Promise<ScanOutcome>;
} = {
  // A Kept label whose code was taken on this server when its export was imported here: the old
  // code is a `kept` legacy code on the thing it was moved to (step-7 plan T14, Q9).
  kept: async (client, scan, text) =>
    (await byShortCode(client, scan.code)) ??
    (await byLegacy(client, scan.code, ['kept'])) ??
    (await anyLegacy(client, text)) ??
    MISS,
  homebox: async (client, scan) =>
    (await byLegacy(client, legacyCodeOf(scan.assetId ?? scan.uuid ?? ''), ['homebox'])) ?? MISS,
  barcode: async (client, scan, text, deps) =>
    (await anyLegacy(client, text)) ?? {
      outcome: 'barcode',
      barcode: { code: scan.code, lookupEnabled: await deps.lookupEnabled() },
    },
  other: async (client, scan, text) =>
    (await anyLegacy(client, text)) ?? { outcome: 'not_kept', text: scan.text },
};

/** POST /api/v1/scan/resolve, as the caller. */
export async function resolveScan(
  client: pg.ClientBase,
  body: z.infer<typeof ResolveScanBody>,
  deps: ResolveDeps,
): Promise<ScanOutcome> {
  const scan = parseScan(body.text, body.format);
  const text = body.text.trim();
  const resolve = RESOLVERS[scan.kind] as (
    c: pg.ClientBase,
    s: ScanResult,
    t: string,
    d: ResolveDeps,
  ) => Promise<ScanOutcome>;
  return resolve(client, scan, text, deps);
}
