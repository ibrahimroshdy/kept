import { rm } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { audited } from '../audit/audited.js';
import { requireScope } from '../auth/http.js';
import type { Pools } from '../db/pools.js';
import { withScope } from '../db/scope.js';
import { deleteUnreferencedBlobs } from '../files/attachments.js';
import { lockBlobKeys } from '../files/blob-locks.js';
import { declaredLength, imagesBusy, receive } from '../files/upload.js';
import {
  derivativeKeys,
  FILE_COLUMNS,
  type FileRow,
  type FileView,
  fileViewOf,
} from '../files/views.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../http/errors.js';
import { derivativeKey, type FileStorage, originalKey } from '../storage/blob-store.js';
import {
  type Derived,
  derivativeTempPaths,
  derive,
  ImageBusyError,
  type ImageLimiter,
} from '../storage/derivatives.js';
import { sniff } from '../storage/sniff.js';

// PUT /api/v1/files/:fileId/display (plan T13 "phone derivatives"; D34, D36, D99, D117; step-2
// Q17). The phone makes the display JPEG of an evidence photo (it decodes HEIC, the server can't:
// D99) and sends it here after the original (T24's uploader). The server makes the file's
// display, thumb and share renditions from it, so a HEIC original becomes viewable; the original
// itself is never touched (D117).
//
// In order:
// 1. who and what: the file's own uploader (someone else who can see it: 403), while the file is
//    under 24 hours old (409), an image (415 otherwise), with X-Kept-Sha256 of the body; filed
//    already or not;
// 2. a replay of the same bytes (the last `file.display_set` of this file names the same SHA-256)
//    answers the file as it is (200);
// 3. the body is streamed to temp and hashed (400 `checksum_mismatch`), must sniff as a JPEG
//    (415), and is resized through the image limiter with the pixel limit, upright and without
//    metadata (storage/derivatives.ts): display 2048, share 1200, thumb 400;
// 4. the renditions are stored under the file's derivative keys before any transaction (review
//    #16), replacing what was there;
// 5. one transaction, under the keys' advisory locks: kept.set_file_display() (0042) replaces
//    the derivative rows and sets the file's `derivative_state = 'ready'`, and `file.display_set`
//    is audited (the hash and sizes, never content).
//
// kept_app may not UPDATE `files` (append-only, 0020), hence the definer. It works whether or not
// the file is attached yet, so a capture op that filed the photo before its display arrived (T24)
// still gets its preview; the phone leaves "preview unavailable" (D36) for any refusal.

const SHA256 = /^[0-9a-f]{64}$/;
/** How long after the upload its display may still be set. */
export const DISPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DisplayDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  files: FileStorage;
  limiter: ImageLimiter;
  log: { error: (obj: object, msg: string) => void };
};

type Found = FileRow & { created_at: Date; attached: boolean };

async function readFile(client: pg.ClientBase, fileId: string): Promise<Found | null> {
  const { rows } = await client.query<Found>(
    `SELECT ${FILE_COLUMNS}, f.created_at,
            EXISTS (SELECT 1 FROM public.attachments a WHERE a.file_id = f.id) AS attached
       FROM public.files f WHERE f.id = $1`,
    [fileId],
  );
  return rows[0] ?? null;
}

/** The SHA-256 the file's last phone display had, or null. */
async function lastDisplaySha(client: pg.ClientBase, file: Found): Promise<string | null> {
  const { rows } = await client.query<{ sha: string | null }>(
    `SELECT e.diff->'sha256'->>'after' AS sha FROM public.audit_events e
      WHERE e.location_id = $1 AND e.entity_type = 'file' AND e.entity_id = $2
        AND e.action = 'file.display_set'
      ORDER BY e.at DESC, e.id DESC LIMIT 1`,
    [file.location_id, file.id],
  );
  return rows[0]?.sha ?? null;
}

async function viewOf(client: pg.ClientBase, files: FileStorage, row: FileRow): Promise<FileView> {
  return fileViewOf(files, row, await derivativeKeys(client, [row.id]));
}

