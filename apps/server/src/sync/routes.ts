import { randomBytes } from 'node:crypto';
import { LIFECYCLES, LOAN_DIRECTIONS, MODULE_IDS, ROLES, SYNC_LIMITS } from '@kept/shared';
import { z } from 'zod';
import type { KeptApp } from '../http/app.js';
import { invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead } from '../http/write.js';
import { FIRST_SYNC, signCursor, verifyCursor } from './cursor.js';
import { syncOpsRoutes } from './ops.js';
import { snapshotPage } from './snapshot.js';

// Sync (plan T12, T14; engineering spec §2.2, §2.3, §7.4). Registered by http/routes.ts; add
// routes here, never there.
//
// GET /api/v1/sync/snapshot?cursor&limit&typesHash → SnapshotPage (packages/shared/src/sync.ts).
// Every member role, viewers included: they browse offline too. Without a cursor it starts a
// full pass; each page's `nextCursor` goes back as `cursor` until a page says `complete`, and the
// last one is kept for the next sync, which then gets only what changed. A cursor that doesn't
// verify (forged, garbled, or signed before KEPT_AUTH_SECRET changed) is a 400 `validation`:
// the phone drops it and its copy, and pulls a full pass again.

const Iso = z.string();
const Uuid = z.uuid();

const SnapshotQuery = z.object({
  cursor: z.string().max(65_536).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(SYNC_LIMITS.snapshotPageMax)
    .default(SYNC_LIMITS.snapshotPageDefault),
  typesHash: z.string().max(64).optional(),
});

const SnapshotResponse = z.object({
  asOf: Iso,
  payloadVersion: z.number().int(),
  minPayloadVersion: z.number().int(),
  locations: z.array(
    z.object({
      id: Uuid,
      name: z.string(),
      kind: z.string(),
      timezone: z.string(),
      languages: z.array(z.string()),
      role: z.enum(ROLES),
      effectiveModules: z.array(z.enum(MODULE_IDS)),
      unplacedPlaceId: z.string(),
      latitude: z.number().optional(),
      longitude: z.number().optional(),
      suggestRadiusM: z.number().int(),
    }),
  ),
  types: z.object({
    hash: z.string(),
    items: z
      .array(
        z.object({
          id: Uuid,
          builtinKey: z.string().nullable(),
          name: z.string(),
          icon: z.string().nullable(),
          isContainer: z.boolean(),
        }),
      )
      .optional(),
  }),
  changes: z.object({
    places: z.array(
      z.object({
        id: Uuid,
        locationId: Uuid,
        parentId: Uuid.nullable(),
        name: z.string(),
        kindKey: z.string(),
        icon: z.string().nullable(),
        isUnplaced: z.boolean(),
        sort: z.number().int(),
        deleted: z.boolean(),
      }),
    ),
    things: z.array(
      z.object({
        id: Uuid,
        locationId: Uuid,
        shortCode: z.string().nullable(),
        name: z.string().nullable(),
        typeId: Uuid.nullable(),
        placeId: Uuid.nullable(),
        containerId: Uuid.nullable(),
        quantity: z.string(),
        aliases: z.record(z.string(), z.array(z.string())),
        lifecycle: z.enum(LIFECYCLES),
        reviewState: z.enum(['draft', 'confirmed']),
        locationUncertain: z.boolean(),
        lastSeenAt: Iso.nullable(),
        coverFileId: Uuid.nullable(),
        isContainer: z.boolean(),
        meters: z
          .array(
            z.object({
              id: Uuid,
              kind: z.string(),
              unit: z.string(),
              label: z.string().nullable(),
              // Step 5 (Q18): the latest accepted reading, offset-corrected. Additive.
              latest: z.object({ value: z.string(), takenAt: Iso }).optional(),
            }),
          )
          // Always sent; optional only as SnapThing is, whose phone-made rows have none.
          .optional(),
        // Step 4 (T10; D119, Q34): lent, borrowed and in repair, and the open loan (a name and a
        // due date only). Absent means none.
        derived: z.array(z.enum(['lent', 'borrowed', 'in_repair'])).optional(),
        loan: z
          .object({
            direction: z.enum(LOAN_DIRECTIONS),
            personName: z.string(),
            dueOn: z.string().nullable(),
          })
          .optional(),
        deleted: z.boolean(),
      }),
    ),
    codes: z.array(
      z.object({
        code: z.string(),
        locationId: Uuid,
        thingId: Uuid.nullable(),
        placeId: Uuid.nullable(),
        state: z.enum(['blank', 'assigned', 'retired']),
        isPrimary: z.boolean(),
      }),
    ),
    legacyCodes: z.array(
      z.object({
        locationId: Uuid,
        source: z.string(),
        sourceCollection: z.string(),
        code: z.string(),
        thingId: Uuid.nullable(),
        placeId: Uuid.nullable(),
      }),
    ),
  }),
  removed: z.array(
    z.object({
      locationId: Uuid,
      entityType: z.enum(['thing', 'place', 'code', 'legacy_code']),
      entityId: z.string(),
    }),
  ),
  revokedLocationIds: z.array(Uuid),
  nextCursor: z.string(),
  complete: z.boolean(),
  truncated: z.boolean().optional(),
});

export async function syncRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;
  // main.ts passes the key derived from KEPT_AUTH_SECRET. An app built without one (tests) signs
  // with a key of its own: its cursors don't outlive it, and a phone holding one pulls afresh.
  const key = deps.syncKey ?? randomBytes(32);

  app.get(
    '/api/v1/sync/snapshot',
    { schema: { querystring: SnapshotQuery, response: { 200: SnapshotResponse } } },
    async (req) => {
      const { cursor, limit, typesHash } = req.query;
      const state = cursor === undefined ? FIRST_SYNC : verifyCursor(key, cursor);
      if (!state) throw invalid('The sync cursor is not valid; sync again from the start.');
      const { page, next } = await scopedRead(pools, req, (_tx, client) =>
        snapshotPage(client, state, { limit, typesHash }),
      );
      return { ...page, nextCursor: signCursor(key, next) };
    },
  );

  // POST /api/v1/sync/ops: the phone's queued changes (T14, ops.ts).
  await syncOpsRoutes(app, deps);
}
