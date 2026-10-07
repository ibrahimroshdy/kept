/**
 * The phone's offline store: the seam between the screens that work offline (capture, scan, the
 * carrying tray, box check, the inbox's offline view: plan T25–T27) and the Dexie database that
 * holds it (T24). Screens code against `OfflineStore` only. `MemoryStore` implements it in memory
 * for tests and the mock (demo) mode; T24's Dexie store passes the same contract suite
 * (store.test.ts, `storeContract`).
 *
 * What it holds (engineering spec §2.2; D36, D159, D181): the read-only snapshot (locations,
 * places, things, codes, legacy codes: never secrets, money, documents or contact details), the
 * capture queue with its blobs, the carrying tray and the sync notices. It is wiped on sign-out
 * and on any 401.
 *
 * **Optimistic rows.** A queued `create_thing` shows at once where it was captured: `thing()`,
 * `contentsOf()` and `search()` include it with `shortCode: null` ("ID pending", D112) until the
 * snapshot brings the real row. A queued `move` shows the thing in its new place.
 */
import {
  legacyCodeKey,
  normalize,
  PAYLOAD_VERSION,
  type QueueItem,
  type SnapCode,
  type SnapLegacyCode,
  type SnapLocation,
  type SnapPlace,
  type SnapRemoved,
  type SnapshotPage,
  type SnapThing,
  type SnapType,
  type SyncOpResult,
  stripPrefixes,
} from '@kept/shared';

/** Where a queued op is (T24's `queue.state`). */
export type QueueState =
  | 'pending'
  | 'uploading'
  | 'sent'
  | 'applied'
  | 'needs_review'
  | 'dropped'
  | 'blocked';

/** A queued op, as the store keeps it: the item, its order and its state. */
export type QueueEntry = QueueItem & {
  /** Queue order: ops are sent in this order (§7.4). */
  seq: number;
  state: QueueState;
  /** The server's answer, once there is one. */
  result?: SyncOpResult;
};

/**
 * A captured file waiting to upload (D34): THING mode keeps only the shrunk JPEG (`original`);
 * the evidence modes keep the untouched original and a 2048 px `display`.
 */
export type LocalBlob = {
  /** The file id the upload will use (`PUT /files/:id`), so a retry replays. */
  id: string;
  kind: 'original' | 'display';
  blob: Blob;
  sha256: string;
};

/**
 * Something the sync engine tells the person (D35): "1 change couldn't apply: the drill was
 * trashed by Bruce · Restore", "Update Kept to finish syncing", or a scan to re-check online.
 */
export type SyncNotice = {
  id: number;
  at: string;
  kind: 'dropped' | 'needs_review' | 'outdated' | 'scan_pending';
  idempotencyKey?: string;
  result?: SyncOpResult;
  /** `scan_pending`: the code read offline that wasn't on this phone. */
  code?: string;
};

/** What a code is on this phone, from the snapshot's codes. */
/**
 * Files shared into Kept from another app (D140, plan T23): the service worker receives the
 * share target's POST and hands it to the page, which keeps it here until the person chooses
 * RECEIPT or THING on the capture screen's "Shared into Kept" sheet (or discards it). Kept in the
 * signed-in person's store because the service worker can't know whose store to open.
 */
export type SharedFile = { name: string; type: string; blob: Blob };
export type SharedInto = {
  /** The service worker's id for the share; `/capture?shared=<id>`. */
  id: string;
  /** When it arrived (ISO). */
  at: string;
  title: string | null;
  text: string | null;
  files: SharedFile[];
};

export type CodeHit = { kind: 'thing' | 'place' | 'blank'; id?: string; locationId: string };
export type LegacyHit = { locationId: string; thingId?: string; placeId?: string };
/** Where a legacy code came from: a Homebox import, a CSV import, the household's own (D208), or
 * a Kept import that re-issued a printed short ID because it was taken here (`kept`, step-7 Q9). */
export type LegacySource = 'homebox' | 'csv' | 'own' | 'kept';