/** Checks 1 and 2: the file the caller may set a display for, or the replay's answer. */
function check(file: Found | null, userId: string, now = Date.now()): Found {
  if (!file) throw notFound();
  if (file.created_by !== userId) {
    throw forbidden('Only the person who added this photo can set its preview.');
  }
  if (!file.mime.startsWith('image/')) {
    throw new AppError('unsupported_media_type', 415, 'Only a photo has a preview.');
  }
  if (now - new Date(file.created_at).getTime() > DISPLAY_WINDOW_MS) {
    throw conflict("This photo's preview can only be set in the first 24 hours.");
  }
  return file;
}

export async function setDisplay(
  deps: DisplayDeps,
  req: FastifyRequest,
  body: Readable,
  fileId: string,
): Promise<{ status: 200; body: FileView }> {
  const scope = requireScope(req);
  const { pools, files, limiter, log } = deps;
  const raw = req.headers['x-kept-sha256'];
  const declared = (Array.isArray(raw) ? raw[0] : raw)?.trim().toLowerCase();
  if (!declared || !SHA256.test(declared)) {
    throw invalid('Send X-Kept-Sha256: the SHA-256 of the JPEG, in hex.');
  }
  declaredLength(req, files.maxFileBytes);

  const early = await withScope(pools.app, scope, async (_tx, client) => {
    const file = check(await readFile(client, fileId), scope.userId);
    if ((await lastDisplaySha(client, file)) === declared) {
      return viewOf(client, files, file);
    }
    return null;
  });
  if (early) {
    body.resume();
    return { status: 200, body: early };
  }

  if (limiter.full) throw imagesBusy();
  const received = await receive(body, files.tmpDir, files.maxFileBytes);
  const temps = [received.file, ...derivativeTempPaths(received.file)];
  const stored: string[] = [];
  try {
    if (received.sha256 !== declared) {
      throw new AppError(
        'checksum_mismatch',
        400,
        "The bytes that arrived don't match X-Kept-Sha256. Send the preview again.",
      );
    }
    const sniffed = await sniff(received.file);
    if (sniffed.mime !== 'image/jpeg') {
      throw new AppError('unsupported_media_type', 415, 'Send the preview as a JPEG.');
    }
    let derived: Derived;
    try {
      derived = await limiter.run(() => derive(received.file, sniffed));
    } catch (err) {
      if (err instanceof ImageBusyError) throw imagesBusy();
      throw err;
    }
    if (derived.state !== 'ready') {
      throw new AppError('unsupported_media_type', 415, "This JPEG can't be read.");
    }
    for (const v of derived.variants) {
      const key = derivativeKey(fileId, v.variant);
      if (!stored.includes(key)) stored.push(key);
      await files.blobs.put(key, v.path, { contentType: 'image/jpeg', bytes: v.bytes });
    }

    return await withScope(pools.app, scope, async (tx, client) => {
      const file = check(await readFile(client, fileId), scope.userId);
      await lockBlobKeys(client, [originalKey(file.location_id, file.id), ...stored]);
      await client.query('SELECT kept.set_file_display($1, $2)', [
        fileId,
        JSON.stringify(
          derived.variants.map((v) => ({
            variant: v.variant,
            width: v.width,
            height: v.height,
            bytes: v.bytes,
          })),
        ),
      ]);
      const row = (await readFile(client, fileId)) as FileRow;
      await audited(tx, {
        locationId: row.location_id,
        actor: { type: 'user', id: scope.userId },
        action: 'file.display_set',
        entity: { type: 'file', id: row.id },
        before: { derivative_state: file.derivative_state, sha256: null },
        after: {
          derivative_state: 'ready',
          sha256: received.sha256,
          bytes: received.bytes,
          variants: derived.variants.map((v) => v.variant),
        },
        requestId: req.id,
      });
      stored.length = 0;
      return { status: 200 as const, body: await viewOf(client, files, row) };
    });
  } catch (err) {
    // Keys no row names (the file had no renditions before): gone again. Keys a row still names
    // keep the phone's rendition, which is the same photo.
    if (stored.length > 0) {
      await deleteUnreferencedBlobs(pools, files, stored, log).catch((e: unknown) => {
        log.error({ err: e }, 'display: its blobs could not be cleaned up');
      });
    }
    throw err;
  } finally {
    await Promise.all(temps.map((t) => rm(t, { force: true })));
  }
}
