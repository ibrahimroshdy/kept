/**
 * "Keep this location available offline" on the device (step-8 plan T23; D159, D181, Q21, Q22):
 * fetch a location's extras (GET /api/v1/sync/extras, server sync/extras.ts), encrypt them under
 * the app lock's data key (offline/lock.ts) and keep them in IndexedDB (offline/db.ts v4).
 * Loaded lazily with Dexie; nothing of it is in the entry chunk.
 *
 * - **Never the Cache API** (D181): a document's bytes come from its five-minute signed URL
 *   (`POST /api/v1/files/:id/url?thingId=`, the original) with `cache: 'no-store'`, are checked
 *   against the server's SHA-256, then sealed into IndexedDB. The service worker never caches
 *   /api or /f (sw.ts), and a presigned S3 URL is cross-origin, which it doesn't handle.
 * - **Ciphertext at rest:** each thing's money and each document's description and bytes are
 *   AES-GCM under the data key, with the row's id as additional data. In the clear: ids, the
 *   location, the stored size (for the device's cap) and the counts.
 * - **Caps** (KEEP_OFFLINE): a document over `fileBytes` is listed, not stored ("too large to keep
 *   offline"); the device's total over `deviceBytes` refuses before the download (from the
 *   estimate) and stops one that grows past it: `KeepOfflineTooLarge` names what is kept.
 * - **A refresh** writes every row with a new run id, keeps a document whose hash hasn't changed
 *   without fetching it again, then removes the rows the run didn't write.
 * - Removed when the toggle goes off (`dropLocation`), on any 401 and after ten wrong PINs
 *   (wipe.ts clearCache), for a revoked location (dexie-store.ts applySnapshot), and with the
 *   whole database on sign-out.
 */
import {
  KEEP_OFFLINE,
  type SyncExtra,
  type SyncExtraDocument,
  type SyncExtrasEstimate,
  type SyncExtrasPage,
} from '@kept/shared';
import { type ExtraDocRow, KeptDb, type KeptOfflineRow } from './db';
import { randomBytes, seal, sealJson, sha256Hex, unseal, unsealJson } from './lock';

/** What keeping a location needs from the network; the screens pass the real API. */
export type ExtrasApi = {
  page: (locationId: string, cursor?: string) => Promise<SyncExtrasPage>;
  estimate: (locationId: string) => Promise<SyncExtrasEstimate>;
  /** The signed URL of a document's original; `thingId` serves a receipt after a move (D115). */
  fileUrl: (fileId: string, thingId: string) => Promise<{ url: string }>;
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;
};

/** A kept document as the screens read it, once unsealed. */
export type KeptDocument = SyncExtraDocument & { thingId: string; tooLarge: boolean };

export type KeepProgress = { done: number; total: number };

/** Keeping this would pass the device's cap (`keep_offline_too_large`). */
export class KeepOfflineTooLarge extends Error {
  constructor(
    /** What it would take, in bytes, with what is already kept. */
    readonly needed: number,
    /** The locations kept now, largest first: what to turn off. */
    readonly kept: { locationId: string; bytes: number }[],
  ) {
    super('keep_offline_too_large');
    this.name = 'KeepOfflineTooLarge';
  }
}

/** A downloaded document whose bytes don't match the server's hash. */
export class KeepOfflineCorrupt extends Error {
  constructor(readonly attachmentId: string) {
    super('the document did not match its hash');
    this.name = 'KeepOfflineCorrupt';
  }
}

export function openDeviceDb(userId: string, options?: ConstructorParameters<typeof KeptDb>[1]) {
  return new KeptDb(userId, options);
}

const extraId = (thingId: string) => `extra:${thingId}`;
const docId = (attachmentId: string) => `doc:${attachmentId}`;
const bodyId = (attachmentId: string) => `body:${attachmentId}`;

type DocMeta = SyncExtraDocument & { thingId: string };

const defaultFetch = async (url: string): Promise<ArrayBuffer> => {
  const res = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
};

export async function keptLocations(db: KeptDb): Promise<KeptOfflineRow[]> {
  return db.keptOffline.toArray();
}

