/**
 * A reading logged on the phone without a connection (plan T19; the step-3 carry-over; D35,
 * D112): one `log_reading` op in the offline queue, with the proof photo as its blob. The sync
 * engine uploads the photo (as `evidence`, offline/queue.ts `fileClassFor`) and sends the op;
 * the server places the reading by when it was taken, and a misfit waits in the Inbox
 * (sync/handlers/log-reading.ts), never silently rejected.
 *
 * - `clientId` is a fresh UUIDv7 and doubles as the reading's id; `idempotencyKey = 'read:' + id`.
 * - Only the photo's original goes: the uploader sends a `display` only for a `create_thing`
 *   file (offline/queue.ts `displayParentOf`), so a reading's would be skipped anyway.
 *
 * `pendingReadings()` reads them back for the meter card ("waiting to sync", Q18).
 */
import { newId, type QueueItem } from '@kept/shared';
import type { LocalBlob, OfflineStore, QueueEntry } from '@/offline/store';

export const readingKey = (id: string) => `read:${id}`;

export type ReadingInput = {
  locationId: string;
  meterId: string;
  /** A canonical decimal (readingValueOf). */
  value: string;
  /** When it was read, ISO. */
  takenAt: string;
  note?: string;
  /** The proof photo's original, its `id` the file id the upload will use. */
  proof?: LocalBlob | null;
};

export async function enqueueReading(
  store: OfflineStore,
  input: ReadingInput,
  { now = () => new Date(), ids = newId }: { now?: () => Date; ids?: () => string } = {},
): Promise<{ id: string; idempotencyKey: string }> {
  const id = ids();
  const note = input.note?.trim();
  const item: Omit<QueueItem, 'clientVersion' | 'payloadVersion'> = {
    clientId: id,
    idempotencyKey: readingKey(id),
    op: 'log_reading',
    takenAt: now().toISOString(),
    locationId: input.locationId,
    payload: {
      id,
      meterId: input.meterId,
      value: input.value,
      takenAt: input.takenAt,
      ...(note ? { note: note.slice(0, 500) } : {}),
      ...(input.proof ? { proofFileId: input.proof.id, proofSha256: input.proof.sha256 } : {}),
    },
  };
  await store.enqueue(item, input.proof ? [{ ...input.proof, kind: 'original' }] : []);
  return { id, idempotencyKey: item.idempotencyKey };
}

/** A reading still on the phone (Q18): shown on its meter as "waiting to sync". */
export type PendingReading = { id: string; value: string; takenAt: string };

/** The meter's queued readings the server hasn't answered yet, newest taken first. */
export async function pendingReadings(
  store: Pick<OfflineStore, 'pending'>,
  meterId: string,
): Promise<PendingReading[]> {
  const isReading = (e: QueueEntry) => e.op === 'log_reading';
  return (await store.pending())
    .filter(isReading)
    .map((e) => e.payload as { id: string; meterId: string; value: string; takenAt: string })
    .filter((p) => p.meterId === meterId)
    .map((p) => ({ id: p.id, value: p.value, takenAt: p.takenAt }))
    .sort((a, b) => b.takenAt.localeCompare(a.takenAt));
}
