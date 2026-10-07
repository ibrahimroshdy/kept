/**
 * Mock handlers for the online capture path (T13) and extraction (T10): POST /captures, the
 * phone-made display image, capture batches and their undo, and re-extraction. Like the server,
 * a capture with no name is a draft and opens an inbox `draft` item; AI capture queues an
 * extraction (it stays paused where AI is paused).
 */
import { SHORT_CODE } from '@kept/shared';
import {
  accessOf,
  liveThing,
  newId,
  now,
  paginate,
  placePath,
  recordEvent,
  rowOf,
  type StoredThing,
} from '../../inventory/mock/db';
import { contentsTemplate } from '../../inventory/mock/places';
import type { MockState } from '../../mock/fixtures';
import {
  err,
  forbidden,
  type MockRoute,
  notFound,
  reply,
  route,
  sessionGate,
} from '../../mock/kit';
import { capturePaths as p } from '../paths';
import type {
  CaptureBatch,
  CaptureResult,
  CreateCaptureBody,
  ExtractBody,
  ExtractionAttempt,
} from '../types';
import type { StoredBatch } from './state';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A fresh six-character code the fixtures don't use (D112: allocated at sync, online now). */
export function allocateCode(taken: (code: string) => boolean): string {
  for (let n = 1; ; n++) {
    let code = '';
    let x = n * 104_729 + 7919;
    for (let i = 0; i < 6; i++) {
      code += CROCKFORD[x % 32];
      x = Math.floor(x / 32) + i * 17 + n;
    }
    if (SHORT_CODE.test(code) && !taken(code)) return code;
  }
}