export interface OfflineStore {
  // ----- snapshot -----
  /** Upserts one page: rows, deletions (`deleted`, `removed`), revoked locations, the cursor. */
  applySnapshot(page: SnapshotPage): Promise<void>;
  /** The cursor to send next, or null before the first sync. */
  cursor(): Promise<string | null>;
  locations(): Promise<SnapLocation[]>;
  placesOf(locationId: string): Promise<SnapPlace[]>;
  /** Direct contents of a place or a container, optimistic rows included. */
  contentsOf(target: { placeId?: string; containerId?: string }): Promise<SnapThing[]>;
  thing(id: string): Promise<SnapThing | undefined>;
  /** The live things with a meter in these locations (READING's targets, offline too). */
  metered(locationIds: readonly string[]): Promise<SnapThing[]>;
  /** A short ID: the codes, then a thing's own, then a `kept` legacy code (a label re-issued by
   * a Kept import still opens its thing, offline too; step-7 T20). */
  byCode(code: string): Promise<CodeHit | undefined>;
  byLegacy(source: LegacySource, code: string): Promise<LegacyHit[]>;
  /**
   * The `normalize()` twin of the server's search: names, aliases, short codes, and the legacy
   * and own codes the thing carries in its location (D42, D146, D208). Things only: the server's
   * places group has no offline twin.
   */
  search(q: string, limit: number): Promise<SnapThing[]>;
  /** When the snapshot was last taken: "as of last sync, 14:02" (D188). */
  asOf(): Promise<string | null>;
  // ----- queue -----
  /** Queues one op with its blobs; the store adds `clientVersion` and `payloadVersion`. */
  enqueue(
    item: Omit<QueueItem, 'clientVersion' | 'payloadVersion'>,
    blobs: LocalBlob[],
  ): Promise<void>;
  /** Ops not yet answered (`pending`, `uploading`, `sent`, `blocked`), in queue order. */
  pending(): Promise<QueueEntry[]>;
  counts(): Promise<{ waiting: number; uploading: number; needsAttention: number }>;
  /**
   * Takes back ops the server has never seen (capture's "Undo this batch", plan T25): those
   * still `pending` or `blocked` leave the queue with their files. Ops that are `uploading`,
   * `sent` or answered stay; the server undoes those. Answers the idempotency keys removed.
   */
  unqueue(idempotencyKeys: string[]): Promise<string[]>;
  // ----- tray and notices -----
  /** The carrying tray (D175): thing ids, in the order they were picked up. */
  tray(): Promise<string[]>;
  setTray(ids: string[]): Promise<void>;
  notices(): Promise<SyncNotice[]>;
  // ----- shared into Kept (D140) -----
  /** Keeps a share until it is kept as a capture or discarded; the same id replaces it. */
  putShared(share: SharedInto): Promise<void>;
  shared(id: string): Promise<SharedInto | undefined>;
  dropShared(id: string): Promise<void>;
  /** Everything, on sign-out and on any 401 (D181). */
  wipe(): Promise<void>;
}

/**
 * The search terms of a row: its name, aliases, short code and `codes` (its legacy and own
 * codes, `legacyCodesByThing()`), normalised and stripped (D42, D208).
 */
export function termsOf(
  t: Pick<SnapThing, 'name' | 'aliases' | 'shortCode'>,
  codes: readonly string[] = [],
): string[] {
  const words = [t.name ?? '', ...Object.values(t.aliases).flat(), t.shortCode ?? '', ...codes]
    .flatMap((s) => normalize(s).split(' '))
    .filter((w) => w !== '');
  return [...new Set(words.flatMap((w) => [w, stripPrefixes(w)]))];
}

/** Where `legacyCodesByThing()` files a thing's codes: its location and id. */
export const codesKey = (t: { locationId: string; id: string }) => `${t.locationId}:${t.id}`;

/**
 * Legacy and own codes (any source, D146, D208) by the thing they are on, under `codesKey()`:
 * a code left behind in a location the thing has moved out of doesn't find it.
 */
export function legacyCodesByThing(rows: Iterable<SnapLegacyCode>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of rows) {
    if (c.thingId === null) continue;
    const k = codesKey({ locationId: c.locationId, id: c.thingId });
    out.set(k, [...(out.get(k) ?? []), c.code]);
  }
  return out;
}

/** Queue states the server hasn't answered yet. */
export const UNANSWERED: ReadonlySet<QueueState> = new Set([
  'pending',
  'uploading',
  'sent',
  'blocked',
]);

/**
 * The in-memory `OfflineStore`, for tests and the demo mode. Not persistent: a page reload
 * starts empty, which is what a fresh phone looks like.
 */
export class MemoryStore implements OfflineStore {
  private meta: { cursor: string | null; asOf: string | null } = { cursor: null, asOf: null };
  private locs = new Map<string, SnapLocation>();
  private places = new Map<string, SnapPlace>();
  private things = new Map<string, SnapThing>();
  private codes = new Map<string, SnapCode>();
  private legacy = new Map<string, SnapLegacyCode>();
  private types = new Map<string, SnapType>();
  private queue: QueueEntry[] = [];
  private blobs: (LocalBlob & { queueSeq: number })[] = [];
  private trayIds: string[] = [];
  private noticeList: SyncNotice[] = [];
  private shares = new Map<string, SharedInto>();
  private seq = 0;

