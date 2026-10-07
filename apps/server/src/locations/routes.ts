import { MODULE_IDS, PRESETS, type Preset } from '@kept/shared';
import { z } from 'zod';
import { validTimeZone } from '../accounts/ensure-account.js';
import { audited } from '../audit/audited.js';
import type { Pools } from '../db/pools.js';
import { LOCATION_KINDS } from '../db/schema/index.js';
import type { KeptApp } from '../http/app.js';
import { checkVersion, paginationQuery, requireIfMatch } from '../http/conventions.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { requireCan, requireMembership } from './access.js';
import { createLocation } from './create.js';
import {
  Iso,
  type KeysetPage,
  keysetPage,
  LocationKeySchema,
  LocationKind,
  LocationView,
  locationPage,
  locationViews,
  ModuleIdSchema,
  nextCursor,
} from './views.js';

// Locations (task 19; D46, D48, D149, D180, D190, D191; engineering spec §7.7). Every route runs
// as the signed-in user in one kept_app transaction: RLS decides what exists for them (a 404
// otherwise), can() what their role may do (a 403), and the write and its audit event commit
// together.
//
// Security review of tasks 19–21: PATCH and the module switches lock the location row before
// comparing If-Match, so of two racing edits one gets 412 (M2); a module switch bumps the
// location's row_version, which is its If-Match (M2); module switches are the owners' and admins'
// in the policies too (0010, I3). The lists are paginated (§7.7, M8): `limit` and `cursor`,
// answering `nextCursor`.

const Name = z.string().trim().min(1).max(100);
const Room = z.string().trim().min(1).max(100);
const Currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/)
  .transform((c) => c.toUpperCase());
const TimeZone = z.string().min(1).max(64);
const Params = z.object({ id: z.uuid() });
const CreatableKind = z.enum(
  LOCATION_KINDS.filter((k) => k !== 'personal') as [string, ...string[]],
);

const CreateBody = z.object({
  /** A client-generated UUIDv7 (§7.7), for offline-first clients; the server makes one if absent. */
  id: z.uuid().optional(),
  name: Name,
  kind: CreatableKind,
  preset: z.enum(PRESETS).default('household'),
  timezone: TimeZone,
  currency: Currency,
  /** Template rooms (D33): top-level places made with the location. */
  rooms: z.array(Room).max(50).default([]),
});

const PatchBody = z
  .object({
    name: Name,
    kind: CreatableKind,
    timezone: TimeZone,
    currency: Currency,
    languages: z.array(z.string().regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/)).max(10),
    moneyVisibleToViewers: z.boolean(),
    longUnseenMonths: z.number().int().min(1).max(120),
    /** Owner only (§7.14). Turning it on needs a second factor in this session. */
    require2fa: z.boolean(),
    /** Owner only (D165): a current member, or null to clear. */
    successorUserId: z.uuid().nullable(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to change.' });

const ModulesBody = z.union([
  z.object({ module: ModuleIdSchema, enabled: z.boolean() }),
  z.object({ preset: z.enum(PRESETS).optional(), modules: z.array(ModuleIdSchema) }),
]);

const DeletedKeySchema = z.tuple([z.string().max(64), z.uuid()]);

const DeletedView = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: LocationKind,
  deletedAt: Iso,
  purgeAfter: Iso,
});

async function requireCurrency(client: import('pg').ClientBase, code: string): Promise<void> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.currencies WHERE code = $1 AND enabled',
    [code],
  );
  if (!rowCount) throw invalid('Check body.currency.');
}

function requireZone(zone: string): string {
  const valid = validTimeZone(zone);
  if (!valid) throw invalid('Check body.timezone.');
  return valid;
}

/** Locks the location's row for this transaction (the caller must pass its UPDATE policy). */
async function lockLocation(client: import('pg').ClientBase, id: string): Promise<void> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.locations WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!rowCount) throw notFound();
}

async function oneLocation(client: import('pg').ClientBase, id: string): Promise<LocationView> {
  const [view] = await locationViews(client, id);
  if (!view) throw notFound();
  return view;
}

