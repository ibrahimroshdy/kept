/**
 * The Dexie `OfflineStore` (plan T24), plus the engine-facing `SyncStore` methods. It passes the
 * same contract suite as `MemoryStore` (test/store-contract.ts). Loaded lazily (open.ts).
 *
 * - **Snapshot pages** apply in one transaction: a page is all or nothing, and the cursor moves
 *   only with its rows (T12's watermark re-sends anything committed during a pass, so a page
 *   applied twice is harmless: rows are upserted).
 * - **Optimistic rows** are `applyOptimistic` from store.ts over the rows a query found plus the
 *   rows the queue touches, exactly as `MemoryStore` does, so both stores show the same thing.
 * - **Quota.** A write that doesn't fit empties the thumbnail cache and is retried once; then it
 *   throws `StorageFullError` (persist.ts).
 */
import {
  KEPT_VERSION,
  PAYLOAD_VERSION,
  type QueueItem,
  type SnapRemoved,
  type SnapshotPage,
  type SnapThing,
  type SyncOpResult,
} from '@kept/shared';
import type { DexieOptions } from 'dexie';
import {
  type BlobRow,
  KeptDb,
  type MetaKey,
  type NoticeRow,
  type QueueRow,
  type SharedRow,
  SNAPSHOT_META_KEYS,
  SNAPSHOT_TABLES,
  type ThingRow,
} from './db';
import { indexWord, matchesAll, queryWords } from './local-search';
import { isQuotaError, StorageFullError } from './persist';
import {
  applyOptimistic,
  type CodeHit,
  codesKey,
  codeTouched,
  type LegacyHit,
  type LegacySource,
  type LocalBlob,
  legacyCodesByThing,
  legacyKey,
  primaryCodeOf,
  primaryCodes,
  type QueueEntry,
  type QueueState,
  reissuedHit,
  type SharedInto,
  type SyncNotice,
  termsOf,
  UNANSWERED,
} from './store';
import type { StoredBlob, SyncStore } from './sync-store';

const UNANSWERED_STATES = [...UNANSWERED];
/** Entries whose effect shows on the phone: unanswered, and applied until a snapshot has it. */
const OVERLAID_STATES = [...UNANSWERED_STATES, 'applied'];

const toEntry = (r: QueueRow): QueueEntry => {
  const { settledAt: _s, ...rest } = r;
  return rest as QueueEntry;
};
const stripTerms = ({ terms: _t, ...t }: ThingRow): SnapThing => t;

export class DexieStore implements SyncStore {
  readonly db: KeptDb;

  constructor(
    readonly userId: string,
    private readonly clientVersion: string = KEPT_VERSION,
    options?: DexieOptions,
  ) {
    this.db = new KeptDb(userId, options);
  }

  // ----- snapshot ------------------------------------------------------------------------------

