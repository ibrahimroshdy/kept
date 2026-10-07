/**
 * The phone's IndexedDB database (plan T24; engineering spec §2.2; D17, D36, D101, D181), in
 * Dexie. One database per user (`kept-<userId>`), so a second account on the same device can't
 * read the first one's copy; sign-out and any 401 delete it whole (wipe.ts).
 *
 * This module imports Dexie, so only the lazy offline chunk may import it (open.ts): the entry
 * chunk never pays for IndexedDB code (the step-3 bundle budget, plan T23).
 *
 * **Bytes, not Blobs.** Captured files and thumbnails are stored as an `ArrayBuffer` plus their
 * MIME type, and rebuilt into a `Blob` on the way out. Blobs in IndexedDB have a history of
 * WebKit bugs, and an `ArrayBuffer` is what every engine (and fake-indexeddb in the tests)
 * structured-clones the same way. The capture screen already holds the bytes in memory.
 *
 * **Indexes.** A null value isn't indexed by IndexedDB, so `placeId`/`containerId` find only the
 * rows that have one; the store falls back to a scan for the rare "no place at all" query.
 */
import type {
  SnapCode,
  SnapLegacyCode,
  SnapLocation,
  SnapPlace,
  SnapThing,
  SnapType,
} from '@kept/shared';
import Dexie, { type DexieOptions, type Table } from 'dexie';
import type { LockRecord, Sealed } from './lock';
import {
  codesKey,
  type LocalBlob,
  legacyCodesByThing,
  type QueueEntry,
  type SyncNotice,
  termsOf,
} from './store';

/** The schema version. Raise it with a new `this.version(n).stores(…)` block, never edit v1. */
export const DB_VERSION = 4;

/** v1's tables and indexes, unchanged in v2. */
export const V1_STORES = {
  meta: 'key',
  locations: 'id',
  places: 'id, locationId, parentId',
  things: 'id, locationId, placeId, containerId, shortCode, *terms',
  codes: 'code, locationId, thingId, placeId',
  legacyCodes: 'key, locationId, [source+code]',
  types: 'id',
  queue: '++seq, &idempotencyKey, clientId, state',
  blobs: 'id, queueSeq',
  thumbs: 'fileId, lastUsedAt',
  tray: 'thingId, addedAt',
  notices: '++id, idempotencyKey',
  shared: 'id',
};

/** v3: legacy codes indexed by their thing, whose search terms now hold them (D208). */
export const V3_STORES = {
  ...V1_STORES,
  legacyCodes: 'key, locationId, [source+code], thingId',
};

/**
 * v4 (step 8, T23): the app lock and "keep this location available offline" (D159, D181). New
 * tables only; nothing moves.
 * - `lock`: one row, `device`: the PIN-wrapped data key and the passkey (offline/lock.ts).
 * - `extras`: a kept thing's money, sealed under the data key (SyncExtra as JSON).
 * - `extraDocs`: a kept document: its description sealed, and its bytes sealed, or none when it is
 *   over KEEP_OFFLINE.fileBytes ("too large to keep offline"). `bytes` is the stored size, in the
 *   clear, for the device's cap; `run` is the keep run that last wrote it.
 * - `keptOffline`: a kept location's progress and totals (no names, no money).
 */
export const V4_STORES = {
  ...V3_STORES,
  lock: 'key',
  extras: 'thingId, locationId',
  extraDocs: 'attachmentId, locationId, thingId',
  keptOffline: 'locationId',
};

/** The keep-offline tables: a 401, ten wrong PINs and a location's toggle going off empty them. */
export const EXTRAS_TABLES = ['extras', 'extraDocs', 'keptOffline'] as const;

/**
 * The snapshot's copy: what a refused cursor (DexieStore.resetSnapshot) and the v2 upgrade
 * empty, and the meta `applySnapshot` writes from a page, which goes with it.
 */
export const SNAPSHOT_TABLES = [
  'locations',
  'places',
  'things',
  'codes',
  'legacyCodes',
  'types',
  'thumbs',
] as const;
export const SNAPSHOT_META_KEYS: readonly MetaKey[] = [
  'cursor',
  'asOf',
  'typesHash',
  'truncated',
  'serverPayloadWindow',
];

/** Keys of the `meta` table. */
export type MetaKey =
  /** The snapshot cursor to send next (opaque, signed by the server). */
  | 'cursor'
  /** The snapshot page's `asOf`: "as of last sync, 14:02" (D188). */
  | 'asOf'
  /** The types hash last received, sent back as `typesHash`. */
  | 'typesHash'
  /** The server said only part of the Kept fits on this phone (Q30). */
  | 'truncated'
  /** The payload window the server reported on its last snapshot page (D148). */
  | 'serverPayloadWindow'
  /** `navigator.storage.persist()`'s answer, once asked (V11): true, false, or absent. */
  | 'persisted'
  /** Things whose short ID was allocated at sync and not yet printed: "Print pending labels (N)". */
  | 'printPending'
  /** When a sync run last finished without error (ms since the epoch). */
  | 'lastSyncAt'
  /** A 401 cleared the cache and locked the queue until someone signs in (D210). */
  | 'lockedAt'
  /**
   * The signed-in frame's last-known `/me` and locations (shell.ts), for a cold start offline.
   * Cache: a 401 clears it with the rest of the meta (wipe.ts).
   */
  | 'shell';

