/**
 * Uploads a queued op's files before the op is sent (plan T24; engineering spec §7.4; D34, D36,
 * D117). One request per file, with the id the capture chose, so a retry after a dropped
 * connection is a replay the server answers with the same file (`PUT /files/:id`, idempotent on
 * id + SHA-256).
 *
 * - THING mode queues only the shrunk JPEG, as the `original` (D34); no display is needed.
 * - The evidence modes queue the untouched original and a 2048 px `display`, which goes to
 *   `PUT /files/<original>/display` after the original (the phone decodes HEIC, the server can't:
 *   D36). A display the server refuses is skipped, never fatal: the file then shows "preview
 *   unavailable", which is what D36 asks for.
 * - Files are deleted from the phone once their op is answered (DexieStore.settle).
 */
import { isErrorCode, newId } from '@kept/shared';
import { captureApi } from '@/api/capture/queries';
import { ApiError } from '@/api/client';
import { inventoryPaths } from '@/api/inventory/paths';
import type { FileClass } from '@/api/inventory/types';
import { displayParentOf, fileClassFor } from './queue';
import type { LocalBlob, QueueEntry } from './store';
import type { SyncStore } from './sync-store';

/** The file's SHA-256 as 64 lower-case hex characters (`X-Kept-Sha256`). */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A captured file ready to queue: its upload id chosen now, its hash computed now. */
export async function localBlob(
  blob: Blob,
  kind: LocalBlob['kind'],
  id: string = newId(),
): Promise<LocalBlob> {
  return { id, kind, blob, sha256: await sha256Hex(blob) };
}

/** The two upload calls, so tests can fail one on purpose. */
export type UploadHttp = {
  putFile: (
    fileId: string,
    locationId: string,
    cls: FileClass,
    blob: Blob,
    sha256: string,
  ) => Promise<void>;
  putDisplay: (fileId: string, blob: Blob, sha256: string) => Promise<void>;
};

async function errorOf(res: Response): Promise<ApiError> {
  let b: { error?: unknown; code?: unknown; hint?: unknown } = {};
  try {
    b = (await res.json()) as typeof b;
  } catch {
    // Not JSON: the status says enough.
  }
  const code =
    typeof b.code === 'string' && isErrorCode(b.code)
      ? b.code
      : res.status === 401
        ? 'unauthenticated'
        : res.status >= 500
          ? 'internal'
          : 'validation';
  return new ApiError(
    res.status,
    code,
    typeof b.error === 'string' ? b.error : `HTTP ${res.status}`,
  );
}

export const uploadHttp: UploadHttp = {
  async putFile(fileId, locationId, cls, blob, sha256) {
    const url = `${inventoryPaths.file(fileId)}?${new URLSearchParams({ locationId, class: cls })}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'PUT',
        credentials: 'include',
        headers: {
          'content-type': blob.type || 'application/octet-stream',
          'x-kept-sha256': sha256,
          // Browsers set it from the body themselves; the in-memory mock reads it from here.
          'content-length': String(blob.size),
        },
        body: blob,
      });
    } catch {
      throw new ApiError(0, 'offline', 'Needs a connection');
    }
    if (!res.ok) throw await errorOf(res);
  },
  async putDisplay(fileId, blob, sha256) {
    await captureApi.putDisplay(fileId, blob, sha256);
  },
};

/** A failure that another try won't fix: the server looked at the file and said no. */
export function isPermanent(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false;
  if (e.status === 0 || e.status === 401 || e.status === 408 || e.status === 429) return false;
  return e.status >= 400 && e.status < 500;
}

/**
 * Uploads what is left of one entry's files: originals first, then displays. Answers
 * `'uploaded'`, or `'refused'` when the server permanently refused an original (the op can't
 * apply without it). A transient failure (offline, 5xx, 429, 401) is thrown for the engine.
 *
 * A `blocked` entry (client_outdated or server_outdated, D148) keeps its state: its files may go
 * up meanwhile, but only an app start, a new build or the retry unblocks it, never an upload.
 */
export async function uploadEntryFiles(
  store: SyncStore,
  entry: QueueEntry,
  http: UploadHttp = uploadHttp,
): Promise<'uploaded' | 'refused'> {
  const left = (await store.blobsOf(entry.seq)).filter((b) => !b.uploaded);
  if (left.length === 0) return 'uploaded';
  const blocked = entry.state === 'blocked';
  if (!blocked) await store.setState([entry.seq], 'uploading');
  const ordered = [...left].sort(
    (a, b) => Number(a.kind === 'display') - Number(b.kind === 'display'),
  );
  for (const b of ordered) {
    if (b.kind === 'original') {
      try {
        await http.putFile(b.id, entry.locationId, fileClassFor(entry), b.blob, b.sha256);
      } catch (e) {
        if (isPermanent(e)) return 'refused';
        throw e;
      }
    } else {
      const parent = displayParentOf(entry, b.id);
      if (parent) {
        try {
          await http.putDisplay(parent, b.blob, b.sha256);
        } catch (e) {
          if (!isPermanent(e)) throw e;
          // Refused (too old, not an image…): "preview unavailable" on the server (D36).
        }
      }
    }
    await store.markUploaded(b.id);
  }
  if (!blocked) await store.setState([entry.seq], 'pending');
  return 'uploaded';
}
