/**
 * How the DB adapters (db-keys.ts, db-gate.ts, db-pacer.ts, db-prices.ts) reach the `kept.ai_*`
 * doors (step-3 T6, migration 0040): each port method runs one short transaction of its own,
 * never around a model call (D166). A request or a tenant job runs it in the person's scope on
 * kept_app; background work (no person) on kept_system, which may call only the gate and pacer
 * doors.
 */
import type pg from 'pg';
import type { Pools } from '../db/pools.js';
import { type Scope, withScope, withSystem } from '../db/scope.js';
import { FOREVER } from './breaker.js';

/** Runs `fn` in one scoped transaction and commits. */
export type DoorRunner = <T>(fn: (client: pg.PoolClient) => Promise<T>) => Promise<T>;

/** A runner in `scope` on kept_app, or on kept_system when `scope` is null (background). */
export function doorRunner(pools: Pick<Pools, 'app' | 'system'>, scope: Scope | null): DoorRunner {
  return (fn) =>
    scope === null
      ? withSystem(pools.system, (_tx, client) => fn(client))
      : withScope(pools.app, scope, (_tx, client) => fn(client));
}

/** A timestamptz the doors return: node-postgres reads `infinity` as the number Infinity, which
 * the ports spell FOREVER (breaker.ts). */
export function fromDbTime(v: Date | number | null): Date | null {
  if (v === null) return null;
  if (typeof v === 'number') return v > 0 ? FOREVER : new Date(-8.64e15);
  return v;
}

/** A Date for a door: FOREVER as `infinity` (its ISO form is out of Postgres's range). */
export function toDbTime(d: Date | null): string | null {
  if (d === null) return null;
  return d.getTime() >= FOREVER.getTime() ? 'infinity' : d.toISOString();
}