/** Bytes stored for every kept location on this device. */
export async function deviceBytes(db: KeptDb): Promise<number> {
  return (await db.keptOffline.toArray()).reduce((n, r) => n + r.bytes, 0);
}

async function othersOf(db: KeptDb, locationId: string) {
  return (await db.keptOffline.toArray())
    .filter((r) => r.locationId !== locationId)
    .map((r) => ({ locationId: r.locationId, bytes: r.bytes }));
}

const tooLarge = (kept: { locationId: string; bytes: number }[], needed: number) =>
  new KeepOfflineTooLarge(
    needed,
    [...kept].sort((a, b) => b.bytes - a.bytes),
  );

/**
 * Keeps (or refreshes) a location: checks the estimate against the device's cap, then fetches
 * every page and document, sealing each under `key`.
 */
export async function keepLocation(
  db: KeptDb,
  key: CryptoKey,
  locationId: string,
  api: ExtrasApi,
  onProgress?: (p: KeepProgress) => void,
): Promise<KeptOfflineRow> {
  const fetchBytes = api.fetchBytes ?? defaultFetch;
  const others = await othersOf(db, locationId);
  const elsewhere = others.reduce((n, r) => n + r.bytes, 0);
  const estimate = await api.estimate(locationId);
  if (elsewhere + estimate.totalBytes > KEEP_OFFLINE.deviceBytes) {
    throw tooLarge(others, elsewhere + estimate.totalBytes);
  }
  const previous = await db.keptOffline.get(locationId);
  const row: KeptOfflineRow = {
    locationId,
    state: 'downloading',
    things: previous?.things ?? 0,
    documents: previous?.documents ?? 0,
    bytes: previous?.bytes ?? 0,
    tooLarge: previous?.tooLarge ?? 0,
    updatedAt: previous?.updatedAt ?? null,
  };
  await db.keptOffline.put(row);

  // What is already kept: a document whose hash hasn't changed isn't fetched again.
  const have = new Map<string, { sha256: string; stored: boolean }>();
  for (const d of await db.extraDocs.where('locationId').equals(locationId).toArray()) {
    try {
      const meta = await unsealJson<DocMeta>(key, docId(d.attachmentId), d.meta);
      have.set(d.attachmentId, { sha256: meta.sha256, stored: d.body !== null });
    } catch {
      // Sealed under another key (a lock set up again): fetched afresh.
    }
  }

  const run = Array.from(randomBytes(8), (b) => b.toString(16).padStart(2, '0')).join('');
  const totals = { things: 0, documents: 0, bytes: 0, tooLarge: 0 };
  let done = 0;
  onProgress?.({ done, total: estimate.totalBytes });
  try {
    let cursor: string | undefined;
    for (;;) {
      const page = await api.page(locationId, cursor);
      for (const item of page.items) {
        await keepItem(item);
      }
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    await db.transaction('rw', db.extras, db.extraDocs, async () => {
      await db.extras
        .where('locationId')
        .equals(locationId)
        .filter((r) => r.run !== run)
        .delete();
      await db.extraDocs
        .where('locationId')
        .equals(locationId)
        .filter((r) => r.run !== run)
        .delete();
    });
    const ready: KeptOfflineRow = { locationId, state: 'ready', ...totals, updatedAt: Date.now() };
    await db.keptOffline.put(ready);
    return ready;
  } catch (e) {
    await db.keptOffline.put({ ...row, state: 'failed' });
    throw e;
  }

  async function keepItem(item: SyncExtra) {
    totals.things += 1;
    await db.extras.put({
      thingId: item.thingId,
      locationId,
      run,
      sealed: await sealJson(key, extraId(item.thingId), item),
    });
    for (const doc of item.documents) {
      totals.documents += 1;
      const meta: DocMeta = { ...doc, thingId: item.thingId };
      const sealedMeta = await sealJson(key, docId(doc.attachmentId), meta);
      const base = {
        attachmentId: doc.attachmentId,
        locationId,
        thingId: item.thingId,
        run,
        meta: sealedMeta,
      };
      if (doc.bytes > KEEP_OFFLINE.fileBytes) {
        totals.tooLarge += 1;
        await db.extraDocs.put({ ...base, bytes: 0, body: null });
        continue;
      }
      const kept = have.get(doc.attachmentId);
      if (kept?.stored && kept.sha256 === doc.sha256) {
        await db.extraDocs.update(doc.attachmentId, { run, meta: sealedMeta });
      } else {
        if (elsewhere + totals.bytes + doc.bytes > KEEP_OFFLINE.deviceBytes) {
          throw tooLarge(others, elsewhere + totals.bytes + doc.bytes);
        }
        const { url } = await api.fileUrl(doc.fileId, item.thingId);
        const bytes = await fetchBytes(url);
        if ((await sha256Hex(bytes)) !== doc.sha256) throw new KeepOfflineCorrupt(doc.attachmentId);
        const row: ExtraDocRow = {
          ...base,
          bytes: bytes.byteLength,
          body: await seal(key, bodyId(doc.attachmentId), bytes),
        };
        await db.extraDocs.put(row);
      }
      totals.bytes += doc.bytes;
      done += doc.bytes;
      onProgress?.({ done, total: Math.max(estimate.totalBytes, done) });
    }
  }
}

/** The toggle goes off: everything kept for the location goes. */
export async function dropLocation(db: KeptDb, locationId: string): Promise<void> {
  await db.transaction('rw', db.extras, db.extraDocs, db.keptOffline, async () => {
    await db.extras.where('locationId').equals(locationId).delete();
    await db.extraDocs.where('locationId').equals(locationId).delete();
    await db.keptOffline.delete(locationId);
  });
}

/** Everything kept, every location (the app lock turned off). */
export async function dropAll(db: KeptDb): Promise<void> {
  await db.transaction('rw', db.extras, db.extraDocs, db.keptOffline, async () => {
    await db.extras.clear();
    await db.extraDocs.clear();
    await db.keptOffline.clear();
  });
}

/** A kept thing's money and documents, or null when its location isn't kept. */
export async function extraOf(
  db: KeptDb,
  key: CryptoKey,
  thingId: string,
): Promise<{ extra: SyncExtra; documents: KeptDocument[] } | null> {
  const row = await db.extras.get(thingId);
  if (!row) return null;
  const extra = await unsealJson<SyncExtra>(key, extraId(thingId), row.sealed);
  const docs = await db.extraDocs.where('thingId').equals(thingId).toArray();
  const documents: KeptDocument[] = [];
  for (const d of docs) {
    const meta = await unsealJson<DocMeta>(key, docId(d.attachmentId), d.meta);
    documents.push({ ...meta, tooLarge: d.body === null });
  }
  return { extra, documents };
}

/** Whether a thing's location is kept (no key needed: the row's presence only). */
export async function isKept(db: KeptDb, thingId: string): Promise<boolean> {
  return (await db.extras.get(thingId)) !== undefined;
}

/** The documents of a location too large to keep offline. */
export async function tooLargeOf(
  db: KeptDb,
  key: CryptoKey,
  locationId: string,
): Promise<KeptDocument[]> {
  const rows = await db.extraDocs
    .where('locationId')
    .equals(locationId)
    .filter((d) => d.body === null)
    .toArray();
  const out: KeptDocument[] = [];
  for (const d of rows) {
    out.push({
      ...(await unsealJson<DocMeta>(key, docId(d.attachmentId), d.meta)),
      tooLarge: true,
    });
  }
  return out;
}

/** A kept document's bytes, as a Blob of its type; null when not kept. */
export async function documentBlob(
  db: KeptDb,
  key: CryptoKey,
  attachmentId: string,
): Promise<Blob | null> {
  const row = await db.extraDocs.get(attachmentId);
  if (!row?.body) return null;
  const meta = await unsealJson<DocMeta>(key, docId(attachmentId), row.meta);
  const bytes = await unseal(key, bodyId(attachmentId), row.body);
  return new Blob([bytes], { type: meta.mime });
}
