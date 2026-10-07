import type { LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { expect } from 'vitest';
import type { TestApp } from './app.js';
import type { TestDb } from './db.js';
import { call, type Person } from './people.js';
import { ownerTx } from './tenancy.js';

// Fixtures for the things route tests (T14): locations made through the front door, rows seeded
// as kept_owner, and small wrappers for the JSON the routes answer.

export type Loc = { id: string; unplacedId: string; accountId: string };

export async function createLocation(
  t: TestApp,
  db: TestDb,
  as: Person,
  preset: 'essentials' | 'household' | 'complete',
  name = 'Home',
): Promise<Loc> {
  const res = await call(t, '/api/v1/locations', {
    as,
    body: { name, kind: 'home', preset, timezone: 'Africa/Cairo', currency: 'EGP', rooms: [] },
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (res.json() as { id: string }).id;
  return ownerTx(db, async (c) => {
    const { rows } = await c.query<{ unplaced: string; account: string }>(
      `SELECT (SELECT p.id FROM public.places p WHERE p.location_id = l.id AND p.is_unplaced)
                AS unplaced, l.owner_account_id AS account
         FROM public.locations l WHERE l.id = $1`,
      [id],
    );
    const row = rows[0] as { unplaced: string; account: string };
    return { id, unplacedId: row.unplaced, accountId: row.account };
  });
}

export const own = <T extends pg.QueryResultRow>(
  db: TestDb,
  text: string,
  values: unknown[] = [],
) => ownerTx(db, async (c) => (await c.query<T>(text, values)).rows);

export async function setDisplayName(db: TestDb, p: Person, name: string): Promise<void> {
  await own(db, 'UPDATE public.user_profiles SET display_name = $2 WHERE user_id = $1', [
    p.userId,
    name,
  ]);
}

export async function builtinType(db: TestDb, key: string): Promise<string> {
  const rows = await own<{ id: string }>(
    db,
    'SELECT id FROM public.types WHERE owner_account_id IS NULL AND builtin_key = $1',
    [key],
  );
  return rows[0]?.id as string;
}

export async function place(db: TestDb, loc: Loc, name: string, parentId: string | null = null) {
  const rows = await own<{ id: string }>(
    db,
    'INSERT INTO public.places (location_id, parent_id, name) VALUES ($1, $2, $3) RETURNING id',
    [loc.id, parentId, name],
  );
  return rows[0]?.id as string;
}

export type Json = Record<string, unknown> & { id: string };

export function ok(res: LightMyRequestResponse, status = 200): Json {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as Json;
}

/** The audit events of a location for one entity, oldest first (as kept_owner). */
export function eventsOf(
  db: TestDb,
  locationId: string,
  entityId: string,
): Promise<
  {
    id: string;
    action: string;
    actor_id: string | null;
    diff: Record<string, Record<string, unknown>>;
    undo_of: string | null;
    undoable_until: Date | null;
    at: Date;
  }[]
> {
  return own(
    db,
    `SELECT id, action, actor_id, diff, undo_of, undoable_until, at FROM public.audit_events
      WHERE location_id = $1 AND entity_id = $2 ORDER BY at, id`,
    [locationId, entityId],
  );
}

/** POST /api/v1/things with sensible defaults (in the location's Unplaced area). */
export async function createThing(
  t: TestApp,
  as: Person,
  loc: Loc,
  body: Record<string, unknown> = {},
): Promise<Json> {
  const res = await call(t, '/api/v1/things', {
    as,
    body: {
      locationId: loc.id,
      ...(body.containerId ? {} : { placeId: loc.unplacedId }),
      name: 'Thing',
      ...body,
    },
  });
  return ok(res, 201);
}
