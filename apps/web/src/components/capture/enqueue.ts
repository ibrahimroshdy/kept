/**
 * Every capture takes the same path (plan T25 "Every capture"; D17, D34, D140, D175): one
 * `create_thing` op in the phone's queue, with its files, whether it came from the shutter, the
 * system camera, the gallery or a share. The store shows it at once where it was captured ("ID
 * pending", D112), and the sync engine (T24) uploads the files and sends the op when online.
 *
 * - `clientId` is a fresh UUIDv7 and doubles as the thing's id; `idempotencyKey = 'cap:' + id`.
 * - One `batchId` per camera session (or per gallery import or share): the inbox groups by it,
 *   and "Undo this batch" undoes it.
 * - "+ photo to this thing" sets `attachToThingId` (or, in RECEIPT mode, `pageOf`), and depends
 *   on that capture's op when it is still in the queue, so it never outruns it.
 */
import { type AttachmentRole, type CaptureMode, newId, type QueueItem } from '@kept/shared';
import { type CapturedImage, type Decode, fromFile, toLocalBlobs } from '@/camera/image';
import type { LocalBlob, OfflineStore, SharedInto } from '@/offline/store';

/** Where a capture lands. `placeId` null with no container: the location's Unplaced area. */
export type Target = {
  locationId: string;
  placeId: string | null;
  containerId: string | null;
};

export const ROLE_BY_MODE: Readonly<Record<CaptureMode, AttachmentRole>> = {
  thing: 'photo',
  receipt: 'receipt',
  label: 'photo',
  reading: 'proof',
};

export type CaptureInput = {
  target: Target;
  batchId: string;
  mode: CaptureMode;
  image: CapturedImage | null;
  /** THING and LABEL: the name typed before the shot. */
  name?: string;
  /** RECEIPT and READING: the note. */
  note?: string;
  attachToThingId?: string;
  /** READING: the meter read (T13: on `attachToThingId`, the thing that has it). */
  meterId?: string;
  pageOf?: string;
  /** Quick add (T19, T30): the template the thing starts from; what was typed wins. */
  templateId?: string;
  /** Idempotency keys of queued ops this one needs (the capture it adds to). */
  dependsOn?: string[];
};

export type Queued = {
  id: string;
  idempotencyKey: string;
  mode: CaptureMode;
  original: LocalBlob | null;
  display: LocalBlob | null;
};

export const captureKey = (id: string) => `cap:${id}`;

function targetOf(t: Target) {
  if (t.containerId) return { containerId: t.containerId };
  if (t.placeId) return { placeId: t.placeId };
  return { unplaced: true as const };
}

export async function enqueueCapture(
  store: OfflineStore,
  input: CaptureInput,
  { now = () => new Date(), ids = newId }: { now?: () => Date; ids?: () => string } = {},
): Promise<Queued> {
  const id = ids();
  const blobs = input.image ? await toLocalBlobs(input.image, ids) : null;
  const name = input.name?.trim();
  const note = input.note?.trim();
  const payload = {
    id,
    target: targetOf(input.target),
    mode: input.mode,
    batchId: input.batchId,
    files: blobs
      ? [
          {
            fileId: blobs.original.id,
            role: ROLE_BY_MODE[input.mode],
            ...(blobs.display ? { displayFileId: blobs.display.id } : {}),
            // Bytes the location already holds make no new file on upload (D177): the server
            // takes the existing one by this hash (T14).
            sha256: blobs.original.sha256,
          },
        ]
      : [],
    ...(name ? { name: name.slice(0, 200) } : {}),
    ...(note ? { note: note.slice(0, 500) } : {}),
    ...(input.attachToThingId ? { attachToThingId: input.attachToThingId } : {}),
    ...(input.meterId ? { meterId: input.meterId } : {}),
    ...(input.pageOf ? { pageOf: input.pageOf } : {}),
    ...(input.templateId ? { templateId: input.templateId } : {}),
  };
  const item: Omit<QueueItem, 'clientVersion' | 'payloadVersion'> = {
    clientId: id,
    idempotencyKey: captureKey(id),
    op: 'create_thing',
    takenAt: now().toISOString(),
    locationId: input.target.locationId,
    ...(input.dependsOn?.length ? { dependsOn: input.dependsOn } : {}),
    payload,
  };
  const list = blobs ? [blobs.original, ...(blobs.display ? [blobs.display] : [])] : [];
  await store.enqueue(item, list);
  return {
    id,
    idempotencyKey: item.idempotencyKey,
    mode: input.mode,
    original: blobs?.original ?? null,
    display: blobs?.display ?? null,
  };
}

/** A PDF can only be a receipt or an invoice: it goes as RECEIPT whatever was chosen. */
export const modeForFile = (type: string, chosen: CaptureMode): CaptureMode =>
  type === 'application/pdf' ? 'receipt' : chosen;

/**
 * Many files, one capture each, in order (gallery import, D140; a share): the same queue path
 * as the shutter. Answers what was queued.
 */
export async function enqueueFiles(
  store: OfflineStore,
  files: readonly { blob: Blob; type: string }[],
  ctx: { target: Target; batchId: string; mode: CaptureMode; decode?: Decode },
): Promise<Queued[]> {
  const out: Queued[] = [];
  for (const f of files) {
    const mode = modeForFile(f.type, ctx.mode);
    const image = await fromFile(f.blob, mode, ctx.decode);
    out.push(
      await enqueueCapture(store, { target: ctx.target, batchId: ctx.batchId, mode, image }),
    );
  }
  return out;
}

/** "Shared into Kept" → captures: RECEIPT or THING, one per file, in the chosen place (D140). */
export function keepShared(
  store: OfflineStore,
  share: SharedInto,
  mode: 'receipt' | 'thing',
  ctx: { target: Target; batchId?: string; decode?: Decode },
): Promise<Queued[]> {
  return enqueueFiles(
    store,
    share.files.map((f) => ({ blob: f.blob, type: f.type || f.blob.type })),
    {
      target: ctx.target,
      batchId: ctx.batchId ?? newId(),
      mode,
      ...(ctx.decode ? { decode: ctx.decode } : {}),
    },
  );
}

/** What "Undo this batch" did: taken back from the queue, and handed to the server's undo. */
export type BatchUndo = { unqueued: number; sentToServer: number };

/**
 * "Undo this batch" (screens §8): captures the server has never seen leave the phone's queue;
 * the rest are undone by `captures/batches/:id/undo` (unreviewed drafts go to the trash).
 */
export async function undoBatch(
  store: OfflineStore,
  batchId: string,
  keys: readonly string[],
  serverUndo: (batchId: string) => Promise<unknown>,
): Promise<BatchUndo> {
  const removed = await store.unqueue([...keys]);
  const rest = keys.length - removed.length;
  if (rest > 0) await serverUndo(batchId);
  return { unqueued: removed.length, sentToServer: rest };
}
