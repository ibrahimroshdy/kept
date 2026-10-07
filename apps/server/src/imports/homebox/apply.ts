import { newId, normalize } from '@kept/shared';
import type pg from 'pg';
import type { Scope, Tx } from '../../db/scope.js';
import { createAttachment } from '../../files/attachments.js';
import { AppError } from '../../http/errors.js';
import type { JobQueue } from '../../jobs/queue.js';
import { createPlace } from '../../places/service.js';
import { createItem } from '../../registries/service.js';
import { createSchedule } from '../../schedules/service.js';
import { createService } from '../../schedules/services.js';
import { gateFor } from '../../serialize/gates.js';
import type { FileStorage } from '../../storage/blob-store.js';
import { createTemplate } from '../../templates/service.js';
import { insertThing, setLifecycle } from '../../things/service.js';
import { createType, createTypeField, customiseType } from '../../types/service.js';
import { createWarranty } from '../../warranties/service.js';
import type { HbLookups } from './lookups.js';
import type { HbOp, NameRef, Ref, ThingOp } from './plan.js';

// Applying one planned Homebox step (step-7 plan T10) through the step-2 services, as a request
// would: each writes its own audit row as the importing person, and `created_via = 'import'` on
// things. Every step remembers what it made in import_source_ids (source `homebox`) under its
// key, in the same transaction, so a resumed or re-run import never makes it twice. The job
// (job.ts) wraps each step in a savepoint and reports one that fails.

export type ApplyCtx = {
  tx: Tx;
  client: pg.PoolClient;
  scope: Scope;
  requestId: string;
  runId: string;
  locationId: string;
  /** manifest.groupId: the legacy codes' collection (plan Q4). */
  collection: string;
  look: HbLookups;
  files: FileStorage | null;
  jobs: JobQueue | null;
  /** Source id → what it became: earlier runs' (import_source_ids) and this run's. */
  ids: Map<string, string>;
  /** An attachment's key → the file its bytes became (ingested before the transaction). */
  fileIds: Map<string, string>;
  /** Brands and vendors made by name in this run. */
  made: { brands: Map<string, string>; vendors: Map<string, string> };
};

/** What one step made, for the chunk's audit event. */
export type Applied = { thingId?: string };

/** A step whose target an earlier step didn't make (it failed): reported, not applied. */
export class MissingRef extends Error {
  constructor(readonly key: string) {
    super(`import: ${key} wasn't made`);
    this.name = 'MissingRef';
  }
}

export function resolve(c: ApplyCtx, ref: Ref): string {
  if ('id' in ref) return ref.id;
  const id = c.ids.get(ref.key);
  if (!id) throw new MissingRef(ref.key);
  return id;
}

async function remember(
  c: ApplyCtx,
  key: string,
  entityType: string,
  entityId: string,
): Promise<void> {
  await c.client.query(
    `INSERT INTO public.import_source_ids (location_id, source, source_id, entity_type, entity_id,
                                           run_id)
     VALUES ($1, 'homebox', $2, $3, $4, $5)
     ON CONFLICT (location_id, source, source_id) DO NOTHING`,
    [c.locationId, key, entityType, entityId, c.runId],
  );
  c.ids.set(key, entityId);
}

const writeCtx = (c: ApplyCtx) => ({
  tx: c.tx,
  client: c.client,
  userId: c.scope.userId,
  requestId: c.requestId,
  jobs: c.jobs,
});

/** A brand, vendor or tag by name, made the first time (a name taken since is reused). */
async function ensureNamed(
  c: ApplyCtx,
  kind: 'brands' | 'vendors' | 'tags',
  ref: NameRef | null,
  extra: Record<string, unknown> = {},
): Promise<string | undefined> {
  if (!ref) return undefined;
  if ('id' in ref) return ref.id;
  const norm = normalize(ref.create);
  const cache = kind === 'brands' ? c.made.brands : kind === 'vendors' ? c.made.vendors : null;
  const known = cache?.get(norm);
  if (known) return known;
  let id: string;
  try {
    const made = await createItem(writeCtx(c), kind, c.look.accountId, {
      name: ref.create,
      ...extra,
    });
    id = made.item.id;
  } catch (err) {
    const existing = err instanceof AppError ? err.extra?.existingId : undefined;
    if (typeof existing !== 'string') throw err;
    id = existing;
  }
  cache?.set(norm, id);
  return id;
}