  constructor(private readonly clientVersion = '0.0.0-dev') {}

  async applySnapshot(page: SnapshotPage): Promise<void> {
    for (const l of page.locations) this.locs.set(l.id, l);
    if (page.types.items) {
      this.types.clear();
      for (const t of page.types.items) this.types.set(t.id, t);
    }
    for (const p of page.changes.places) {
      if (p.deleted) this.places.delete(p.id);
      else this.places.set(p.id, p);
    }
    for (const t of page.changes.things) {
      if (t.deleted) this.things.delete(t.id);
      else this.things.set(t.id, t);
    }
    for (const c of page.changes.codes) this.codes.set(c.code, c);
    for (const c of page.changes.legacyCodes) this.legacy.set(legacyKey(c), c);
    // A tombstone says "no longer in that location" (SnapRemoved): a row now held in another
    // location stays, and what pointed at it in that location goes with it.
    const heldThere = (m: Map<string, { locationId: string }>, r: SnapRemoved) =>
      m.get(r.entityId)?.locationId === r.locationId;
    for (const r of page.removed) {
      if (r.entityType === 'thing' || r.entityType === 'place') {
        const rows = r.entityType === 'thing' ? this.things : this.places;
        if (heldThere(rows, r)) rows.delete(r.entityId);
        const points = (c: {
          locationId: string;
          thingId: string | null;
          placeId: string | null;
        }) =>
          c.locationId === r.locationId && (c.thingId === r.entityId || c.placeId === r.entityId);
        for (const [k, c] of this.codes) if (points(c)) this.codes.delete(k);
        for (const [k, c] of this.legacy) if (points(c)) this.legacy.delete(k);
      }
      if (r.entityType === 'code' && heldThere(this.codes, r)) this.codes.delete(r.entityId);
      if (r.entityType === 'legacy_code') this.legacy.delete(r.entityId);
    }
    for (const gone of page.revokedLocationIds) this.dropLocation(gone);
    // A code claimed since the thing's row was sent shows on the thing (primaryCodeOf).
    const primary = primaryCodes(this.codes.values());
    for (const id of codeTouched(page)) {
      const t = this.things.get(id);
      const code = t ? primaryCodeOf(t, primary) : null;
      if (t && code !== t.shortCode) this.things.set(id, { ...t, shortCode: code });
    }
    this.meta = { cursor: page.nextCursor, asOf: page.asOf };
  }

  async cursor() {
    return this.meta.cursor;
  }
  async asOf() {
    return this.meta.asOf;
  }
  async locations() {
    return [...this.locs.values()];
  }
  async placesOf(locationId: string) {
    return [...this.places.values()]
      .filter((p) => p.locationId === locationId)
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
  }
  async contentsOf(target: { placeId?: string; containerId?: string }) {
    return this.view().filter((t) =>
      target.containerId !== undefined
        ? t.containerId === target.containerId
        : t.placeId === (target.placeId ?? null) && t.containerId === null,
    );
  }
  async thing(id: string) {
    return this.view().find((t) => t.id === id);
  }
  async metered(locationIds: readonly string[]) {
    const here = new Set(locationIds);
    return this.view().filter(
      (t) => here.has(t.locationId) && !t.deleted && (t.meters?.length ?? 0) > 0,
    );
  }
  async byCode(code: string): Promise<CodeHit | undefined> {
    const c = this.codes.get(code);
    if (c && c.state !== 'retired') {
      if (c.state === 'blank') return { kind: 'blank', locationId: c.locationId };
      if (c.thingId) return { kind: 'thing', id: c.thingId, locationId: c.locationId };
      if (c.placeId) return { kind: 'place', id: c.placeId, locationId: c.locationId };
    }
    const t = [...this.things.values()].find((x) => x.shortCode === code);
    if (t) return { kind: 'thing', id: t.id, locationId: t.locationId };
    return reissuedHit(await this.byLegacy('kept', code));
  }
  async byLegacy(source: LegacySource, code: string): Promise<LegacyHit[]> {
    return [...this.legacy.values()]
      .filter((c) => c.source === source && c.code === code)
      .map((c) => ({
        locationId: c.locationId,
        ...(c.thingId ? { thingId: c.thingId } : {}),
        ...(c.placeId ? { placeId: c.placeId } : {}),
      }));
  }
  async search(q: string, limit: number) {
    const words = normalize(q)
      .split(' ')
      .filter((w) => w !== '')
      .map((w) => stripPrefixes(w));
    if (words.length === 0) return [];
    const codes = legacyCodesByThing(this.legacy.values());
    return this.view()
      .filter((t) => {
        const terms = termsOf(t, codes.get(codesKey(t)));
        return words.every((w) => terms.some((term) => term.startsWith(w)));
      })
      .slice(0, limit);
  }

