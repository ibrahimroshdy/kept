import type pg from 'pg';
import { z } from 'zod';
import { withSystem } from '../db/scope.js';
import { defineJob, type JobDefinition } from '../jobs/boss.js';
import { JOB_POLICIES } from '../jobs/policies.js';
import type { JobQueue } from '../jobs/queue.js';
import type { SystemJobDeps } from '../jobs/system.js';

// The `reindex` job (T20; engineering spec §7.9): renaming or re-parenting a place, a container
// or a registry entry leaves the search documents and breadcrumbs of the things under it stale;
// the route that did it enqueues this job for the location, in its own transaction
// (enqueueReindex), and the worker rebuilds them through kept.reindex_location() on kept_system.
// `data` names only the location; the definer rebuilds that location's own rows and nothing
// else, so a forged location id costs a reindex and reveals nothing. Rebuilding is idempotent,
// so a burst of renames that sends several jobs is harmless.

const Data = z.object({ locationId: z.uuid() });

/** Rebuilds a location's search and path caches; returns the things rebuilt. */
export async function reindexLocation(
  pools: Pick<SystemJobDeps['pools'], 'system'>,
  locationId: string,
): Promise<number> {
  return withSystem(pools.system, async (_tx, client) => {
    const { rows } = await client.query<{ n: number }>('SELECT kept.reindex_location($1) AS n', [
      locationId,
    ]);
    return rows[0]?.n ?? 0;
  });
}

/** Seconds per reindex debounce slot (security review #33). */
export const REINDEX_DEBOUNCE_SECONDS = 10;

/** Enqueues a reindex of `locationId` on the request's transaction (`client`), debounced per
 * location (security review #33): a burst of renames queues one job, plus one trailing job
 * after the last, never one per request (singletonKey `reindex:<locationId>`; the queue keeps
 * its standard policy and JOB_POLICIES.reindex). */
export async function enqueueReindex(
  jobs: JobQueue | null,
  client: pg.ClientBase,
  locationId: string,
): Promise<void> {
  await jobs?.send(
    client,
    'reindex',
    { locationId },
    { singletonKey: `reindex:${locationId}`, singletonSeconds: REINDEX_DEBOUNCE_SECONDS },
  );
}

/** This area's jobs, aggregated by jobs/inventory.ts. */
export function searchJobs(deps: SystemJobDeps): JobDefinition[] {
  return [
    defineJob({
      name: 'reindex',
      kind: 'system',
      policy: JOB_POLICIES.reindex,
      handler: async (data) => {
        const parsed = Data.safeParse(data);
        if (!parsed.success) throw new Error('reindex: data.locationId must be a uuid');
        const n = await reindexLocation(deps.pools, parsed.data.locationId.toLowerCase());
        deps.log.info({ locationId: parsed.data.locationId, things: n }, 'location reindexed');
      },
    }),
  ];
}
