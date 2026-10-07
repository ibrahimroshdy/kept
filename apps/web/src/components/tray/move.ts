/**
 * Putting down what the tray carries (D175, D45): one move for all of it. Online, `POST
 * /things/move`, whose answer carries one audit event per thing for the Undo toast (D150).
 * Offline, when that call can't reach the server, or while some of the things are captures this
 * phone hasn't synced yet (the server doesn't know them), it is one `move` op in the queue,
 * depending on those captures, shown at once in its new place.
 */

import { isApiError } from '@/api/client';
import { inventoryApi } from '@/api/inventory/queries';
import { queueItem, unsyncedCaptures } from '@/components/scan/resolve';
import type { OfflineStore } from '@/offline/store';

export type Destination = { placeId: string } | { containerId: string };

export type Moved =
  | { via: 'server'; auditEvents: string[] }
  /** The op's idempotency key: its Undo takes it back out of the queue while it is unsent. */
  | { via: 'queue'; key: string };

export async function moveCarried({
  store,
  online,
  thingIds,
  to,
  locationId,
}: {
  store: OfflineStore | null;
  online: boolean;
  thingIds: string[];
  to: Destination;
  /** The destination's location: the queued op's location (inferred for T14's handler). */
  locationId: string;
}): Promise<Moved> {
  const unsynced = await unsyncedCaptures(store, thingIds);
  if (online && unsynced.length === 0) {
    try {
      const { auditEvents } = await inventoryApi.move({ thingIds, to });
      return { via: 'server', auditEvents };
    } catch (e) {
      if (!(isApiError(e) && e.code === 'offline') || !store) throw e;
    }
  }
  if (!store) throw new Error('No offline store to queue the move in.');
  const item = queueItem(
    'move',
    locationId,
    { thingIds, to },
    { dependsOn: unsynced.map((e) => e.idempotencyKey) },
  );
  await store.enqueue(item, []);
  return { via: 'queue', key: item.idempotencyKey };
}