  async applySnapshot(page: SnapshotPage): Promise<void> {
    const db = this.db;
    const thingRows: ThingRow[] = [];
    const deletedThings: string[] = [];
    for (const t of page.changes.things) {
      if (t.deleted) deletedThings.push(t.id);
      else thingRows.push({ ...t, terms: termsOf(t) });
    }
    await this.withRoom(() =>
      db.transaction(
        'rw',
        [
          db.locations,
          db.places,
          db.things,
          db.codes,
          db.legacyCodes,
          db.types,
          db.meta,
          db.extras,
          db.extraDocs,
          db.keptOffline,
        ],
        async () => {
          await db.locations.bulkPut(page.locations);
          if (page.types.items) {
            await db.types.clear();
            await db.types.bulkPut(page.types.items);
          }
          await db.places.bulkPut(page.changes.places.filter((p) => !p.deleted));
          await db.places.bulkDelete(page.changes.places.filter((p) => p.deleted).map((p) => p.id));
          await db.things.bulkPut(thingRows);
          await db.things.bulkDelete(deletedThings);
          await db.codes.bulkPut(page.changes.codes);
          await db.legacyCodes.bulkPut(
            page.changes.legacyCodes.map((c) => ({ ...c, key: legacyKey(c) })),
          );
          // A tombstone says "no longer in that location" (SnapRemoved): a row the phone now
          // holds in another location (moved there, in this page or an earlier one) stays.
          const gone = (type: SnapRemoved['entityType']) =>
            page.removed.filter((r) => r.entityType === type);
          const heldThere = async (
            table: typeof db.things | typeof db.places | typeof db.codes,
            rows: SnapRemoved[],
          ) => {
            const held = await table.bulkGet(rows.map((r) => r.entityId));
            return rows.filter((r, i) => held[i]?.locationId === r.locationId);
          };
          const things = await heldThere(db.things, gone('thing'));
          const places = await heldThere(db.places, gone('place'));
          await db.things.bulkDelete(things.map((r) => r.entityId));
          await db.places.bulkDelete(places.map((r) => r.entityId));
          await db.codes.bulkDelete(
            (await heldThere(db.codes, gone('code'))).map((r) => r.entityId),
          );
          // A legacy code gone or come changes its thing's search terms, not its row.
          const goneLegacy = gone('legacy_code').map((r) => r.entityId);
          const codeThings = [
            ...page.changes.legacyCodes,
            ...(await db.legacyCodes.bulkGet(goneLegacy)),
          ].flatMap((c) => (c?.thingId ? [c.thingId] : []));
          await db.legacyCodes.bulkDelete(goneLegacy);
          // What pointed at them in that location left or went with them.
          for (const [loc, ids] of byLocation([...gone('thing'), ...gone('place')])) {
            const points = (c: { thingId: string | null; placeId: string | null }) =>
              ids.has(c.thingId ?? '') || ids.has(c.placeId ?? '');
            await db.codes.where('locationId').equals(loc).filter(points).delete();
            await db.legacyCodes.where('locationId').equals(loc).filter(points).delete();
          }
          for (const loc of page.revokedLocationIds) {
            await db.locations.delete(loc);
            for (const table of [db.places, db.things, db.codes, db.legacyCodes])
              await table.where('locationId').equals(loc).delete();
            // What was kept offline there goes too (step 8, D159, D181).
            await db.extras.where('locationId').equals(loc).delete();
            await db.extraDocs.where('locationId').equals(loc).delete();
            await db.keptOffline.delete(loc);
          }
          // A code claimed since the thing's row was sent shows on it, and finds it (primaryCodeOf);
          // its legacy and own codes find it too (D208), whichever of them this page brought.
          const touched = [...new Set([...codeTouched(page), ...codeThings])];
          if (touched.length > 0) {
            const primary = primaryCodes(await db.codes.where('thingId').anyOf(touched).toArray());
            const codes = legacyCodesByThing(
              await db.legacyCodes.where('thingId').anyOf(touched).toArray(),
            );
            const fixed: ThingRow[] = [];
            for (const row of await db.things.bulkGet(touched)) {
              if (!row) continue;
              const t = { ...stripTerms(row), shortCode: primaryCodeOf(row, primary) };
              const terms = termsOf(t, codes.get(codesKey(t)));
              const same =
                t.shortCode === row.shortCode &&
                terms.length === row.terms.length &&
                terms.every((w, i) => w === row.terms[i]);
              if (!same) fixed.push({ ...t, terms });
            }
            await db.things.bulkPut(fixed);
          }
          await db.meta.bulkPut([
            { key: 'cursor', value: page.nextCursor },
            { key: 'asOf', value: page.asOf },
            { key: 'typesHash', value: page.types.hash },
            { key: 'truncated', value: page.truncated === true },
            {
              key: 'serverPayloadWindow',
              value: { min: page.minPayloadVersion, max: page.payloadVersion },
            },
          ]);
        },
      ),
    );
  }

  async cursor() {
    return ((await this.meta('cursor')) as string | undefined) ?? null;
  }
  async asOf() {
    return ((await this.meta('asOf')) as string | undefined) ?? null;
  }
  async locations() {
    return this.db.locations.toArray();
  }
  async placesOf(locationId: string) {
    const rows = await this.db.places.where('locationId').equals(locationId).toArray();
    return rows.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  }

  async contentsOf(target: { placeId?: string; containerId?: string }) {
    const base =
      target.containerId !== undefined
        ? await this.db.things.where('containerId').equals(target.containerId).toArray()
        : target.placeId !== undefined
          ? await this.db.things.where('placeId').equals(target.placeId).toArray()
          : await this.db.things.filter((t) => t.placeId === null).toArray();
    const rows = await this.overlaid(base);
    return rows.filter((t) =>
      target.containerId !== undefined
        ? t.containerId === target.containerId
        : t.placeId === (target.placeId ?? null) && t.containerId === null,
    );
  }

  async thing(id: string) {
    const row = await this.db.things.get(id);
    return (await this.overlaid(row ? [row] : [])).find((t) => t.id === id);
  }

