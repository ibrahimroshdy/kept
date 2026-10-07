import { parseRef } from '@kept/mcp';
import { BUILTIN_TYPES, normalize } from '@kept/shared';
import type pg from 'pg';
import { notFound } from '../http/errors.js';

// References a model or an MCP client typed (a UUID or a short ID in any spelling, D137, D208),
// resolved as the caller: a row they can't see, one in the trash, and one in another location
// than the call's are all the same 404, as the routes answer them.

export type Resolved = { kind: 'thing' | 'place'; id: string; locationId: string };

/** A live thing or place `raw` names, wherever the caller can see it; null when none. */
export async function findRef(client: pg.ClientBase, raw: string): Promise<Resolved | null> {
  const ref = parseRef(raw);
  if (!ref) return null;
  if (ref.kind === 'id') {
    const { rows } = await client.query<{ kind: 'thing' | 'place'; location_id: string }>(
      `SELECT 'thing' AS kind, location_id FROM public.things WHERE id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT 'place', location_id FROM public.places WHERE id = $1 AND deleted_at IS NULL`,
      [ref.id],
    );
    const r = rows[0];
    return r ? { kind: r.kind, id: ref.id, locationId: r.location_id } : null;
  }
  const { rows } = await client.query<{ kind: 'thing' | 'place'; id: string; location_id: string }>(
    `SELECT CASE WHEN s.thing_id IS NOT NULL THEN 'thing' ELSE 'place' END AS kind,
            coalesce(t.id, p.id) AS id, coalesce(t.location_id, p.location_id) AS location_id
       FROM public.short_ids s
       LEFT JOIN public.things t ON t.id = s.thing_id AND t.deleted_at IS NULL
       LEFT JOIN public.places p ON p.id = s.place_id AND p.deleted_at IS NULL
      WHERE s.code = $1 AND s.state = 'assigned' AND coalesce(t.id, p.id) IS NOT NULL`,
    [ref.code],
  );
  const r = rows[0];
  return r ? { kind: r.kind, id: r.id, locationId: r.location_id } : null;
}

/** The location of the row `raw` names, for a handler's `subjectLocation`. */
export async function locationOfRef(
  client: pg.ClientBase,
  raw: string | undefined,
): Promise<string | null> {
  if (!raw) return null;
  return (await findRef(client, raw))?.locationId ?? null;
}

/** A live thing in `locationId`: its id, else 404. */
export async function thingIn(client: pg.ClientBase, locationId: string, raw: string) {
  const found = await findRef(client, raw);
  if (found?.kind !== 'thing' || found.locationId !== locationId) throw notFound();
  return found.id;
}

/** A live place in `locationId`: its id, else 404. */
export async function placeIn(client: pg.ClientBase, locationId: string, raw: string) {
  const found = await findRef(client, raw);
  if (found?.kind !== 'place' || found.locationId !== locationId) throw notFound();
  return found.id;
}

/** A place or a container (a thing) in `locationId`, as the operations' MoveTarget. */
export async function targetIn(
  client: pg.ClientBase,
  locationId: string,
  raw: string,
): Promise<{ placeId: string } | { containerId: string }> {
  const found = await findRef(client, raw);
  if (!found || found.locationId !== locationId) throw notFound();
  return found.kind === 'place' ? { placeId: found.id } : { containerId: found.id };
}

/**
 * The type a person named ("Drill"): a built-in by its English or Arabic name (D154), else one
 * of the location's account's own types by name, compared after kept.normalize()'s twin. Null
 * when none matches; the caller says so rather than guessing (add_thing's `not_set`).
 */
export async function typeNamed(
  client: pg.ClientBase,
  locationId: string,
  name: string,
): Promise<string | null> {
  const wanted = normalize(name);
  const builtin = BUILTIN_TYPES.find(
    (t) =>
      !t.isFieldGroup && (normalize(t.names.en) === wanted || normalize(t.names.ar) === wanted),
  );
  if (builtin) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM public.types
        WHERE builtin_key = $1 AND owner_account_id IS NULL AND archived_at IS NULL`,
      [builtin.key],
    );
    if (rows[0]) return rows[0].id;
  }
  const { rows } = await client.query<{ id: string }>(
    `SELECT ty.id FROM public.types ty
       JOIN public.locations l ON l.owner_account_id = ty.owner_account_id
      WHERE l.id = $1 AND ty.archived_at IS NULL AND NOT ty.is_field_group
        AND kept.normalize(ty.name) = kept.normalize($2)
      ORDER BY ty.id LIMIT 1`,
    [locationId, name],
  );
  return rows[0]?.id ?? null;
}

/** The brand of the location's account with that name (unique after normalising), or null. */
export async function brandNamed(
  client: pg.ClientBase,
  locationId: string,
  name: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT b.id FROM public.brands b
       JOIN public.locations l ON l.owner_account_id = b.owner_account_id
      WHERE l.id = $1 AND kept.normalize(b.name) = kept.normalize($2)
      LIMIT 1`,
    [locationId, name],
  );
  return rows[0]?.id ?? null;
}
