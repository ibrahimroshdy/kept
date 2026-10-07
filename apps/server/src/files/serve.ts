import type { FastifyReply } from 'fastify';
import type pg from 'pg';
import { forbidden, notFound } from '../http/errors.js';
import { requireMembership } from '../locations/access.js';
import type { Gate } from '../serialize/gates.js';
import { BlobNotFoundError, type FileStorage } from '../storage/blob-store.js';
import { contentDisposition } from '../storage/disposition.js';
import {
  FILE_COLUMNS,
  type FileRow,
  type FileVariant,
  isMoneyRole,
  type SignedFileUrl,
  signFile,
} from './views.js';

// Serving files (D117, D157; plan Q16).
//
// A file never leaves through a session-bearing route. The app hands out a five-minute signed URL
// (POST /api/v1/files/:id/url), and the bytes come from `/f/<token>` (local storage), a route
// that reads no session and trusts only the token's HMAC, or from a presigned S3 URL. Either way
// the response is marked so a browser can't run it: `nosniff`, a CSP of `default-src 'none';
// sandbox`, and `attachment` for anything that isn't one of our re-encoded JPEGs.
//
// Who may have which URL:
// - a derivative (display, thumb, share): anyone who can see the file, i.e. its attachment (or
//   its uploader before it is attached; §7.2, D177);
// - the original: a member or above in the file's location (D117);
// - a thing's receipt after a move (`?thingId=`, D115): kept.thing_receipt_file(), which serves
//   the original to a member or above of the thing's location even when the purchase stayed in a
//   location the caller can't see.
// Receipts and invoices are money (security review #10): a file whose every attachment the caller
// can see is a receipt or an invoice is a 404 while the caller's gate hides money there, and so is
// a receipt reached through `?thingId=` while the gate of the thing's location does. A file that
// is also attached as something else (a photo of the same paper) is served as that.

const WRITERS = new Set(['owner', 'admin', 'member']);

/** The URL for one rendition of a file, as the caller may have it. */
export async function fileUrl(
  client: pg.ClientBase,
  files: FileStorage,
  gateOf: (locationId: string) => Promise<Gate>,
  fileId: string,
  variant: FileVariant,
  thingId: string | undefined,
): Promise<SignedFileUrl> {
  const { rows } = await client.query<FileRow>(
    `SELECT ${FILE_COLUMNS} FROM public.files f WHERE f.id = $1`,
    [fileId],
  );
  const row = rows[0];

  if (!row) {
    // Not visible directly: only a thing's receipt can still be reached, and only its original.
    if (!thingId || variant !== 'original') throw notFound();
    const { rows: thing } = await client.query<{ location_id: string }>(
      'SELECT location_id FROM public.things WHERE id = $1',
      [thingId],
    );
    const at = thing[0]?.location_id;
    if (!at || !(await gateOf(at)).showMoney) throw notFound();
    const { rows: receipt } = await client.query<{ storage_key: string; mime: string }>(
      'SELECT storage_key, mime FROM kept.thing_receipt_file($1, $2)',
      [thingId, fileId],
    );
    const r = receipt[0];
    if (!r) throw notFound();
    return signFile(files, r.storage_key, fileId, r.mime, 'original');
  }

  const { rows: roles } = await client.query<{ role: string }>(
    'SELECT DISTINCT role FROM public.attachments WHERE file_id = $1',
    [row.id],
  );
  const onlyMoney = roles.length > 0 && roles.every((r) => isMoneyRole(r.role));
  if (onlyMoney && !(await gateOf(row.location_id)).showMoney) throw notFound();

  if (variant === 'original') {
    const me = await requireMembership(client, row.location_id);
    if (!WRITERS.has(me.role)) {
      throw forbidden('Originals are for members and above. Viewers see the previews.');
    }
    return signFile(files, row.storage_key, row.id, row.mime, 'original');
  }

  const { rows: derived } = await client.query<{ storage_key: string }>(
    'SELECT storage_key FROM public.file_derivatives WHERE file_id = $1 AND variant = $2',
    [row.id, variant],
  );
  const key = derived[0]?.storage_key;
  // No preview (HEIC, a PDF): the view's null thumbUrl already said so.
  if (!key) throw notFound('This file has no preview.');
  return signFile(files, key, row.id, row.mime, variant);
}

/** D157's headers for anything served from `/f/`. */
export const FILE_CSP = "default-src 'none'; sandbox";

/** GET /f/:token: the bytes a valid token names, or 404 for anything else. */
export async function serveToken(
  files: FileStorage,
  token: string,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const signed = files.signer.verify(token);
  if (!signed) throw notFound();
  let body: import('node:stream').Readable;
  try {
    body = await files.blobs.stream(signed.key);
  } catch (err) {
    if (err instanceof BlobNotFoundError) throw notFound();
    throw err;
  }
  // A cached copy lives no longer than the URL that fetched it.
  const left = Math.max(0, signed.expiresAt - Math.floor(Date.now() / 1000));
  return reply
    .header('content-type', signed.contentType)
    .header('content-disposition', contentDisposition(signed.disposition, signed.filename))
    .header('x-content-type-options', 'nosniff')
    .header('content-security-policy', FILE_CSP)
    .header('cache-control', `private, max-age=${left}`)
    .header('referrer-policy', 'no-referrer')
    .send(body);
}
