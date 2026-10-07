/**
 * What the sync engine needs from a store beyond the screens' `OfflineStore` (plan T24). Kept
 * apart from store.ts on purpose: screens never settle ops, mark uploads or prune the queue, so
 * none of this is on the interface they code against, and `MemoryStore` (tests, the demo) doesn't
 * have to implement it. `DexieStore` does.
 */
import type { SyncOpResult } from '@kept/shared';
import type { MetaKey } from './db';
import type { LocalBlob, OfflineStore, QueueEntry, QueueState, SyncNotice } from './store';

/** A queued file, and whether `PUT /files/:id` (or `/display`) has taken it. */
export type StoredBlob = LocalBlob & { uploaded: boolean };

export interface SyncStore extends OfflineStore {
  /** Every entry, answered or not, in queue order. */
  entries(): Promise<QueueEntry[]>;
  blobsOf(seq: number): Promise<StoredBlob[]>;
  /** The queue positions that still have a file to upload. */
  unuploadedSeqs(): Promise<Set<number>>;
  markUploaded(blobId: string): Promise<void>;
  setState(seqs: number[], state: QueueState): Promise<void>;
  /** A payload upgraded to this build's version before sending (D148). */
  setPayload(seq: number, payload: unknown, payloadVersion: number): Promise<void>;
  /**
   * Records the server's answer: the state, the result, the files freed, a notice when the
   * person needs to know (D35), and an allocated short ID for "Print pending labels (N)".
   */
  settle(result: SyncOpResult, state?: QueueState): Promise<void>;
  addNotice(notice: Omit<SyncNotice, 'id' | 'at'>): Promise<void>;
  /** The person saw it: the notice goes, and a dropped or reviewed entry leaves the queue. */
  dismissNotice(id: number): Promise<void>;
  /** A build or server that accepts the queue again: "Update Kept to finish syncing" goes. */
  clearOutdated(): Promise<void>;
  /** Applied entries answered before a complete snapshot pass started are in the snapshot now. */
  pruneApplied(passStartedAt: number): Promise<void>;
  meta(key: MetaKey): Promise<unknown>;
  setMeta(key: MetaKey, value: unknown): Promise<void>;
  /** A 401 (D210): the cache goes, the unanswered queue and its files stay, locked. */
  wipeCache(): Promise<void>;
  /**
   * A cursor the server no longer verifies (a 400: its auth secret changed): the snapshot's
   * copy goes with the cursor (locations, places, things, codes, legacy codes, types,
   * thumbnails), so the full pass that follows starts clean. The queue and its files, the tray
   * and the notices stay.
   */
  resetSnapshot(): Promise<void>;
  /** Frees the thumbnail cache (the first thing to go when the phone is full). */
  freeThumbs(): Promise<void>;
}
