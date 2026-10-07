/**
 * A meter's readings, finished (plan T8), and its series and proof strip (T13, D195), after the
 * server's `meters/` and `vehicles/series.ts`:
 * - GET readings gains the `readings` surface's filters, `sort`/`dir`, and each reading's proof
 *   photo and owner (a fill or a service, Q11);
 * - POST readings gains "It's right" (`confirmJump`, Q9), the proof photo and `undo`; step 2's
 *   handler still decides the neighbours (a backwards value is its 409);
 * - PATCH and DELETE on a reading a fill or a service owns answer 409 `reading_owned`;
 * - step 2's "the meter was replaced" (`POST /meters/:id/replaced`, T19's Meter replaced): later
 *   readings are compared after the offset, as the server's `placeReading` does;
 * - the series: accepted readings, the estimate dashed to the next threshold, and the thing's unit
 *   schedules' thresholds with their estimated dates.
 */
import { isDateFilterValue, parseDateRange } from '@kept/shared';
import { hh, newId, recordHouseholdEvent, scheduleView } from '../../household/mock/db';
import type { Schedule } from '../../household/types';
import { accessOf, paginate } from '../../inventory/mock/db';
import { thingsRoutes } from '../../inventory/mock/things';
import { inventoryPaths } from '../../inventory/paths';
import type { Reading } from '../../inventory/types';
import type { MockState } from '../../mock/fixtures';
import { err, MockReply, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { vehiclePaths as p } from '../paths';
import type { CreateReadingBodyV5, MeterSeries, ProofItem, ReadingRow } from '../types';
import {
  acceptedReadings,
  ensureVehiclesSeeded,
  estimateOf,
  etaOf,
  thingOfMeter,
  thumb,
  touchMeter,
  vehiclesOf,
} from './state';
import { original, scheduleEstimate } from './vehicles';

const DAY_MS = 86_400_000;

/** Whether an ISO instant falls in a `f.when` value (a preset or a custom range), in UTC days. */
export function inWhen(at: string, when: string | null): boolean {
  if (!when || !isDateFilterValue(when)) return true;
  const day = at.slice(0, 10);
  const range = parseDateRange(when);
  if (range) return (!range.from || day >= range.from) && (!range.to || day <= range.to);
  const days = { today: 0, week: 7, month: 31, year: 366 }[when as 'today'] ?? 0;
  return day >= new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

/** A reading as step 5 answers it: its proof photo and its owner. */
export function readingRow(state: MockState, r: Reading): ReadingRow {
  const v = vehiclesOf(state);
  const proof = v.proofs.find((x) => x.readingId === r.id);
  const owner = v.owners.get(r.id);
  return {
    ...r,
    ...(proof
      ? {
          proof: {
            attachmentId: proof.attachmentId,
            fileId: proof.fileId,
            thumbUrl: thumb(proof.fileId),
          },
        }
      : {}),
    ...(owner ? { ownedBy: owner } : {}),
  };
}

/** Step 2's replacement events per meter (the mock's `meter_events`). */
const replacements = new WeakMap<MockState, Map<string, { at: string; offset: string }[]>>();
function replacementsOf(state: MockState, meterId: string) {
  const byMeter = replacements.get(state) ?? new Map<string, { at: string; offset: string }[]>();
  replacements.set(state, byMeter);
  const list = byMeter.get(meterId) ?? [];
  byMeter.set(meterId, list);
  return list;
}
/** The offset in force at `at`: the latest replacement at or before it, else 0. */
function offsetAt(state: MockState, meterId: string, at: string): number {
  const found = replacementsOf(state, meterId)
    .filter((e) => e.at <= at)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
  return found ? Number(found.offset) : 0;
}

export function seriesRoutes(state: MockState): MockRoute[] {
  const step2 = thingsRoutes(state);
  const postReading = original(step2, 'POST', inventoryPaths.meterReadings(':id'));
  const patchReading = original(step2, 'PATCH', inventoryPaths.reading(':id'));
  const deleteReading = original(step2, 'DELETE', inventoryPaths.reading(':id'));
  const visibleMeter = (id: string | undefined) => {
    const t = thingOfMeter(state, id ?? '');
    return t && accessOf(state).visible(t.locationId) ? t : null;
  };
  const refuseOwned = (readingId: string | undefined) => {
    const owner = vehiclesOf(state).owners.get(readingId ?? '');
    return owner
      ? err(
          409,
          'reading_owned',
          'Change this reading from its fuel entry or service.',
          undefined,
          {
            ownedBy: owner,
          },
        )
      : null;
  };

  return [
    route('GET', inventoryPaths.meterReadings(':id'), ({ params, query }) => {
      const list = state.inventory.readings[params.id ?? ''];
      if (!list) return notFound();
      const sources = query.getAll('f.source');
      const states = query.getAll('f.state');
      const when = query.get('f.when');
      const asc = query.get('dir') === 'asc';
      const rows = list
        .filter((r) => sources.length === 0 || sources.includes(r.source))
        .filter((r) => states.length === 0 || states.includes(r.state))
        .filter((r) => inWhen(r.takenAt, when))
        .sort((a, b) => a.takenAt.localeCompare(b.takenAt) * (asc ? 1 : -1))
        .map((r) => readingRow(state, r));
      return paginate(rows, query);
    }),

    route('POST', inventoryPaths.meterReplaced(':id'), ({ params, body }) => {
      const t = visibleMeter(params.id);
      if (!t) return notFound();
      if (!accessOf(state).isAdmin(t.locationId))
        return err(403, 'forbidden', "You don't have permission.");
      const b = body as { at: string; offset: string };
      const list = replacementsOf(state, params.id ?? '');
      list.push({ at: b.at, offset: b.offset });
      return reply(201, {
        event: { id: newId(), at: b.at, offset: b.offset },
        meter: { id: params.id },
      });
    }),

    route('POST', inventoryPaths.meterReadings(':id'), async (req) => {
      const b = req.body as CreateReadingBodyV5;
      // After a replacement, step 2's neighbours check compares the value with the offset added
      // (the server's placeReading); the reading itself keeps the value as read.
      const offset = offsetAt(state, req.params.id ?? '', b.takenAt);
      const out = await postReading(
        offset ? { ...req, body: { ...b, value: String(Number(b.value) + offset) } } : req,
      );
      if (offset && !(out instanceof MockReply && out.status >= 300)) {
        const made = (out instanceof MockReply ? out.body : out) as { reading: Reading };
        made.reading.value = b.value;
      }
      if ((out instanceof MockReply && out.status >= 300) || !vehiclesOf(state).seeded) return out;
      const res = (out instanceof MockReply ? out.body : out) as {
        reading: Reading;
        state: Reading['state'];
        reason?: string;
      };
      const meterId = req.params.id ?? '';
      const r = res.reading;
      // "It's right" (Q9): an implausible jump is stored accepted; backwards never gets here.
      if (b.confirmJump && r.reviewReason === 'implausible_jump') {
        r.state = 'accepted';
        r.reviewReason = null;
        touchMeter(state, meterId);
      }
      const t = thingOfMeter(state, meterId);
      if (b.proofFileId && t) {
        vehiclesOf(state).proofs.push({
          thingId: t.id,
          meterId,
          readingId: r.id,
          takenAt: r.takenAt,
          fileId: b.proofFileId,
          attachmentId: newId(),
          by: r.loggedBy,
        });
      }
      const eventId = recordHouseholdEvent(state, {
        action: 'reading.create',
        entity: { type: 'reading', id: r.id },
        locationId: t?.locationId ?? '',
        rootThingId: t?.id ?? null,
        name: t?.name ?? '',
        undo: () => {
          const list = state.inventory.readings[meterId] ?? [];
          state.inventory.readings[meterId] = list.filter((x) => x.id !== r.id);
          touchMeter(state, meterId);
        },
      });
      return reply(201, {
        reading: readingRow(state, r),
        state: r.state,
        ...(r.reviewReason ? { reason: r.reviewReason } : {}),
        undo: { eventId, until: new Date(Date.now() + 7 * DAY_MS).toISOString() },
      });
    }),

    route(
      'PATCH',
      inventoryPaths.reading(':id'),
      (req) => refuseOwned(req.params.id) ?? patchReading(req),
    ),
    route(
      'DELETE',
      inventoryPaths.reading(':id'),
      (req) => refuseOwned(req.params.id) ?? deleteReading(req),
    ),

    // GET /api/v1/meters/:id/proofs (D195): reading-linked proofs and step-3 proofs on the thing,
    // newest first.
    route('GET', p.meterProofs(':id'), ({ params, query }) => {
      ensureVehiclesSeeded(state);
      const t = visibleMeter(params.id);
      if (!t) return notFound();
      const values = new Map(
        (state.inventory.readings[params.id ?? ''] ?? []).map((r) => [r.id, r.value]),
      );
      const items: ProofItem[] = vehiclesOf(state)
        .proofs.filter((x) => x.meterId === params.id)
        .sort((a, b) => b.takenAt.localeCompare(a.takenAt))
        .map((x) => ({
          readingId: x.readingId,
          value: x.readingId ? (values.get(x.readingId) ?? null) : null,
          takenAt: x.takenAt,
          fileId: x.fileId,
          thumbUrl: thumb(x.fileId),
          by: x.by,
        }));
      return paginate(items, query, 20);
    }),

    // GET /api/v1/meters/:id/series (T13).
    route('GET', p.meterSeries(':id'), ({ params, query }) => {
      ensureVehiclesSeeded(state);
      const t = visibleMeter(params.id);
      const meter = t?.meters.find((m) => m.id === params.id);
      if (!t || !meter) return notFound();
      const from = query.get('from');
      const to = query.get('to');
      const rows = acceptedReadings(state, meter.id);
      const points = rows
        .filter((r) => (!from || r.takenAt >= from) && (!to || r.takenAt <= `${to}￿`))
        .map((r) => ({ takenAt: r.takenAt, value: r.value, source: r.source }));
      const thresholds = hh(state)
        .schedules.filter((s) => s.active && s.meterId === meter.id)
        .map((s) => scheduleView(state, s))
        .filter((s): s is Schedule => s !== null && s.next.dueValue !== null)
        .map((s) => ({
          scheduleId: s.id,
          name: s.name,
          value: s.next.dueValue as string,
          estimatedOn: scheduleEstimate(state, s).estimatedOn,
        }))
        .sort((a, b) => Number(a.value) - Number(b.value));
      const est = estimateOf(state, meter.id);
      const last = rows.at(-1);
      const target = thresholds[0];
      const series: MeterSeries = { unit: meter.unit, points, thresholds };
      if (est.perDay && last) {
        const endValue = target?.value ?? String(Number(last.value) + Number(est.perDay) * 90);
        const endAt = target
          ? (etaOf(state, meter.id, target.value) ?? last.takenAt.slice(0, 10))
          : new Date(Date.parse(last.takenAt) + 90 * DAY_MS).toISOString().slice(0, 10);
        series.estimate = {
          perDay: est.perDay,
          through: [
            { at: last.takenAt, value: last.value },
            { at: `${endAt}T12:00:00.000Z`, value: endValue },
          ],
        };
      }
      return series;
    }),
  ];
}
