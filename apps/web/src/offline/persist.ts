/**
 * Storage on the phone: the persistent-storage request (V11, D36, D101) and running out of room.
 *
 * - **Persistence.** Without it, a browser may evict the whole database under storage pressure,
 *   and iOS clears a site's data after weeks unused. `navigator.storage.persist()` is asked once,
 *   after the first capture (asking at first load is refused more often, and means nothing to a
 *   person who hasn't captured anything). The answer is kept in the store's meta, shown on the
 *   diagnostics page, and a "no" makes the sync status line explain the risk.
 * - **Quota.** A write that doesn't fit fails with `QuotaExceededError` (Dexie passes the name
 *   through, or wraps it as the `inner` of an `AbortError`). The store frees the thumbnail cache,
 *   which can always be fetched again, and retries once; if it still doesn't fit, it throws
 *   `StorageFullError` so the capture screen can say so instead of losing the capture silently.
 */

/** The phone has no room for this write, even after the thumbnail cache was emptied. */
export class StorageFullError extends Error {
  constructor(message = 'The phone is out of storage for Kept.') {
    super(message);
    this.name = 'StorageFullError';
  }
}

/** A quota failure, however the engine and Dexie wrapped it. */
export function isQuotaError(e: unknown): boolean {
  for (let x: unknown = e, depth = 0; x && depth < 4; depth++) {
    const err = x as { name?: unknown; code?: unknown; inner?: unknown };
    if (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
    // Old WebKit: a DOMException with the legacy code 22 and no useful name.
    if (err.code === 22 && typeof DOMException !== 'undefined' && x instanceof DOMException)
      return true;
    x = err.inner;
  }
  return false;
}

type StorageManagerLike = {
  persisted?: () => Promise<boolean>;
  persist?: () => Promise<boolean>;
  estimate?: () => Promise<{ usage?: number; quota?: number }>;
};

const storageManager = (): StorageManagerLike | undefined =>
  typeof navigator === 'undefined'
    ? undefined
    : (navigator as Navigator & { storage?: StorageManagerLike }).storage;

/**
 * Asks for persistent storage if it isn't granted yet. Answers true or false, or null where the
 * browser has no Storage API (the answer is then unknown, and nothing is shown).
 */
export async function requestPersistence(): Promise<boolean | null> {
  const s = storageManager();
  if (!s?.persist) return null;
  try {
    if (s.persisted && (await s.persisted())) return true;
    return await s.persist();
  } catch {
    return null;
  }
}

/** How much the origin uses and may use, for the diagnostics page; null when unknown. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  const s = storageManager();
  if (!s?.estimate) return null;
  try {
    const { usage, quota } = await s.estimate();
    return usage === undefined || quota === undefined ? null : { usage, quota };
  } catch {
    return null;
  }
}
