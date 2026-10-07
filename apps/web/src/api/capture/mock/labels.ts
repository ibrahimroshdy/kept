/**
 * Mock handlers for label batches, blank sheets, "Printed OK?" and claims (T16). A thing without
 * a code (an offline capture not yet synced) can't be in a batch: it's counted as `pending`. A
 * claim of a code another phone claimed first is 409 `label_claimed` with the other target's
 * name; any code the caller can't claim is the same 404 as a random one (D137). A `dryRun`
 * create (T28's preview) answers the labels without saving or allocating anything.
 */

import {
  accessOf,
  liveThing,
  newId,
  now,
  paginate,
  placePath,
  type StoredThing,
  thingPath,
} from '../../inventory/mock/db';
import { contentsTemplate } from '../../inventory/mock/places';
import type { PathStep } from '../../inventory/types';
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
  ClaimBody,
  CreateLabelBatchBody,
  LabelBatch,
  LabelBatchPreview,
  LabelCellContent,
} from '../types';
import { allocateCode } from './capture';
import { urlOf } from './state';

const BLANK_CAP = 1000;

/** "Garage › Shelf A": the label's path line (unplaced areas included, as the server names them). */
const pathText = (steps: PathStep[]) => steps.map((s) => s.name).join(' › ');

export function labelsRoutes(state: MockState): MockRoute[] {
  const inv = () => state.inventory;
  const cap = () => state.capture;
  const access = () => accessOf(state);
  const codeTaken = (code: string) =>
    inv().things.some((t) => t.shortCode === code) || cap().codes.some((c) => c.code === code);
  const labelsOn = (locationId: string) =>
    state.locations.find((l) => l.id === locationId)?.modules.includes('labels') ?? false;
  const printedCodes = () =>
    new Set(
      cap()
        .codes.filter((c) => c.printedAt)
        .map((c) => c.code),
    );

  return [
    route('POST', p.labelBatches, ({ body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const b = body as CreateLabelBatchBody;
      if (!access().visible(b.locationId)) return notFound();
      if (!access().canWrite(b.locationId)) return forbidden();
      if (!labelsOn(b.locationId))
        return err(409, 'module_off', 'Labels are off in this location.');
      const labels: LabelCellContent[] = [];
      // Excluded and counted, as the server does: `pending` when the caller can't see it at all
      // (an offline capture not synced yet looks the same), `other` when it is visible but can't
      // be labelled here (trashed, or in another location).
      let pending = 0;
      let other = 0;
      let blank = 0;
      if (b.kind === 'blank') {
        const count = b.blankCount ?? 0;
        const unclaimed = cap().codes.filter(
          (c) => c.locationId === b.locationId && c.state === 'blank',
        ).length;
        if (count < 1 || count > 500) return err(400, 'validation', 'Between 1 and 500 labels.');
        if (unclaimed + count > BLANK_CAP)
          return err(409, 'blank_cap_reached', 'This location already has 1,000 unclaimed labels.');
        blank = count;
        // A preview allocates nothing: the codes are made only when the batch is.
        for (let i = 0; i < (b.dryRun ? 0 : count); i++) {
          const code = allocateCode(codeTaken);
          cap().codes.push({
            code,
            locationId: b.locationId,
            state: 'blank',
            target: null,
            printedAt: null,
          });
          labels.push({ code, url: urlOf(code), kind: 'blank' });
        }
      } else if (b.kind === 'things') {
        const printed = printedCodes();
        const ids = b.unprinted
          ? inv()
              .things.filter(
                (t) =>
                  t.locationId === b.locationId &&
                  !t.deletedAt &&
                  !(t.shortCode && printed.has(t.shortCode)) &&
                  (!b.unprinted?.placeId ||
                    thingPath(inv(), t).some((s) => s.id === b.unprinted?.placeId)),
              )
              .map((t) => t.id)
          : (b.thingIds ?? []);
        for (const id of ids) {
          const t = liveThing(inv(), id);
          if (!t || t.locationId !== b.locationId) {
            const seen = inv().things.find((x) => x.id === id);
            if (seen && access().visible(seen.locationId)) other += 1;
            else pending += 1;
            continue;
          }
          if (!t.shortCode) {
            pending += 1;
            continue;
          }
          labels.push({
            code: t.shortCode,
            url: urlOf(t.shortCode),
            kind: 'thing',
            name: t.name ?? '',
            path: pathText(thingPath(inv(), t)),
            targetId: t.id,
          });
        }
      } else {
        for (const id of b.placeIds ?? []) {
          const pl = inv().places.find((x) => x.id === id && !x.deletedAt);
          if (!pl?.shortCode || pl.locationId !== b.locationId) {
            const seen = inv().places.find((x) => x.id === id);
            if (seen && access().visible(seen.locationId)) other += 1;
            else pending += 1;
            continue;
          }
          labels.push({
            code: pl.shortCode,
            url: urlOf(pl.shortCode),
            kind: 'place',
            name: pl.name,
            path: pathText(placePath(inv(), pl.parentId)),
            targetId: pl.id,
          });
        }
      }
      const excluded = { pending, other };
      if (b.dryRun) return reply(200, { labels, blank, excluded } satisfies LabelBatchPreview);
      // A real batch with nothing to label (the preview was stale, or everything is pending).
      if (b.kind !== 'blank' && labels.length === 0)
        return err(
          400,
          'validation',
          'The request is not valid.',
          'Nothing here can be labelled yet: what is left is waiting to sync, or already printed.',
          { excluded },
        );
      const batch: LabelBatch = {
        id: b.id ?? newId(),
        locationId: b.locationId,
        kind: b.kind,
        stock: b.stock,
        startCell: b.startCell ?? 1,
        createdAt: now(),
        printedConfirmedAt: null,
        labels,
      };
      cap().labelBatches.unshift(batch);
      return reply(201, { batch, excluded });
    }),

    route('GET', p.labelBatches, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = query.get('locationId');
      const items = cap().labelBatches.filter(
        (b) => access().visible(b.locationId) && (!locationId || b.locationId === locationId),
      );
      return paginate(items, query);
    }),

    route('GET', p.labelBatch(':id'), ({ params }) => {
      const batch = cap().labelBatches.find((b) => b.id === params.id);
      return batch && access().visible(batch.locationId) ? batch : notFound();
    }),

    route('POST', p.labelBatchPrinted(':id'), ({ params }) => {
      const batch = cap().labelBatches.find((b) => b.id === params.id);
      if (!batch || !access().visible(batch.locationId)) return notFound();
      const at = now();
      batch.printedConfirmedAt ??= at;
      for (const l of batch.labels) {
        const c = cap().codes.find((x) => x.code === l.code);
        if (c) c.printedAt ??= at;
        else if (l.targetId && l.kind !== 'blank')
          // A thing's or place's own code, printed for the first time.
          cap().codes.push({
            code: l.code,
            locationId: batch.locationId,
            state: 'assigned',
            target: { kind: l.kind, id: l.targetId, name: l.name ?? '' },
            printedAt: at,
          });
      }
      return batch;
    }),

    route('GET', p.labelSummary, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const locationId = query.get('locationId');
      const inScope = (id: string) => access().visible(id) && (!locationId || id === locationId);
      const printed = printedCodes();
      return {
        unprinted: inv().things.filter(
          (t) => !t.deletedAt && inScope(t.locationId) && t.shortCode && !printed.has(t.shortCode),
        ).length,
        blankUnclaimed: cap().codes.filter((c) => c.state === 'blank' && inScope(c.locationId))
          .length,
      };
    }),

    route('POST', p.codeClaim(':code'), ({ params, body }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      const code = cap().codes.find((c) => c.code === params.code);
      if (!code || !access().canWrite(code.locationId)) return notFound();
      if (code.state === 'assigned' && code.target)
        return err(409, 'label_claimed', 'This label was already claimed.', undefined, {
          claimedFor: code.target,
        });
      const b = body as ClaimBody;
      let target: { kind: 'thing' | 'place'; id: string; name: string } | null = null;
      if ('thingId' in b) {
        const t = liveThing(inv(), b.thingId);
        if (t?.locationId === code.locationId)
          target = { kind: 'thing', id: t.id, name: t.name ?? '' };
      } else if ('placeId' in b) {
        const pl = inv().places.find((x) => x.id === b.placeId && !x.deletedAt);
        if (pl?.locationId === code.locationId)
          target = { kind: 'place', id: pl.id, name: pl.name };
      } else {
        // D43 "New box here": the container is created and claimed in one step (T16).
        const nc = b.newContainer;
        const parent =
          'placeId' in nc
            ? inv().places.find((x) => x.id === nc.placeId && !x.deletedAt)
            : liveThing(inv(), nc.containerId);
        if (parent?.locationId === code.locationId) {
          inv().things.push({
            ...contentsTemplate(),
            id: nc.id,
            locationId: code.locationId,
            shortCode: code.code,
            name: nc.name,
            type: null,
            placeId: 'placeId' in nc ? nc.placeId : null,
            containerId: 'containerId' in nc ? nc.containerId : null,
            isContainer: true,
            reviewState: 'confirmed',
          } as StoredThing);
          target = { kind: 'thing', id: nc.id, name: nc.name };
        }
      }
      if (!target) return notFound();
      code.state = 'assigned';
      code.target = target;
      return { outcome: 'claimed', target: { kind: target.kind, id: target.id } };
    }),
  ];
}