export function captureRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const cap = () => state.capture;
  const access = () => accessOf(state);
  const me = () => ({ id: state.me.user.id, displayName: state.me.user.displayName });
  const codeTaken = (code: string) =>
    inv().things.some((t) => t.shortCode === code) || cap().codes.some((c) => c.code === code);

  const batchOf = (b: StoredBatch): CaptureBatch => {
    const things = b.thingIds.map((id) => liveThing(inv(), id)).filter((t) => t !== undefined);
    return {
      batchId: b.batchId,
      locationId: b.locationId,
      placePath: placePath(inv(), b.placeId),
      capturedAt: b.capturedAt,
      count: things.length,
      drafts: things.filter((t) => t.reviewState === 'draft').length,
      byMe: b.createdById === state.me.user.id,
    };
  };

  /** Where the capture lands; null when the target isn't visible (a 404, like the server). */
  const resolveTarget = (
    b: CreateCaptureBody,
  ): { placeId: string | null; containerId: string | null } | null => {
    if ('unplaced' in b.target) {
      const un = inv().places.find((x) => x.locationId === b.locationId && x.isUnplaced);
      return un ? { placeId: un.id, containerId: null } : null;
    }
    if ('placeId' in b.target) {
      const placeId = b.target.placeId;
      const pl = inv().places.find((x) => x.id === placeId && !x.deletedAt);
      return pl && pl.locationId === b.locationId ? { placeId: pl.id, containerId: null } : null;
    }
    const box = liveThing(inv(), b.target.containerId);
    return box && box.locationId === b.locationId ? { placeId: null, containerId: box.id } : null;
  };

  return [
    route('POST', p.captures, ({ body, headers }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as CreateCaptureBody;
      if (!headers['idempotency-key'])
        return err(400, 'validation', 'An Idempotency-Key header is required.');
      if (!access().visible(b.locationId)) return notFound();
      if (!access().canWrite(b.locationId)) return forbidden();
      const name = b.name?.trim();
      // D19: at least one file or a name.
      if (!name && b.files.length === 0)
        return err(400, 'validation', 'A capture needs a photo or a name.');
      const where = resolveTarget(b);
      if (!where) return notFound();
      const ai = cap().aiStatus[b.locationId];
      const result: CaptureResult = {};

      if (b.attachToThingId) {
        const t = liveThing(inv(), b.attachToThingId);
        if (!t || t.locationId !== b.locationId) return notFound();
        result.thing = rowOf(inv(), t);
      } else if (b.mode === 'thing' || b.mode === 'label') {
        const t: StoredThing = {
          ...contentsTemplate(),
          id: b.id,
          locationId: b.locationId,
          shortCode: allocateCode(codeTaken),
          name: name ?? null,
          type: null,
          placeId: where.placeId,
          containerId: where.containerId,
          isContainer: false,
          reviewState: name ? 'confirmed' : 'draft',
          fieldStatus: name ? { name: { state: 'manual' } } : {},
        } as StoredThing;
        inv().things.push(t);
        const event = recordEvent(inv(), me(), {
          action: 'thing.capture',
          entity: { type: 'thing', id: t.id },
          locationId: t.locationId,
          name: t.name ?? '',
          undo: () => {
            t.deletedAt = now();
          },
        });
        if (event.undoable_until) {
          result.undo = { eventId: event.id, until: event.undoable_until };
          cap().undoable[t.id] = [
            ...(cap().undoable[t.id] ?? []),
            { eventId: event.id, action: event.action, at: event.at, until: event.undoable_until },
          ];
        }
        let batch = cap().batches.find((x) => x.batchId === b.batchId);
        if (!batch) {
          batch = {
            batchId: b.batchId,
            locationId: b.locationId,
            placeId: where.placeId ?? t.placeId ?? '',
            capturedAt: now(),
            createdById: state.me.user.id,
            thingIds: [],
          };
          cap().batches.unshift(batch);
        }
        batch.thingIds.push(t.id);
        result.thing = rowOf(inv(), t);
      } else if (b.mode === 'receipt' && !b.pageOf) {
        // Another page (`pageOf`) joins the first page's draft purchase: nothing new (Q13).
        result.purchaseId = newId();
      }

      if (ai?.resolved && b.files.length > 0) {
        const paused = ai.pausedUntil !== null;
        const extraction: ExtractionAttempt = {
          id: newId(),
          attempt: 1,
          mode: b.mode,
          status: paused ? 'paused_budget' : 'queued',
          statusReason: paused ? ai.reason : null,
          pausedUntil: ai.pausedUntil,
          createdAt: now(),
          model: ai.model,
          applied: [],
          call: null,
        };
        const thingId = result.thing?.id;
        if (thingId)
          cap().extractions[thingId] = [...(cap().extractions[thingId] ?? []), extraction];
        result.extraction = { id: extraction.id, status: extraction.status };
      }
      if (result.thing && !name && !b.attachToThingId) {
        const itemId = newId();
        cap().inbox.unshift({
          id: itemId,
          kind: 'draft',
          locationId: b.locationId,
          createdAt: now(),
          createdById: state.me.user.id,
          createdByName: null,
          rowVersion: 1,
          batchId: b.batchId,
          thingId: result.thing.id,
          photos: b.files.map((f) => ({ fileId: f.fileId, thumbUrl: null })),
          fieldStatus: {},
          ...(result.extraction
            ? {
                extraction: {
                  id: result.extraction.id,
                  status: result.extraction.status,
                  ...(ai?.pausedUntil ? { pausedUntil: ai.pausedUntil } : {}),
                },
              }
            : {}),
          resolvedAt: null,
          resolution: null,
        });
        result.inboxItemId = itemId;
      }
      return reply(201, result);
    }),

    route('GET', p.captureBatches, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = query.get('locationId');
      const mine = query.get('mine') === '1' || query.get('mine') === 'true';
      const items = cap()
        .batches.filter((b) => access().visible(b.locationId))
        .filter((b) => !locationId || b.locationId === locationId)
        .filter((b) => !mine || b.createdById === state.me.user.id)
        .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt))
        .map(batchOf);
      return paginate(items, query);
    }),

    route('POST', p.captureBatchUndo(':batchId'), ({ params }) => {
      const batch = cap().batches.find((b) => b.batchId === params.batchId);
      if (!batch || !access().visible(batch.locationId)) return notFound();
      // Your own unreviewed drafts in the batch go to the trash (screens §8).
      const trashed: string[] = [];
      if (batch.createdById === state.me.user.id) {
        for (const id of batch.thingIds) {
          const t = liveThing(inv(), id);
          if (t && t.reviewState === 'draft') {
            t.deletedAt = now();
            trashed.push(id);
          }
        }
      }
      return { trashed };
    }),

    route('PUT', p.fileDisplay(':fileId'), ({ params }) => {
      const f = inv().files[params.fileId ?? ''];
      if (!f) return notFound();
      f.derivativeState = 'ready';
      return f;
    }),

    route('POST', p.thingExtract(':id'), ({ params, body }) => {
      const t = liveThing(inv(), params.id ?? null);
      if (!t || !access().visible(t.locationId)) return notFound();
      if (!access().canWrite(t.locationId)) return forbidden();
      const ai = cap().aiStatus[t.locationId];
      if (!ai?.resolved)
        return err(409, 'ai_unavailable', "AI isn't available for this location right now.");
      const list = cap().extractions[t.id] ?? [];
      cap().extractions[t.id] = list;
      for (const e of list) if (e.status !== 'failed') e.status = 'superseded';
      const b = (body ?? {}) as ExtractBody;
      const paused = ai.pausedUntil !== null;
      const next: ExtractionAttempt = {
        id: newId(),
        attempt: list.length + 1,
        mode: b.mode ?? 'thing',
        status: paused ? 'paused_budget' : 'queued',
        statusReason: paused ? ai.reason : null,
        pausedUntil: ai.pausedUntil,
        createdAt: now(),
        model: ai.model,
        applied: [],
        call: null,
      };
      list.push(next);
      // The thing's open draft follows this attempt, as the server's payload.extractionId does.
      for (const i of cap().inbox)
        if (i.kind === 'draft' && i.thingId === t.id && !i.resolvedAt)
          i.extraction = {
            id: next.id,
            status: next.status,
            ...(next.statusReason ? { statusReason: next.statusReason } : {}),
            ...(next.pausedUntil ? { pausedUntil: next.pausedUntil } : {}),
            call: null,
          };
      return reply(202, { extractionId: next.id });
    }),

    route('GET', p.thingExtractions(':id'), ({ params }) => {
      const t = liveThing(inv(), params.id ?? null);
      if (!t || !access().visible(t.locationId)) return notFound();
      return { items: [...(cap().extractions[t.id] ?? [])].reverse() };
    }),
  ];
}
