/**
 * Thumbnails for offline browsing (plan T24; engineering spec §2.2; D181). A thumb is fetched
 * while online (`POST /files/:id/url {variant: 'thumb'}`, then the signed URL), kept as bytes in
 * the per-user database, and served as an object URL. Least recently used first out, past
 * 200 MB. **Never through the Cache API** (D181): it isn't per user and isn't wiped with the
 * database, so an authenticated file could outlive the session there.
 */
import { api } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import type { KeptDb } from './db';

/** The cache's size before the oldest thumbs go (§2.2). */
export const THUMB_LIMIT_BYTES = 200 * 1024 * 1024;
/** A hit refreshes `lastUsedAt` at most this often, so browsing doesn't write on every render. */
const TOUCH_EVERY_MS = 60_000;

export type ThumbFetch = (fileId: string) => Promise<Blob>;

/** The signed thumb URL, then its bytes. */
export const fetchThumb: ThumbFetch = async (fileId) => {
  const { url } = await api.post<{ url: string }>(inventoryPaths.fileUrl(fileId), {
    variant: 'thumb',
  });
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`thumb ${fileId}: HTTP ${res.status}`);
  return res.blob();
};

export class ThumbCache {
  private urls = new Map<string, string>();

  constructor(
    private readonly db: KeptDb,
    private readonly fetchBlob: ThumbFetch = fetchThumb,
    private readonly limitBytes: number = THUMB_LIMIT_BYTES,
    private readonly now: () => number = Date.now,
  ) {}

  /** An object URL for the file's thumb: from the phone, else fetched now; null if neither. */
  async url(fileId: string): Promise<string | null> {
    const known = this.urls.get(fileId);
    if (known) return known;
    const blob = (await this.get(fileId)) ?? (await this.fetchAndKeep(fileId));
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    this.urls.set(fileId, url);
    return url;
  }

  /** The stored thumb, touching its last use. */
  async get(fileId: string): Promise<Blob | undefined> {
    const row = await this.db.thumbs.get(fileId);
    if (!row) return undefined;
    if (this.now() - row.lastUsedAt > TOUCH_EVERY_MS)
      await this.db.thumbs.update(fileId, { lastUsedAt: this.now() });
    return new Blob([row.bytes], { type: row.type });
  }

  /** Stores a thumb, then evicts the least recently used past the limit. */
  async put(fileId: string, blob: Blob): Promise<void> {
    const bytes = await blob.arrayBuffer();
    try {
      await this.db.thumbs.put({
        fileId,
        bytes,
        type: blob.type,
        size: bytes.byteLength,
        lastUsedAt: this.now(),
      });
    } catch {
      // No room: a thumb is a nicety, never worth failing for. The next view fetches it again.
      return;
    }
    await this.evict();
  }

  /** Deletes the oldest thumbs until the cache is within its limit. */
  async evict(): Promise<void> {
    let total = 0;
    await this.db.thumbs.each((t) => {
      total += t.size;
    });
    if (total <= this.limitBytes) return;
    const oldest = await this.db.thumbs.orderBy('lastUsedAt').toArray();
    const drop: string[] = [];
    for (const t of oldest) {
      if (total <= this.limitBytes) break;
      total -= t.size;
      drop.push(t.fileId);
    }
    await this.db.thumbs.bulkDelete(drop);
    for (const id of drop) this.revoke(id);
  }

  /** Every object URL handed out (sign-out, a 401: wipe). */
  revokeAll(): void {
    for (const id of [...this.urls.keys()]) this.revoke(id);
  }

  private revoke(fileId: string) {
    const url = this.urls.get(fileId);
    if (url) URL.revokeObjectURL(url);
    this.urls.delete(fileId);
  }

  private async fetchAndKeep(fileId: string): Promise<Blob | undefined> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return undefined;
    try {
      const blob = await this.fetchBlob(fileId);
      await this.put(fileId, blob);
      return blob;
    } catch {
      return undefined;
    }
  }
}
