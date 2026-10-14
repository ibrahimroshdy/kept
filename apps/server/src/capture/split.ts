import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { newId } from '@kept/shared';
import sharp from 'sharp';
import type { ImageInput } from '../ai/call.js';
import type { Pools } from '../db/pools.js';
import { type Scope, withScope } from '../db/scope.js';
import type { ThingFields } from '../extraction/checks.js';
import { ingestFile } from '../files/ingest.js';
import type { FileStorage } from '../storage/blob-store.js';
import { ImageLimiter } from '../storage/derivatives.js';
import { insertThing } from '../things/service.js';
import { attachFiles, openInboxItem } from './service.js';

// Several things in one photo (1.4, D20, D230). With multi-item photos on (Admin → Settings, off
// by default until the evaluation set shows a provider's boxes are right, D129, V2), a THING
// capture's extraction may name up to 12 objects, each with its box. The first is the capture's
// own thing, filled in as always (apply.ts), and keeps the whole photo. Each other one becomes a
// new draft beside it: the same place or box, the same capture batch (so the inbox shows them
// together), its own picture cut from the image the model saw, its name and keywords from the
// model, and its own inbox item to confirm, merge (D36) or discard. No second AI call is made.
// Runs after the extraction's transaction commits, as the receipt's re-crop does (job.ts): a
// split that fails leaves the first thing as it is, and is logged.

export const MULTI_ITEM_KEY = 'ai_multi_item';

/** Whether this instance finds several things in a THING photo (D230); read as kept_system. */
export async function multiItemOn(pools: Pick<Pools, 'system'>): Promise<boolean> {
  const { rows } = await pools.system.query<{ value: unknown }>(
    'SELECT value FROM public.instance_settings WHERE key = $1',
    [MULTI_ITEM_KEY],
  );
  return rows[0]?.value === true;
}

/** One more object found in the photo: its box (fractions of the image) and checked fields. */
export type ExtraObject = { bbox: [number, number, number, number]; fields: ThingFields };

/** The smallest crop worth a draft, in pixels a side. */
const MIN_SIDE = 24;

/** The pixel rectangle of a box on an image, inside it; null when too small to keep. */
export function cropBox(
  bbox: ExtraObject['bbox'],
  width: number,
  height: number,
): { left: number; top: number; width: number; height: number } | null {
  const [x, y, w, h] = bbox.map((n) => Math.min(1, Math.max(0, n))) as ExtraObject['bbox'];
  const left = Math.floor(x * width);
  const top = Math.floor(y * height);
  const right = Math.min(width, Math.ceil((x + w) * width));
  const bottom = Math.min(height, Math.ceil((y + h) * height));
  const box = { left, top, width: right - left, height: bottom - top };
  return box.width >= MIN_SIDE && box.height >= MIN_SIDE ? box : null;
}

export type SplitDeps = {
  pools: Pick<Pools, 'app' | 'system'>;
  files: FileStorage | null;
  log: { error: (obj: object, msg: string) => void };
};

/** Makes a draft for each extra object. Answers the new things' ids. */
export async function splitDrafts(
  deps: SplitDeps,
  scope: Scope,
  ex: { id: string; location_id: string; thing_id: string },
  extras: readonly ExtraObject[],
  image: ImageInput,
): Promise<string[]> {
  const files = deps.files;
  if (!files || extras.length === 0) return [];
  const first = await withScope(deps.pools.app, scope, async (_tx, c) => {
    const { rows } = await c.query<{
      place_id: string | null;
      container_id: string | null;
      capture_batch_id: string | null;
    }>(
      `SELECT place_id, container_id, capture_batch_id FROM public.things
        WHERE id = $1 AND deleted_at IS NULL`,
      [ex.thing_id],
    );
    return rows[0] ?? null;
  });
  if (!first?.capture_batch_id) return [];
  const batchId = first.capture_batch_id;
  const limiter = new ImageLimiter(Math.max(1, files.imageConcurrency));
  await mkdir(files.tmpDir, { recursive: true });
  const dir = await mkdtemp(path.join(files.tmpDir, 'split-'));
  const made: string[] = [];
  try {
    for (const extra of extras) {
      const name = extra.fields.name?.value;
      const box = cropBox(extra.bbox, image.width, image.height);
      if (!name || !box) continue;
      try {
        const bytes = await sharp(image.bytes).extract(box).jpeg({ quality: 85 }).toBuffer();
        const tmp = path.join(dir, `${newId()}.jpg`);
        await writeFile(tmp, bytes);
        const upload = await ingestFile(
          { pools: deps.pools, files, limiter, log: deps.log },
          scope,
          {
            file: tmp,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            bytes: bytes.length,
            fileId: newId(),
            locationId: ex.location_id,
            class: 'photo',
          },
          { requestId: null },
        );
        const id = await withScope(deps.pools.app, scope, async (tx, client) => {
          const thingId = await insertThing(
            { tx, client, scope, requestId: `split-${ex.id}`.slice(0, 64), jobs: null, files },
            {
              id: newId(),
              locationId: ex.location_id,
              ...(first.container_id
                ? { containerId: first.container_id }
                : { placeId: first.place_id as string }),
              name,
              ...(extra.fields.quantity && extra.fields.quantity.value > 1
                ? { quantity: extra.fields.quantity.value }
                : {}),
              ...(Object.keys(extra.fields.aliases).length > 0
                ? { aliases: extra.fields.aliases }
                : {}),
            },
            {
              draft: true,
              captureBatchId: batchId,
              fieldStatus: {
                name: {
                  state: 'extracted',
                  confidence: extra.fields.name?.confidence ?? 0,
                  extraction_id: ex.id,
                },
              },
              idChecked: true,
              audit: {
                action: 'thing.capture',
                after: { mode: 'thing', batch_id: batchId, split_from: ex.thing_id },
              },
            },
          );
          await attachFiles(client, ex.location_id, { thingId }, 'photo', [upload.body.id]);
          await openInboxItem(client, {
            locationId: ex.location_id,
            kind: 'draft',
            thingId,
            batchId,
          });
          return thingId;
        });
        made.push(id);
      } catch (err) {
        deps.log.error({ err, extractionId: ex.id }, 'a found object could not become a draft');
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return made;
}
