import { newId, PAYLOAD_VERSION, type QueueItem, type SyncOpResult } from '@kept/shared';
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { TestApp } from './app.js';
import { call } from './people.js';

// Fixtures for the sync ops tests (step-3 T14): queue items as the phone's sync engine sends them
// (apps/web/src/offline/sync-engine.ts toItem: exactly the wire fields), and the ops route.

export const CLIENT_VERSION = '0.3.0';

const DAY_MS = 86_400_000;

/** A UUIDv7 stamped `daysAgo` days before now (negative: ahead). */
export function idDaysAgo(daysAgo: number): string {
  const hex = Math.round(Date.now() - daysAgo * DAY_MS)
    .toString(16)
    .padStart(12, '0');
  const base = newId();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}${base.slice(13)}`;
}

/** One queued op, with a fresh client id and the key the web would give it. */
export function op(
  kind: QueueItem['op'],
  locationId: string,
  payload: unknown,
  over: Partial<QueueItem> = {},
): QueueItem {
  const clientId = over.clientId ?? newId();
  return {
    clientVersion: CLIENT_VERSION,
    payloadVersion: PAYLOAD_VERSION,
    clientId,
    idempotencyKey: `${kind}:${clientId}`,
    op: kind,
    takenAt: new Date().toISOString(),
    locationId,
    payload,
    ...over,
  };
}

/** POST /api/v1/sync/ops with a batch. */
export function syncOps(
  t: TestApp,
  as: { cookie: string },
  ops: QueueItem[],
): Promise<LightMyRequestResponse> {
  return call(t, '/api/v1/sync/ops', { as, body: { clientVersion: CLIENT_VERSION, ops } });
}

/** POST /api/v1/sync/ops, expecting 200: the results, in order. */
export async function sent(
  t: TestApp,
  as: { cookie: string },
  ops: QueueItem[],
): Promise<SyncOpResult[]> {
  const res = await syncOps(t, as, ops);
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { results: SyncOpResult[] }).results;
}

/** A capture op: a named thing (unless `payload` says otherwise) in `target`. */
export function captureOp(
  locationId: string,
  target: Record<string, unknown>,
  payload: Record<string, unknown> = {},
  over: Partial<QueueItem> = {},
): QueueItem & { payload: { id: string } } {
  const id = over.clientId ?? newId();
  return op(
    'create_thing',
    locationId,
    { id, target, mode: 'thing', batchId: newId(), files: [], name: 'Thing', ...payload },
    { clientId: id, idempotencyKey: `cap:${id}`, ...over },
  ) as QueueItem & { payload: { id: string } };
}