  async enqueue(
    item: Omit<QueueItem, 'clientVersion' | 'payloadVersion'>,
    blobs: LocalBlob[],
  ): Promise<void> {
    if (this.queue.some((e) => e.idempotencyKey === item.idempotencyKey)) return;
    this.seq += 1;
    this.queue.push({
      ...item,
      clientVersion: this.clientVersion,
      payloadVersion: PAYLOAD_VERSION,
      seq: this.seq,
      state: 'pending',
    });
    for (const b of blobs) this.blobs.push({ ...b, queueSeq: this.seq });
  }
  async pending() {
    return this.queue.filter((e) => UNANSWERED.has(e.state)).sort((a, b) => a.seq - b.seq);
  }
  async unqueue(idempotencyKeys: string[]) {
    const keys = new Set(idempotencyKeys);
    const gone = this.queue.filter(
      (e) => keys.has(e.idempotencyKey) && (e.state === 'pending' || e.state === 'blocked'),
    );
    const seqs = new Set(gone.map((e) => e.seq));
    this.queue = this.queue.filter((e) => !seqs.has(e.seq));
    this.blobs = this.blobs.filter((b) => !seqs.has(b.queueSeq));
    return gone.map((e) => e.idempotencyKey);
  }
  async counts() {
    let waiting = 0;
    let uploading = 0;
    let needsAttention = 0;
    for (const e of this.queue) {
      if (e.state === 'pending') waiting += 1;
      else if (e.state === 'uploading' || e.state === 'sent') uploading += 1;
      else if (e.state === 'needs_review' || e.state === 'dropped' || e.state === 'blocked')
        needsAttention += 1;
    }
    return { waiting, uploading, needsAttention };
  }

  async tray() {
    return [...this.trayIds];
  }
  async setTray(ids: string[]) {
    this.trayIds = [...new Set(ids)];
  }
  async notices() {
    return [...this.noticeList];
  }
  /** As `SyncStore.addNotice` (Dexie): the scanner keeps "Not on this phone" scans here (T26). */
  async addNotice(notice: Omit<SyncNotice, 'id' | 'at'>) {
    const id = Math.max(0, ...this.noticeList.map((n) => n.id)) + 1;
    this.noticeList.push({ ...notice, id, at: new Date().toISOString() });
  }
  async dismissNotice(id: number) {
    this.noticeList = this.noticeList.filter((n) => n.id !== id);
  }

  async putShared(share: SharedInto) {
    this.shares.set(share.id, { ...share, files: [...share.files] });
  }
  async shared(id: string) {
    return this.shares.get(id);
  }
  async dropShared(id: string) {
    this.shares.delete(id);
  }

  async wipe() {
    this.meta = { cursor: null, asOf: null };
    for (const m of [this.locs, this.places, this.things, this.codes, this.legacy, this.types])
      m.clear();
    this.queue = [];
    this.blobs = [];
    this.trayIds = [];
    this.noticeList = [];
    this.shares.clear();
  }

  // ----- helpers for tests and the mock's stand-in sync (not part of the interface) -----------

  /** Records the server's answer to an op, and a notice when it needs the person (D35). */
  settle(result: SyncOpResult, state: QueueState = result.outcome): void {
    const entry = this.queue.find((e) => e.idempotencyKey === result.idempotencyKey);
    if (!entry) return;
    entry.state = state;
    entry.result = result;
    if (result.outcome === 'applied') {
      this.blobs = this.blobs.filter((b) => b.queueSeq !== entry.seq);
      if (entry.op === 'create_thing' && result.entity?.shortCode) {
        const t = this.things.get(result.entity.id);
        if (t) t.shortCode = result.entity.shortCode;
      }
    } else {
      this.noticeList.push({
        id: this.noticeList.length + 1,
        at: new Date().toISOString(),
        kind: result.outcome === 'dropped' ? 'dropped' : 'needs_review',
        idempotencyKey: result.idempotencyKey,
        result,
      });
    }
  }
  /** The blobs still waiting for an op. */
  pendingBlobs(): LocalBlob[] {
    return this.blobs.map(({ queueSeq: _s, ...b }) => b);
  }

