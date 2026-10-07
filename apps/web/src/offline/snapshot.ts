/**
 * The snapshot pull (plan T12, T24; engineering spec §2.2, §7.4; D156). The first sync sends no
 * cursor and gets everything; every later one sends the cursor the last page left, and gets only
 * what changed since the previous complete pass (T12's xid watermark), plus tombstones
 * (`removed`) and locations the person lost (`revokedLocationIds`), which the store deletes at
 * once. Pages are followed until `complete`. The types list comes only when its hash changed.
 */
import type { SnapshotPage } from '@kept/shared';
import type { SnapshotParams } from '@/api/capture/types';
import type { SyncStore } from './sync-store';

/** A bound on pages per run, so a server bug can't loop the phone forever. */
export const MAX_SNAPSHOT_PAGES = 200;

export type SnapshotFetch = (params: SnapshotParams) => Promise<SnapshotPage>;

export type PullResult = { pages: number; complete: boolean; truncated: boolean };

/** Pulls pages into the store until one says `complete`. Each page is applied atomically. */
export async function pullSnapshot(
  store: SyncStore,
  fetchPage: SnapshotFetch,
  maxPages: number = MAX_SNAPSHOT_PAGES,
): Promise<PullResult> {
  let truncated = false;
  for (let i = 0; i < maxPages; i++) {
    const cursor = await store.cursor();
    const typesHash = (await store.meta('typesHash')) as string | undefined;
    const page = await fetchPage({
      ...(cursor ? { cursor } : {}),
      ...(typesHash ? { typesHash } : {}),
    });
    await store.applySnapshot(page);
    truncated ||= page.truncated === true;
    if (page.complete) return { pages: i + 1, complete: true, truncated };
  }
  return { pages: maxPages, complete: false, truncated };
}