export type MetaRow = { key: MetaKey; value: unknown };
/** The app lock (v4). */
export type LockRow = { key: 'device'; record: LockRecord };
/** A kept thing's extras (v4): `sealed` is its SyncExtra, under the id `extra:<thingId>`. */
export type ExtraRow = { thingId: string; locationId: string; run: string; sealed: Sealed };
/** A kept document (v4): `meta` is its SyncExtraDocument plus the thing, under `doc:<id>`;
 * `body` its bytes, under `body:<id>`, absent when too large to keep. */
export type ExtraDocRow = {
  attachmentId: string;
  locationId: string;
  thingId: string;
  run: string;
  bytes: number;
  meta: Sealed;
  body: Sealed | null;
};
/** A location kept offline on this device (v4). */
export type KeptOfflineRow = {
  locationId: string;
  state: 'downloading' | 'ready' | 'failed';
  things: number;
  documents: number;
  /** Stored bytes of its documents. */
  bytes: number;
  /** Documents over the per-file cap. */
  tooLarge: number;
  updatedAt: number | null;
};
/**
 * A thing with its search terms: `termsOf()` of the name, aliases, short code and the legacy and
 * own codes it carries (D42, D208).
 */
export type ThingRow = SnapThing & { terms: string[] };
/** A legacy code under its composite key (`legacyKey()`); the snapshot sends no id for it. */
export type LegacyRow = SnapLegacyCode & { key: string };
/** A queued op; `settledAt` (ms) is when the server answered it. `seq` is assigned on add. */
export type QueueRow = Omit<QueueEntry, 'seq'> & { seq?: number; settledAt?: number };
/** A captured file waiting to upload, as bytes (see above). `uploaded` is 0 or 1. */
export type BlobRow = Omit<LocalBlob, 'blob'> & {
  queueSeq: number;
  bytes: ArrayBuffer;
  type: string;
  uploaded: 0 | 1;
};
export type ThumbRow = {
  fileId: string;
  bytes: ArrayBuffer;
  type: string;
  size: number;
  lastUsedAt: number;
};
export type TrayRow = { thingId: string; addedAt: number };
export type NoticeRow = Omit<SyncNotice, 'id'> & { id?: number };
/** A share waiting on the capture screen's sheet (D140), its files as bytes. */
export type SharedRow = {
  id: string;
  at: string;
  title: string | null;
  text: string | null;
  files: { name: string; type: string; bytes: ArrayBuffer }[];
};

export class KeptDb extends Dexie {
  declare meta: Table<MetaRow, MetaKey>;
  declare locations: Table<SnapLocation, string>;
  declare places: Table<SnapPlace, string>;
  declare things: Table<ThingRow, string>;
  declare codes: Table<SnapCode, string>;
  declare legacyCodes: Table<LegacyRow, string>;
  declare types: Table<SnapType, string>;
  declare queue: Table<QueueRow, number>;
  declare blobs: Table<BlobRow, string>;
  declare thumbs: Table<ThumbRow, string>;
  declare tray: Table<TrayRow, string>;
  declare notices: Table<NoticeRow, number>;
  declare shared: Table<SharedRow, string>;
  declare lock: Table<LockRow, 'device'>;
  declare extras: Table<ExtraRow, string>;
  declare extraDocs: Table<ExtraDocRow, string>;
  declare keptOffline: Table<KeptOfflineRow, string>;

  constructor(userId: string, options?: DexieOptions) {
    super(dbName(userId), options);
    this.version(1).stores(V1_STORES);
    // v2: a thing carries its meters (SnapThing.meters, READING offline). A copy pulled before
    // has none, and a delta never resends a thing that hasn't changed, so the copy starts over:
    // the snapshot's tables and meta go, and the next sync pulls in full. The queue and its
    // files, the tray, the notices and the shares stay.
    this.version(2)
      .stores(V1_STORES)
      .upgrade(async (tx) => {
        for (const table of SNAPSHOT_TABLES) await tx.table(table).clear();
        await tx.table('meta').bulkDelete([...SNAPSHOT_META_KEYS]);
      });
    // v3: search finds a thing by its legacy and own codes (D208), so its terms hold them, and
    // legacy codes are indexed by thing to recompute those terms when only a code changes. The
    // copy has every row it needs: the terms are rebuilt in place, with no new pull.
    this.version(3)
      .stores(V3_STORES)
      .upgrade(async (tx) => {
        const codes = legacyCodesByThing(await tx.table<LegacyRow>('legacyCodes').toArray());
        await tx
          .table<ThingRow>('things')
          .toCollection()
          .modify((row) => {
            row.terms = termsOf(row, codes.get(codesKey(row)));
          });
      });
    // v4: the app lock and the keep-offline extras, in tables of their own.
    this.version(4).stores(V4_STORES);
  }
}

export const dbName = (userId: string) => `kept-${userId}`;
