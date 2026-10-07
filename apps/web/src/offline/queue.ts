/**
 * The queue's rules, as pure functions over entries (plan T24; engineering spec §2.3, §7.4; D35,
 * D112, D148). The sync engine asks these what to upload and what to send; the store only keeps
 * the entries.
 *
 * **The state machine of one entry:**
 *
 * ```
 *   pending ──(its blobs start uploading)──▶ uploading ──(all uploaded)──┐
 *      │                                                                 ▼
 *      └──────────────(no blobs)───────────────────────────────────▶ (ready) ──POST──▶ sent
 *   sent ──result──▶ applied | needs_review | dropped      (answered: never sent again)
 *   sent ──no answer (network, 5xx, crash)──▶ sent         (re-sent with the SAME idempotency key)
 *   sent ──answered for others, not for it (T14 stopped at a 500)──▶ pending
 *   any unanswered ──409 client_outdated / server_outdated──▶ blocked (the queue is kept, D148)
 *   blocked ──app start, a new build, or the 30-minute retry──▶ pending
 * ```
 *
 * `pending` and `blocked` mean the server has applied nothing of the op, so it may still be
 * taken back (`unqueue`, "Undo this batch") or have its payload upgraded; `sent` may have been
 * applied, so it only ever goes again, unchanged.
 *
 * **Order.** Ops are sent strictly in queue order (D35: the server applies them in the order it
 * receives them). An entry whose files haven't all uploaded holds back every entry after it, so a
 * move queued after a capture never overtakes it, and `dependsOn` parents always go first.
 */
import {
  type FileClass,
  PAYLOAD_VERSION,
  PayloadVersionError,
  SYNC_LIMITS,
  UPGRADERS,
  type UpgraderTable,
  upgradePayload,
} from '@kept/shared';
import type { QueueEntry, QueueState } from './store';

/** What the engine may send now, and what it must drop without sending. */
export type Batch = {
  /** In queue order, at most `SYNC_LIMITS.opsPerBatch`. */
  send: QueueEntry[];
  /** Entries whose `dependsOn` parent was dropped on this phone (never reached the server). */
  parentDropped: QueueEntry[];
};

/**
 * The next batch: the longest run of unanswered, unblocked entries, in order, whose files are all
 * uploaded. `stateOf` answers for any idempotency key in the local queue (parents included).
 */
export function nextBatch(
  entries: readonly QueueEntry[],
  filesReady: (seq: number) => boolean,
  stateOf: (idempotencyKey: string) => QueueState | undefined,
  max: number = SYNC_LIMITS.opsPerBatch,
): Batch {
  const send: QueueEntry[] = [];
  const parentDropped: QueueEntry[] = [];
  const droppedHere = new Set<string>();
  for (const e of [...entries].sort((a, b) => a.seq - b.seq)) {
    if (e.state === 'blocked') break; // a refused batch holds everything after it (D148)
    if (e.state !== 'pending' && e.state !== 'uploading' && e.state !== 'sent') continue;
    const parents = e.dependsOn ?? [];
    if (parents.some((k) => droppedHere.has(k) || stateOf(k) === 'dropped')) {
      // The server would answer `parent_dropped` only for a parent it saw; this one it never did.
      parentDropped.push(e);
      droppedHere.add(e.idempotencyKey);
      continue;
    }
    if (!filesReady(e.seq)) break;
    send.push(e);
    if (send.length >= max) break;
  }
  return { send, parentDropped };
}

/**
 * The `class` an upload is stored under (engineering spec §1: evidence · photo · document ·
 * video). THING mode's shrunk JPEG is a photo (D34); the evidence modes' untouched originals
 * and a reading's proof are evidence (D117).
 */
export function fileClassFor(entry: Pick<QueueEntry, 'op' | 'payload'>): FileClass {
  const p = (entry.payload ?? {}) as { mode?: unknown };
  if (entry.op === 'create_thing') return p.mode === 'thing' ? 'photo' : 'evidence';
  if (entry.op === 'log_reading') return 'evidence';
  return 'photo';
}

/**
 * For a display blob (`PUT /files/:fileId/display`), the original's file id: the `files[]` line
 * of a `create_thing` whose `displayFileId` is this blob's id. Undefined when nothing names it.
 */
export function displayParentOf(entry: Pick<QueueEntry, 'op' | 'payload'>, blobId: string) {
  if (entry.op !== 'create_thing') return undefined;
  const files = (entry.payload as { files?: { fileId: string; displayFileId?: string }[] }).files;
  return files?.find((f) => f.displayFileId === blobId)?.fileId;
}

/** The outcome of bringing one entry's payload up to this build's version (D148). */
export type Upgrade =
  | { kind: 'current' }
  | { kind: 'upgraded'; payload: unknown; payloadVersion: number }
  /** No upgrader path from its version: it stays as it is, and the server decides. */
  | { kind: 'no_path' };

/**
 * Upgrades a queued payload written by an older build, before it is sent: a phone that was
 * offline across an app update sends current payloads, and so never meets `client_outdated` for
 * a version this build still knows how to upgrade. A payload newer than this build (the app was
 * rolled back) is left for the server.
 */
export function upgradeEntry(
  entry: Pick<QueueEntry, 'op' | 'payload' | 'payloadVersion'>,
  upgraders: UpgraderTable = UPGRADERS,
): Upgrade {
  if (entry.payloadVersion >= PAYLOAD_VERSION) return { kind: 'current' };
  try {
    return {
      kind: 'upgraded',
      payload: upgradePayload(entry.op, entry.payloadVersion, entry.payload, upgraders),
      payloadVersion: PAYLOAD_VERSION,
    };
  } catch (e) {
    if (e instanceof PayloadVersionError) return { kind: 'no_path' };
    throw e;
  }
}