async function codes(
  c: ApplyCtx,
  list: readonly string[],
  target: { thingId: string } | { placeId: string },
): Promise<void> {
  for (const code of list) {
    await c.client.query(
      `INSERT INTO public.legacy_codes (location_id, source, source_collection, code, thing_id,
                                        place_id)
       VALUES ($1, 'homebox', $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [
        c.locationId,
        c.collection,
        code,
        'thingId' in target ? target.thingId : null,
        'placeId' in target ? target.placeId : null,
      ],
    );
  }
}

async function applyThing(c: ApplyCtx, op: ThingOp): Promise<string> {
  const where =
    'place' in op.where
      ? { placeId: resolve(c, op.where.place) }
      : { containerId: resolve(c, op.where.container) };
  const typeId = op.type ? resolve(c, op.type) : undefined;
  const brandId = await ensureNamed(c, 'brands', op.brand);
  const tagIds: string[] = [];
  for (const t of op.tags) {
    const id = 'id' in t ? t.id : c.ids.get(t.key);
    if (id && !tagIds.includes(id)) tagIds.push(id);
  }
  const vendorId = op.purchase ? await ensureNamed(c, 'vendors', op.purchase.vendor) : undefined;
  const ctx = {
    tx: c.tx,
    client: c.client,
    scope: c.scope,
    requestId: c.requestId,
    jobs: c.jobs,
    files: null,
  };
  const thingId = await insertThing(
    ctx,
    {
      locationId: c.locationId,
      ...where,
      name: op.name,
      quantity: op.quantity,
      ...(typeId ? { typeId } : {}),
      ...(brandId ? { brandId } : {}),
      ...(op.model ? { model: op.model } : {}),
      ...(op.serial ? { serial: op.serial } : {}),
      ...(op.notes ? { notes: op.notes } : {}),
      ...(tagIds.length > 0 ? { tagIds } : {}),
      ...(Object.keys(op.custom).length > 0 ? { custom: op.custom } : {}),
      ...(op.purchase
        ? {
            purchase: {
              purchasedOn: op.purchase.purchasedOn,
              currency: op.purchase.currency,
              price: op.purchase.price,
              ...(vendorId ? { vendorId } : {}),
            },
          }
        : {}),
    },
    { createdVia: 'import' },
  );
  if (op.purchase) {
    const { rows } = await c.client.query<{ purchase_id: string }>(
      `SELECT pl.purchase_id FROM public.things t
         JOIN public.purchase_lines pl ON pl.id = t.purchase_line_id
        WHERE t.id = $1`,
      [thingId],
    );
    const purchaseId = rows[0]?.purchase_id;
    if (purchaseId) await remember(c, op.purchase.key, 'purchase', purchaseId);
  }
  if (op.sold) {
    const { rows } = await c.client.query<{ row_version: number }>(
      'SELECT row_version FROM public.things WHERE id = $1',
      [thingId],
    );
    await setLifecycle(ctx, thingId, rows[0]?.row_version ?? 1, {
      lifecycle: 'sold',
      ...op.sold,
    });
  }
  await codes(c, op.codes, { thingId });
  await remember(c, op.key, 'thing', thingId);
  return thingId;
}

/** Applies one step; throws when a service refuses it (the caller rolls the step back). */
export async function applyOp(c: ApplyCtx, op: HbOp): Promise<Applied> {
  switch (op.op) {
    case 'type': {
      let typeId: string;
      if ('id' in op.target) {
        typeId = op.target.id;
        if (op.customise) {
          typeId = (await customiseType(writeCtx(c), typeId, c.look.accountId)).typeId;
        }
      } else {
        const made = await createType(writeCtx(c), c.look.accountId, {
          parentId: null,
          name: op.target.create.name,
          icon: op.target.create.icon,
          capabilities: op.container ? ['container'] : [],
        });
        typeId = made.id;
      }
      for (const f of op.fields) {
        try {
          const made = await createTypeField(writeCtx(c), typeId, {
            key: f.key,
            label: f.label,
            kind: f.kind as 'text',
          });
          await remember(c, f.sourceKey, 'type_field', made.id);
        } catch (err) {
          // The key is the type's already (a field an earlier run added): use it as it is.
          if (!(err instanceof AppError) || err.status !== 409) throw err;
        }
      }
      await remember(c, op.key, 'type', typeId);
      // A customised copy is what this run's things use, whatever an earlier run recorded.
      c.ids.set(op.key, typeId);
      return {};
    }
    case 'tag': {
      const id =
        'id' in op.target
          ? op.target.id
          : await ensureNamed(
              c,
              'tags',
              { create: op.target.create.name },
              {
                colour: op.target.create.colour,
              },
            );
      await remember(c, op.key, 'tag', id as string);
      return {};
    }
    case 'place': {
      let placeId = op.existingId;
      if (!placeId) {
        const parentId = op.parent ? resolve(c, op.parent) : null;
        const made = await createPlace(
          { tx: c.tx, client: c.client, scope: c.scope, jobs: c.jobs, requestId: c.requestId },
          c.locationId,
          { parentId, name: op.name, kindKey: parentId === null ? 'room' : 'zone' },
        );
        placeId = made.id;
      }
      await codes(c, op.codes, { placeId });
      await remember(c, op.key, 'place', placeId);
      return {};
    }
    case 'thing':
      return { thingId: await applyThing(c, op) };
    case 'warranty': {
      const thingId = resolve(c, op.thing);
      const made = await createWarranty(
        { tx: c.tx, client: c.client, scope: c.scope, requestId: c.requestId, files: c.files },
        thingId,
        op.body,
      );
      await remember(c, op.key, 'warranty', made.id);
      return {};
    }
    case 'attachment': {
      const ownerKey = 'thing' in op.owner ? op.owner.thing : op.owner.place;
      const ownerId = resolve(c, ownerKey);
      const ownerSubject = 'thing' in op.owner ? { thingId: ownerId } : { placeId: ownerId };
      const base = 'key' in ownerKey ? ownerKey.key : '';
      const warrantyId = op.subject === 'warranty' ? c.ids.get(`${base}:warranty`) : undefined;
      const purchaseId = op.subject === 'purchase' ? c.ids.get(`${base}:purchase`) : undefined;
      const subject = warrantyId ? { warrantyId } : purchaseId ? { purchaseId } : ownerSubject;
      const fileId = op.file ? c.fileIds.get(op.key) : undefined;
      if (op.file && !fileId) throw new MissingRef(op.key);
      const id = newId();
      await createAttachment(
        c.tx,
        c.client,
        c.files,
        (loc) => gateFor(c.tx, loc, c.scope),
        c.scope.userId,
        {
          id,
          locationId: c.locationId,
          ...(fileId ? { fileId } : {}),
          ...(op.url ? { url: op.url } : {}),
          subject,
          // A warranty's or purchase's own document keeps its role; on the thing itself a
          // receipt with nowhere better to go is still a receipt.
          role: op.role,
          sort: op.sort,
        },
        c.requestId,
      );
      await remember(c, op.key, 'attachment', id);
      return {};
    }
    case 'service': {
      const owner = 'thing' in op.owner ? op.owner.thing : op.owner.place;
      const ownerId = resolve(c, owner);
      const made = await createService(
        {
          tx: c.tx,
          client: c.client,
          scope: c.scope,
          requestId: c.requestId,
          files: c.files,
          jobs: c.jobs,
        },
        {
          subject: 'thing' in op.owner ? { thingId: ownerId } : { placeId: ownerId },
          servicedOn: op.servicedOn,
          notes: op.notes,
          ...(op.total && op.currency ? { total: op.total, currency: op.currency } : {}),
        },
      );
      await remember(c, op.key, 'service_record', made.id);
      return {};
    }
    case 'schedule': {
      const owner = 'thing' in op.owner ? op.owner.thing : op.owner.place;
      const ownerId = resolve(c, owner);
      const made = await createSchedule(
        {
          tx: c.tx,
          client: c.client,
          scope: c.scope,
          requestId: c.requestId,
          files: c.files,
          jobs: c.jobs,
        },
        {
          subject: 'thing' in op.owner ? { thingId: ownerId } : { placeId: ownerId },
          name: op.name,
          dueOn: op.dueOn,
        },
      );
      await remember(c, op.key, 'schedule', made.id);
      return {};
    }
    case 'template': {
      const brandId = await ensureNamed(c, 'brands', op.payload.brand);
      const tagIds = op.payload.tags
        .map((t) => ('id' in t ? t.id : c.ids.get(t.key)))
        .filter((x): x is string => !!x);
      const made = await createTemplate(writeCtx(c), c.look.accountId, {
        name: op.name,
        payload: {
          ...(op.payload.name ? { name: op.payload.name } : {}),
          ...(op.payload.model ? { model: op.payload.model } : {}),
          ...(op.payload.quantity ? { quantity: String(op.payload.quantity) } : {}),
          ...(op.payload.notes ? { notes: op.payload.notes } : {}),
          ...(tagIds.length > 0 ? { tagIds } : {}),
          ...(brandId ? { brandId } : {}),
        },
        locationIds: [c.locationId],
      });
      await remember(c, op.key, 'template', made.id);
      return {};
    }
  }
}