  async metered(locationIds: readonly string[]) {
    if (locationIds.length === 0) return [];
    const base = await this.db.things
      .where('locationId')
      .anyOf([...locationIds])
      .filter((t) => (t.meters?.length ?? 0) > 0)
      .toArray();
    const here = new Set(locationIds);
    // The overlay may move one out, or trash it, meanwhile.
    return (await this.overlaid(base)).filter(
      (t) => here.has(t.locationId) && !t.deleted && (t.meters?.length ?? 0) > 0,
    );
  }

  async byCode(code: string): Promise<CodeHit | undefined> {
    const c = await this.db.codes.get(code);
    if (c && c.state !== 'retired') {
      if (c.state === 'blank') return { kind: 'blank', locationId: c.locationId };
      if (c.thingId) return { kind: 'thing', id: c.thingId, locationId: c.locationId };
      if (c.placeId) return { kind: 'place', id: c.placeId, locationId: c.locationId };
    }
    const t = await this.db.things.where('shortCode').equals(code).first();
    if (t) return { kind: 'thing', id: t.id, locationId: t.locationId };
    return reissuedHit(await this.byLegacy('kept', code));
  }

  async byLegacy(source: LegacySource, code: string): Promise<LegacyHit[]> {
    const rows = await this.db.legacyCodes.where('[source+code]').equals([source, code]).toArray();
    return rows.map((c) => ({
      locationId: c.locationId,
      ...(c.thingId ? { thingId: c.thingId } : {}),
      ...(c.placeId ? { placeId: c.placeId } : {}),
    }));
  }

  async search(q: string, limit: number) {
    const words = queryWords(q);
    const first = indexWord(words);
    if (first === undefined) return [];
    const base = await this.db.things.where('terms').startsWith(first).distinct().toArray();
    const rows = await this.overlaid(base);
    const codes = legacyCodesByThing(
      await this.db.legacyCodes
        .where('thingId')
        .anyOf(rows.map((t) => t.id))
        .toArray(),
    );
    return rows
      .filter((t) => matchesAll(termsOf(t, codes.get(codesKey(t))), words))
      .slice(0, limit);
  }

  // ----- queue ---------------------------------------------------------------------------------

  async enqueue(
    item: Omit<QueueItem, 'clientVersion' | 'payloadVersion'>,
    blobs: LocalBlob[],
  ): Promise<void> {
    // Read the bytes before the transaction: awaiting anything but IndexedDB inside it commits it.
    const files = await Promise.all(
      blobs.map(async (b) => ({
        id: b.id,
        kind: b.kind,
        sha256: b.sha256,
        type: b.blob.type,
        bytes: await b.blob.arrayBuffer(),
      })),
    );
    const db = this.db;
    await this.withRoom(() =>
      db.transaction('rw', db.queue, db.blobs, async () => {
        if ((await db.queue.where('idempotencyKey').equals(item.idempotencyKey).count()) > 0)
          return;
        const seq = await db.queue.add({
          ...item,
          clientVersion: this.clientVersion,
          payloadVersion: PAYLOAD_VERSION,
          state: 'pending',
        });
        await db.blobs.bulkPut(files.map((f): BlobRow => ({ ...f, queueSeq: seq, uploaded: 0 })));
      }),
    );
  }