export async function locationRoutes(
  app: KeptApp,
  opts: { pools: Pick<Pools, 'app'> },
): Promise<void> {
  const { pools } = opts;

  app.get(
    '/api/v1/locations',
    {
      schema: {
        querystring: paginationQuery,
        response: {
          200: z.object({ locations: z.array(LocationView), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (req) => {
      const page = await scopedRead(pools, req, (_tx, c) =>
        locationPage(c, keysetPage(req.query, LocationKeySchema)),
      );
      return { locations: page.items, nextCursor: nextCursor(page.next) };
    },
  );

  app.post(
    '/api/v1/locations',
    { schema: { body: CreateBody, response: { 201: LocationView } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const body = req.body;
        const id = await createLocation(
          { tx, client, scope, requestId: req.id },
          {
            id: body.id,
            name: body.name,
            kind: body.kind,
            preset: body.preset as Preset,
            timezone: body.timezone,
            currency: body.currency,
            rooms: body.rooms,
          },
        );
        return { status: 201, body: await oneLocation(client, id) };
      }),
  );

  // Before /:id, so the literal path isn't read as an id.
  app.get(
    '/api/v1/locations/deleted',
    {
      schema: {
        querystring: paginationQuery,
        response: {
          200: z.object({ locations: z.array(DeletedView), nextCursor: z.string().nullable() }),
        },
      },
    },
    async (req) => {
      // Newest deletion first; the key is (deleted_at, id), descending.
      const page: KeysetPage<[string, string]> = keysetPage(req.query, DeletedKeySchema);
      const rows = await scopedRead(pools, req, async (_tx, c) => {
        const { rows } = await c.query<{
          id: string;
          name: string;
          kind: z.infer<typeof LocationKind>;
          deleted_at: Date;
          purge_after: Date;
          deleted_at_text: string;
        }>(
          `SELECT d.*, d.deleted_at::text AS deleted_at_text FROM kept.deleted_locations() d
            WHERE ($1::timestamptz IS NULL OR (d.deleted_at, d.id) < ($1::timestamptz, $2::uuid))
            ORDER BY d.deleted_at DESC, d.id DESC
            LIMIT $3`,
          [page.after?.[0] ?? null, page.after?.[1] ?? null, page.limit + 1],
        );
        return rows;
      });
      const items = rows.slice(0, page.limit);
      const last = items.at(-1);
      return {
        locations: items.map((r) => ({
          id: r.id,
          name: r.name,
          kind: r.kind,
          deletedAt: r.deleted_at.toISOString(),
          purgeAfter: r.purge_after.toISOString(),
        })),
        // Postgres's own text for the timestamp: microseconds survive, which a JS Date drops.
        nextCursor:
          rows.length > page.limit && last ? nextCursor([last.deleted_at_text, last.id]) : null,
      };
    },
  );

  app.get(
    '/api/v1/locations/:id',
    { schema: { params: Params, response: { 200: LocationView } } },
    (req) => scopedRead(pools, req, (_tx, c) => oneLocation(c, req.params.id)),
  );

  app.patch(
    '/api/v1/locations/:id',
    { schema: { params: Params, body: PatchBody, response: { 200: LocationView } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const id = req.params.id;
        const expected = requireIfMatch(req);
        const me = await requireMembership(client, id);
        const body = req.body;
        const fields = Object.keys(body);
        const { require2fa, successorUserId, ...settings } = body;

        if (Object.keys(settings).length > 0) requireCan(me.role, 'location.settings');
        if (require2fa !== undefined) requireCan(me.role, 'location.security');
        if (successorUserId !== undefined) requireCan(me.role, 'location.transfer-delete');
        // Every field above needs an owner or admin, whom the UPDATE policy lets lock the row:
        // a concurrent edit waits here, then sees the new row_version and gets 412.
        await lockLocation(client, id);
        const before = await oneLocation(client, id);
        checkVersion(before, expected, fields);

        if (settings.kind !== undefined && before.kind === 'personal') {
          throw conflict("A Personal location's kind can't be changed.");
        }
        if (settings.timezone !== undefined) settings.timezone = requireZone(settings.timezone);
        if (settings.currency !== undefined) await requireCurrency(client, settings.currency);
        if (require2fa === true && !before.require2fa && !scope.mfa) {
          // Otherwise the owner would hide the location from their own session (§7.14).
          throw new AppError('mfa_required', 403, 'Confirm your own second factor first.');
        }

        const columns: Record<string, string> = {
          name: 'name',
          kind: 'kind',
          timezone: 'timezone',
          currency: 'currency',
          languages: 'languages',
          moneyVisibleToViewers: 'money_visible_to_viewers',
          longUnseenMonths: 'long_unseen_months',
        };
        const sets: string[] = [];
        const values: unknown[] = [id];
        for (const [key, value] of Object.entries(settings)) {
          const column = columns[key];
          if (!column || value === undefined) continue;
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
        if (sets.length > 0) {
          await client.query(
            `UPDATE public.locations SET ${sets.join(', ')} WHERE id = $1`,
            values,
          );
        }
        if (require2fa !== undefined && require2fa !== before.require2fa) {
          await client.query('SELECT kept.set_location_require_2fa($1, $2)', [id, require2fa]);
        }
        if (successorUserId !== undefined) {
          await client.query('SELECT kept.set_location_successor($1, $2)', [id, successorUserId]);
        }
        const after = await oneLocation(client, id);
        const pick = (v: LocationView) =>
          Object.fromEntries(fields.map((f) => [f, v[f as keyof LocationView]]));
        await audited(tx, {
          locationId: id,
          actor: { type: 'user', id: scope.userId },
          action: 'location.update',
          entity: { type: 'location', id },
          before: pick(before),
          after: pick(after),
          requestId: req.id,
        });
        return { status: 200, body: after };
      }),
  );

  app.delete(
    '/api/v1/locations/:id',
    {
      schema: {
        params: Params,
        response: { 200: z.object({ id: z.uuid(), purgeAfter: Iso }) },
      },
    },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const id = req.params.id;
        const me = await requireMembership(client, id);
        requireCan(me.role, 'location.transfer-delete');
        const before = await oneLocation(client, id);
        if (before.kind === 'personal') {
          throw conflict("Your Personal location can't be deleted.");
        }
        // Audited first: once deleted, the location is invisible and its event would be refused
        // (0006 §5). The definer checks ownership again and refuses a Personal location.
        await audited(tx, {
          locationId: id,
          actor: { type: 'user', id: scope.userId },
          action: 'location.delete',
          entity: { type: 'location', id },
          before: { name: before.name, kind: before.kind, deleted_at: null },
          requestId: req.id,
        });
        const { rows } = await client.query<{ purge_after: Date }>(
          'SELECT kept.delete_location($1) AS purge_after',
          [id],
        );
        const purgeAfter = rows[0]?.purge_after;
        if (!purgeAfter) throw notFound();
        return { status: 200, body: { id, purgeAfter: purgeAfter.toISOString() } };
      }),
  );

  app.post(
    '/api/v1/locations/:id/restore',
    { schema: { params: Params, response: { 200: LocationView } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const id = req.params.id;
        // Owner only, within the grace period; anything else is the definer's 404 (42501).
        await client.query('SELECT kept.restore_location($1)', [id]);
        // Audited after: only now is the location visible again (0006 §5).
        await audited(tx, {
          locationId: id,
          actor: { type: 'user', id: scope.userId },
          action: 'location.restore',
          entity: { type: 'location', id },
          after: { deleted_at: null },
          requestId: req.id,
        });
        return { status: 200, body: await oneLocation(client, id) };
      }),
  );

  // Module switches (D61, D191): either one module `{module, enabled}`, or the whole desired
  // state `{preset?, modules}` as the "What to track" screen saves it. Turning a module off hides
  // it and never deletes data. If-Match is honoured when sent (the location's row_version).
  app.post(
    '/api/v1/locations/:id/modules',
    { schema: { params: Params, body: ModulesBody, response: { 200: LocationView } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (tx, client, scope) => {
        const id = req.params.id;
        const me = await requireMembership(client, id);
        requireCan(me.role, 'location.settings');
        await lockLocation(client, id);
        const before = await oneLocation(client, id);
        if (req.headers['if-match'] !== undefined) {
          checkVersion(before, requireIfMatch(req), ['modules']);
        }
        const body = req.body;
        let preset = before.preset;
        let wanted: Set<string>;
        if ('module' in body) {
          wanted = new Set(before.modules);
          if (body.enabled) wanted.add(body.module);
          else wanted.delete(body.module);
        } else {
          preset = body.preset ?? before.preset;
          wanted = new Set(body.modules);
        }
        if (preset !== before.preset) {
          await client.query('UPDATE public.locations SET preset = $2 WHERE id = $1', [id, preset]);
        }
        await client.query(
          `INSERT INTO public.location_modules (location_id, module, enabled, enabled_at)
           SELECT $1, m, m = ANY($3::text[]), CASE WHEN m = ANY($3::text[]) THEN now() END
             FROM unnest($2::text[]) AS m
           ON CONFLICT (location_id, module) DO UPDATE
             SET enabled = excluded.enabled,
                 enabled_at = CASE WHEN excluded.enabled AND NOT location_modules.enabled
                                   THEN now()
                                   WHEN excluded.enabled THEN location_modules.enabled_at END
           WHERE location_modules.enabled IS DISTINCT FROM excluded.enabled`,
          [id, [...MODULE_IDS], [...wanted]],
        );
        // The switches are part of the location: its row_version (the If-Match above) moves.
        await client.query('UPDATE public.locations SET updated_at = now() WHERE id = $1', [id]);
        const after = await oneLocation(client, id);
        await audited(tx, {
          locationId: id,
          actor: { type: 'user', id: scope.userId },
          action: 'location.modules',
          entity: { type: 'location', id },
          before: { preset: before.preset, modules: before.modules },
          after: { preset: after.preset, modules: after.modules },
          requestId: req.id,
        });
        return { status: 200, body: after };
      }),
  );
}
