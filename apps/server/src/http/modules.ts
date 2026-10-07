import {
  effectiveModules,
  isModuleId,
  type ModuleId,
  type Preset,
  presetModules,
} from '@kept/shared';
import { eq, sql } from 'drizzle-orm';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { Pools } from '../db/pools.js';
import { locationModules, locations } from '../db/schema/index.js';
import { type Scope, type Tx, withScope } from '../db/scope.js';
import { AppError, notFound, unauthenticated } from './errors.js';

// Module gating (engineering spec §7.6). A route declares `config: { module: 'vehicles' }`; this
// preHandler resolves the target location and refuses the request when that module is off
// there: 404 `module_off` for a read, 409 `module_off` for a write. A location the user can't
// see is a plain 404 `not_found`, so gating never tells an outsider which modules a location has.

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The module this route belongs to; absent for core routes. */
    module?: ModuleId;
    /** For routes whose location isn't in `params.locationId`, the body's `location_id` /
     * `locationId` or `query.locationId` (direct access such as `/api/v1/things/{id}`): resolve
     * it, or return null when there is none the user can see. See locationOfThing() and co. */
    moduleLocation?: (req: FastifyRequest) => string | null | Promise<string | null>;
  }
  interface FastifyRequest {
    /** The signed-in user's scope, set by the session preHandler (task 17); null when none. */
    scope: Scope | null;
  }
}

/** The location's effective modules, or null when the user can't see the location. */
export type ModuleLoader = (
  req: FastifyRequest,
  locationId: string,
) => Promise<ReadonlySet<ModuleId> | null>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The location a gated request is about: the route's own resolver, else `params.locationId`,
 * then the body's `location_id` or `locationId` (step 2's JSON is camelCase), then
 * `query.locationId` (a list filtered to one location). */
async function targetLocation(req: FastifyRequest): Promise<string | null> {
  const custom = req.routeOptions.config.moduleLocation;
  if (custom) return custom(req);
  const params = req.params as { locationId?: unknown } | undefined;
  const body = req.body as { location_id?: unknown; locationId?: unknown } | undefined;
  const query = req.query as { locationId?: unknown } | undefined;
  const found = params?.locationId ?? body?.location_id ?? body?.locationId ?? query?.locationId;
  return typeof found === 'string' ? found : null;
}

/** Tables whose rows name their location, for the moduleLocation resolvers below. */
const LOCATED = {
  things: sql`public.things`,
  places: sql`public.places`,
  meters: sql`public.meters`,
} as const;

/**
 * A `moduleLocation` resolver for routes addressed by a row id (`/api/v1/things/:id`): reads the
 * row's location as the request's user, in its own short scoped transaction, so a row the user
 * can't see resolves to null (a plain 404, never `module_off`). `param` names the route param
 * holding the id.
 */
export function locationOf(
  pools: Pick<Pools, 'app'>,
  table: keyof typeof LOCATED,
  param = 'id',
): (req: FastifyRequest) => Promise<string | null> {
  return async (req) => {
    const id = (req.params as Record<string, unknown> | undefined)?.[param];
    if (!req.scope || typeof id !== 'string' || !UUID.test(id)) return null;
    return withScope(pools.app, req.scope, async (tx) => {
      const { rows } = await tx.execute<{ location_id: string }>(
        sql`SELECT location_id FROM ${LOCATED[table]} WHERE id = ${id.toLowerCase()}`,
      );
      return rows[0]?.location_id ?? null;
    });
  };
}

export const locationOfThing = (pools: Pick<Pools, 'app'>, param = 'id') =>
  locationOf(pools, 'things', param);
export const locationOfPlace = (pools: Pick<Pools, 'app'>, param = 'id') =>
  locationOf(pools, 'places', param);
export const locationOfMeter = (pools: Pick<Pools, 'app'>, param = 'id') =>
  locationOf(pools, 'meters', param);

export function modulePreHandler(load: ModuleLoader): preHandlerAsyncHookHandler {
  return async function moduleGate(req) {
    const module = req.routeOptions.config.module;
    if (!module) return;
    if (!isModuleId(module)) {
      throw new Error(`route ${req.routeOptions.url} declares unknown module ${module}`);
    }
    const locationId = await targetLocation(req);
    if (!locationId || !UUID.test(locationId)) throw notFound();
    const on = await load(req, locationId.toLowerCase());
    if (!on) throw notFound();
    if (!on.has(module)) {
      throw READS.has(req.method)
        ? new AppError('module_off', 404)
        : new AppError('module_off', 409);
    }
  };
}

/** Whether an AI provider is resolved for a location. */
export type ProviderResolver = (tx: Tx, locationId: string) => Promise<boolean>;

const noProvider: ProviderResolver = async () => false;

/** Step 3 (T9, D191): a provider resolves for the caller in the location (plan Q5's cascade,
 * `kept.ai_provider_resolved`): AI capture and the assistant follow it in any preset. */
export const dbProviderResolved: ProviderResolver = async (tx, locationId) => {
  const { rows } = await tx.execute<{ ok: boolean }>(
    sql`SELECT kept.ai_provider_resolved(${locationId}) AS ok`,
  );
  return rows[0]?.ok === true;
};

/** The location's enabled set: its preset's modules, then its `location_modules` rows on top. */
export async function locationModuleSet(
  tx: Tx,
  locationId: string,
  providerResolved: ProviderResolver = noProvider,
): Promise<Set<ModuleId> | null> {
  const [loc] = await tx
    .select({ preset: locations.preset })
    .from(locations)
    .where(eq(locations.id, locationId));
  if (!loc) return null;
  const enabled = presetModules(loc.preset as Preset) as Set<string>;
  const rows = await tx
    .select({ module: locationModules.module, enabled: locationModules.enabled })
    .from(locationModules)
    .where(eq(locationModules.locationId, locationId));
  for (const row of rows) {
    if (row.enabled) enabled.add(row.module);
    else enabled.delete(row.module);
  }
  return effectiveModules(enabled, { providerResolved: await providerResolved(tx, locationId) });
}

/**
 * The production loader: reads the location as the request's user, in its own short scoped
 * transaction. (Once task 17 gives each request one transaction, this can read in that one.)
 */
export function dbModuleLoader(
  pools: Pick<Pools, 'app'>,
  providerResolved: ProviderResolver = dbProviderResolved,
): ModuleLoader {
  return async (req, locationId) => {
    if (!req.scope) throw unauthenticated();
    return withScope(pools.app, req.scope, (tx) =>
      locationModuleSet(tx, locationId, providerResolved),
    );
  };
}