  async pending() {
    const rows = await this.db.queue.where('state').anyOf(UNANSWERED_STATES).toArray();
    return rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)).map(toEntry);
  }

  async unqueue(idempotencyKeys: string[]): Promise<string[]> {
    const db = this.db;
    // One transaction: an op the engine has already marked `uploading` or `sent` stays (the
    // engine re-reads what it marked before sending, so nothing taken back here is sent).
    return db.transaction('rw', db.queue, db.blobs, async () => {
      const rows = await db.queue.where('idempotencyKey').anyOf(idempotencyKeys).toArray();
      const gone = rows
        .filter((e) => e.state === 'pending' || e.state === 'blocked')
        .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
      for (const e of gone) {
        if (e.seq === undefined) continue;
        await db.blobs.where('queueSeq').equals(e.seq).delete();
        await db.queue.delete(e.seq);
      }
      return gone.map((e) => e.idempotencyKey);
    });
  }

  async counts() {
    let waiting = 0;
    let uploading = 0;
    let needsAttention = 0;
    await this.db.queue.each((e) => {
      if (e.state === 'pending') waiting += 1;
      else if (e.state === 'uploading' || e.state === 'sent') uploading += 1;
      else if (e.state === 'needs_review' || e.state === 'dropped' || e.state === 'blocked')
        needsAttention += 1;
    });
    return { waiting, uploading, needsAttention };
  }

  // ----- tray, notices, shares -----------------------------------------------------------------

  async tray() {
    return (await this.db.tray.orderBy('addedAt').toArray()).map((r) => r.thingId);
  }
  async setTray(ids: string[]) {
    const start = Date.now();
    const rows = [...new Set(ids)].map((thingId, i) => ({ thingId, addedAt: start + i }));
    await this.db.transaction('rw', this.db.tray, async () => {
      await this.db.tray.clear();
      await this.db.tray.bulkPut(rows);
    });
  }
  async notices(): Promise<SyncNotice[]> {
    return (await this.db.notices.toArray()) as SyncNotice[];
  }

  async putShared(share: SharedInto) {
    const files = await Promise.all(
      share.files.map(async (f) => ({
        name: f.name,
        type: f.type,
        bytes: await f.blob.arrayBuffer(),
      })),
    );
    const row: SharedRow = { ...share, files };
    await this.withRoom(() => this.db.shared.put(row));
  }
  async shared(id: string): Promise<SharedInto | undefined> {
    const row = await this.db.shared.get(id);
    if (!row) return undefined;
    return {
      ...row,
      files: row.files.map((f) => ({
        name: f.name,
        type: f.type,
        blob: new Blob([f.bytes], { type: f.type }),
      })),
    };
  }
  async dropShared(id: string) {
    await this.db.shared.delete(id);
  }

  /**
   * A 401 (D210): the cached inventory goes, the person's own unanswered ops and files stay,
   * locked until someone signs in. Never deletes the database file.
   */
  async wipeCache() {
    const { clearCache } = await import('./wipe');
    await clearCache(this.db);
  }

  /** A cursor the server refused: the snapshot's copy and its meta go; the queue stays. */
  async resetSnapshot() {
    const db = this.db;
    const tables = SNAPSHOT_TABLES.map((name) => db.table(name));
    await db.transaction('rw', [...tables, db.meta], async () => {
      for (const t of tables) await t.clear();
      await db.meta.bulkDelete([...SNAPSHOT_META_KEYS]);
    });
  }

  /** Signed in again as this store's person: the kept queue may go (D210). */
  async unlock() {
    await this.db.meta.delete('lockedAt');
  }

  /**
   * Deletes the whole database (D181), then lets it reopen empty on the next call, so the same
   * store keeps working (the contract suite, and a sign-in as someone else on the same tab).
   */
  async wipe() {
    await this.db.delete({ disableAutoOpen: false });
  }

  // ----- SyncStore: what the engine needs beyond the screens' interface ------------------------

  async entries(): Promise<QueueEntry[]> {
    return (await this.db.queue.orderBy('seq').toArray()).map(toEntry);
  }

  async blobsOf(seq: number): Promise<StoredBlob[]> {
    const rows = await this.db.blobs.where('queueSeq').equals(seq).toArray();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      sha256: r.sha256,
      blob: new Blob([r.bytes], { type: r.type }),
      uploaded: r.uploaded === 1,
    }));
  }

  async unuploadedSeqs(): Promise<Set<number>> {
    const out = new Set<number>();
    await this.db.blobs.each((b) => {
      if (b.uploaded === 0) out.add(b.queueSeq);
    });
    return out;
  }

  async markUploaded(blobId: string) {
    await this.db.blobs.update(blobId, { uploaded: 1 });
  }

  async setState(seqs: number[], state: QueueState) {
    await this.db.queue.where('seq').anyOf(seqs).modify({ state });
  }

  async setPayload(seq: number, payload: unknown, payloadVersion: number) {
    await this.db.queue.update(seq, { payload, payloadVersion });
  }

  async settle(result: SyncOpResult, state: QueueState = result.outcome): Promise<void> {
    const db = this.db;
    await db.transaction('rw', [db.queue, db.blobs, db.notices, db.meta], async () => {
      const entry = await db.queue.where('idempotencyKey').equals(result.idempotencyKey).first();
      if (entry?.seq === undefined) return;
      await db.queue.update(entry.seq, { state, result, settledAt: Date.now() });
      // Answered either way: the files are on the server (a drop's restore re-uses them, T15).
      await db.blobs.where('queueSeq').equals(entry.seq).delete();
      if (result.outcome === 'applied') {
        if (entry.op === 'create_thing' && result.entity?.shortCode) {
          const list = ((await db.meta.get('printPending'))?.value as string[] | undefined) ?? [];
          if (!list.includes(result.entity.id))
            await db.meta.put({ key: 'printPending', value: [...list, result.entity.id] });
        }
        return;
      }
      await db.notices.add({
        at: new Date().toISOString(),
        kind: result.outcome === 'dropped' ? 'dropped' : 'needs_review',
        idempotencyKey: result.idempotencyKey,
        result,
      });
    });
  }

  async addNotice(notice: Omit<SyncNotice, 'id' | 'at'>) {
    const db = this.db;
    await db.transaction('rw', db.notices, async () => {
      // One "Update Kept to finish syncing" at a time, however many runs are refused.
      if (
        notice.kind === 'outdated' &&
        (await db.notices.filter((n) => n.kind === 'outdated').count()) > 0
      )
        return;
      await db.notices.add({ ...notice, at: new Date().toISOString() } as NoticeRow);
    });
  }

  async dismissNotice(id: number) {
    const db = this.db;
    await db.transaction('rw', db.notices, db.queue, async () => {
      const n = await db.notices.get(id);
      await db.notices.delete(id);
      if (!n?.idempotencyKey) return;
      // The person has seen the answer: the entry leaves "needs attention".
      await db.queue
        .where('idempotencyKey')
        .equals(n.idempotencyKey)
        .and((e) => e.state === 'dropped' || e.state === 'needs_review')
        .delete();
    });
  }

  async clearOutdated() {
    await this.db.notices.filter((n) => n.kind === 'outdated').delete();
  }

  /**
   * After a complete snapshot pass that started at `passStartedAt`: applied entries answered
   * before it are in the snapshot now, so their overlay (and "ID pending") can go.
   */
  async pruneApplied(passStartedAt: number) {
    await this.db.queue
      .where('state')
      .equals('applied')
      .and((e) => (e.settledAt ?? 0) < passStartedAt)
      .delete();
  }

  async meta(key: MetaKey): Promise<unknown> {
    return (await this.db.meta.get(key))?.value;
  }
  async setMeta(key: MetaKey, value: unknown) {
    await this.db.meta.put({ key, value });
  }

  /** Frees the thumbnail cache, the one thing on the phone that can always be fetched again. */
  async freeThumbs() {
    await this.db.thumbs.clear();
  }

  // ----- internals -----------------------------------------------------------------------------

  /** Rows with the queue's optimistic changes laid over them (as `MemoryStore.view()`). */
  private async overlaid(base: ThingRow[]): Promise<SnapThing[]> {
    const queue = (await this.db.queue.where('state').anyOf(OVERLAID_STATES).toArray())
      .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map(toEntry);
    const rows = new Map<string, SnapThing>(base.map((t) => [t.id, stripTerms(t)]));
    const touched = new Set<string>();
    for (const e of queue) for (const id of touchedIds(e)) if (!rows.has(id)) touched.add(id);
    if (touched.size > 0) {
      for (const t of await this.db.things.bulkGet([...touched]))
        if (t) rows.set(t.id, stripTerms(t));
    }
    for (const e of queue) applyOptimistic(rows, e);
    return [...rows.values()];
  }

  /** Runs a write; on a quota failure, frees the thumbnails and tries once more (persist.ts). */
  private async withRoom<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (e) {
      if (!isQuotaError(e)) throw e;
      await this.freeThumbs();
      try {
        return await write();
      } catch (again) {
        if (isQuotaError(again)) throw new StorageFullError();
        throw again;
      }
    }
  }
}

/** Removed ids by the location they left. */
function byLocation(rows: SnapRemoved[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const r of rows) out.set(r.locationId, (out.get(r.locationId) ?? new Set()).add(r.entityId));
  return out;
}

/** The thing ids a queued op shows on (a capture's new id, a move's things). */
function touchedIds(e: QueueEntry): string[] {
  const p = (e.payload ?? {}) as { id?: unknown; thingIds?: unknown };
  if (e.op === 'create_thing' && typeof p.id === 'string') return [p.id];
  if (e.op === 'move' && Array.isArray(p.thingIds))
    return p.thingIds.filter((x): x is string => typeof x === 'string');
  return [];
}

/** The Dexie store for a user (open.ts calls this after the dynamic import). */
export function createDexieStore(userId: string, clientVersion?: string, options?: DexieOptions) {
  return new DexieStore(userId, clientVersion, options);
}