  /** Snapshot rows with the queue's optimistic changes laid over them. */
  private view(): SnapThing[] {
    const rows = new Map(this.things);
    for (const e of this.queue) {
      if (!UNANSWERED.has(e.state) && e.state !== 'applied') continue;
      applyOptimistic(rows, e);
    }
    return [...rows.values()];
  }

  private dropLocation(id: string) {
    this.locs.delete(id);
    for (const m of [this.places, this.things] as Map<string, { locationId: string }>[])
      for (const [k, v] of m) if (v.locationId === id) m.delete(k);
    for (const [k, v] of this.codes) if (v.locationId === id) this.codes.delete(k);
    for (const [k, v] of this.legacy) if (v.locationId === id) this.legacy.delete(k);
  }
}

/**
 * The code a thing shows and is found by (the ID chip, search, a scan, the tray): its primary
 * code in the snapshot's codes, else the row's own `shortCode`. `SnapThing.shortCode` is the
 * primary code as of the last time the thing's row was sent, and claiming a code changes only
 * the codes rows, so both stores write this onto the things a page touched.
 */
export function primaryCodeOf(t: SnapThing, primary: ReadonlyMap<string, SnapCode>) {
  const c = primary.get(t.id);
  return c && c.locationId === t.locationId ? c.code : t.shortCode;
}

/** Assigned primary codes by the thing they belong to. */
export function primaryCodes(codes: Iterable<SnapCode>): Map<string, SnapCode> {
  const out = new Map<string, SnapCode>();
  for (const c of codes)
    if (c.thingId !== null && c.isPrimary && c.state === 'assigned') out.set(c.thingId, c);
  return out;
}

/** The things a page may have changed the code of: its thing rows, and its codes' things. */
export function codeTouched(page: SnapshotPage): string[] {
  const ids = new Set(page.changes.things.map((t) => t.id));
  for (const c of page.changes.codes) if (c.thingId !== null) ids.add(c.thingId);
  return [...ids];
}

/** The key a legacy code is stored and tombstoned under: `legacyCodeKey` (T12 sends no id). */
export const legacyKey = (c: SnapLegacyCode) => legacyCodeKey(c);

/** What a queued op looks like on this phone before the server answers. */
export function applyOptimistic(rows: Map<string, SnapThing>, e: QueueEntry) {
  const { op, locationId } = e;
  const p = e.payload as Record<string, unknown>;
  // Only THING and LABEL captures make a thing; "+ photo" adds to one that exists, and a receipt
  // or a reading opens a draft purchase or reading instead (plan T13, T25).
  const makesThing =
    (p.mode === 'thing' || p.mode === 'label') &&
    p.attachToThingId === undefined &&
    p.pageOf === undefined;
  if (op === 'create_thing' && makesThing && typeof p.id === 'string' && !rows.has(p.id)) {
    const target = (p.target ?? {}) as { placeId?: string; containerId?: string };
    rows.set(p.id, {
      id: p.id,
      locationId,
      // "ID pending" until the server answers with the code it allocated (D112).
      shortCode: e.result?.entity?.shortCode ?? null,
      name: typeof p.name === 'string' ? p.name : null,
      typeId: typeof p.typeId === 'string' ? p.typeId : null,
      placeId: target.placeId ?? null,
      containerId: target.containerId ?? null,
      quantity: typeof p.quantity === 'string' ? p.quantity : '1',
      aliases: {},
      lifecycle: 'in_use',
      reviewState: typeof p.name === 'string' ? 'confirmed' : 'draft',
      locationUncertain: false,
      lastSeenAt: null,
      coverFileId: null,
      isContainer: false,
      deleted: false,
    });
  }
  if (op === 'move' && Array.isArray(p.thingIds)) {
    const to = (p.to ?? {}) as { placeId?: string; containerId?: string };
    for (const id of p.thingIds as string[]) {
      const t = rows.get(id);
      if (t)
        rows.set(id, { ...t, placeId: to.placeId ?? null, containerId: to.containerId ?? null });
    }
  }
}

/** A re-issued Kept label's live target (`byCode`'s last step): the first legacy hit. */
export function reissuedHit(hits: readonly LegacyHit[]): CodeHit | undefined {
  const h = hits[0];
  if (!h) return undefined;
  if (h.thingId) return { kind: 'thing', id: h.thingId, locationId: h.locationId };
  if (h.placeId) return { kind: 'place', id: h.placeId, locationId: h.locationId };
  return undefined;
}
