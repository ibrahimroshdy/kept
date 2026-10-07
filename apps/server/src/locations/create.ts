import { MODULE_IDS, newId, type Preset, presetModules } from '@kept/shared';
import type pg from 'pg';
import { validTimeZone } from '../accounts/ensure-account.js';
import { audited } from '../audit/audited.js';
import type { Scope, Tx } from '../db/scope.js';
import { assertClientId } from '../http/conventions.js';
import { forbidden, invalid, notFound } from '../http/errors.js';

// Creating a location (task 19; D33, D47, D61, D114, D118, D191), shared by POST /api/v1/locations
// and an archive import's new target (step-7 plan T8: "created through the locations service in
// the same transaction"). Runs as the signed-in user, in the caller's transaction.

export type NewLocation = {
  /** A client-generated UUIDv7 (§7.7); checked here. */
  id?: string | undefined;
  name: string;
  kind: string;
  preset: Preset;
  timezone: string;
  /** Upper case, three letters; must be enabled. */
  currency: string;
  /** Template rooms (D33): top-level places made with the location. */
  rooms: readonly string[];
  /** Content languages (an import's choice); none by default. */
  languages?: readonly string[] | undefined;
};

export type CreateCtx = { tx: Tx; client: pg.ClientBase; scope: Scope; requestId: string };

/** 400 unless `code` is an enabled currency. */
export async function requireEnabledCurrency(client: pg.ClientBase, code: string): Promise<void> {
  const { rowCount } = await client.query(
    'SELECT 1 FROM public.currencies WHERE code = $1 AND enabled',
    [code],
  );
  if (!rowCount) throw invalid('Check body.currency.');
}

/** The new location's id. It is the caller's, owned by their account, with its Unplaced area
 * (D118) and every module's switch from the preset. */
export async function createLocation(c: CreateCtx, body: NewLocation): Promise<string> {
  const { client, scope } = c;
  const id = body.id ? assertClientId(body.id) : newId();
  // D47, D114: a managed account never owns a location other than its Personal one.
  const { rows: me } = await client.query<{ managed: boolean }>(
    'SELECT managed FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  if (me[0]?.managed) {
    throw forbidden('A managed account can only use locations it is invited to.');
  }
  const { rows: acct } = await client.query<{ id: string | null }>(
    'SELECT kept.current_owner_account_id() AS id',
  );
  const ownerAccountId = acct[0]?.id;
  if (!ownerAccountId) throw notFound();
  const timezone = validTimeZone(body.timezone);
  if (!timezone) throw invalid('Check body.timezone.');
  await requireEnabledCurrency(client, body.currency);
  const rooms = [...new Set(body.rooms)];
  const languages = [...new Set(body.languages ?? [])];
  const modules = presetModules(body.preset);

  // Order matters under RLS (§7.14): the location, then its owner membership (after which it is
  // visible and writable), then its places and module switches. No RETURNING on the location
  // insert: it isn't visible to its own creator until the membership exists.
  await client.query(
    `INSERT INTO public.locations (id, owner_account_id, kind, name, timezone, currency, preset,
                                   languages)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, ownerAccountId, body.kind, body.name, timezone, body.currency, body.preset, languages],
  );
  await client.query(
    `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [id, scope.userId],
  );
  await client.query(
    `INSERT INTO public.places (location_id, name, is_unplaced) VALUES ($1, 'Unplaced', true)`,
    [id],
  );
  for (const room of rooms) {
    await client.query(
      `INSERT INTO public.places (location_id, name, kind_key) VALUES ($1, $2, 'room')`,
      [id, room],
    );
  }
  // Every module's switch, from the preset (D61, D191): the location keeps what it was created
  // with even if a preset's contents change in a later release.
  await client.query(
    `INSERT INTO public.location_modules (location_id, module, enabled, enabled_at)
     SELECT $1, m, m = ANY($3::text[]), CASE WHEN m = ANY($3::text[]) THEN now() END
       FROM unnest($2::text[]) AS m`,
    [id, [...MODULE_IDS], [...modules]],
  );
  await audited(c.tx, {
    locationId: id,
    actor: { type: 'user', id: scope.userId },
    action: 'location.create',
    entity: { type: 'location', id },
    after: {
      name: body.name,
      kind: body.kind,
      preset: body.preset,
      timezone,
      currency: body.currency,
      rooms,
      ...(languages.length > 0 ? { languages } : {}),
      modules: [...modules],
    },
    requestId: c.requestId,
  });
  return id;
}
