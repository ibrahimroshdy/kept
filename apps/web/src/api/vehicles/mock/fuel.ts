/**
 * Fuel and charging (plan T11; D28, D170; Q3, Q6, Q7, Q22), after the server's `fuel/`: fills and
 * charges on a vehicle, each with its odometer reading (source `fuel`, owned by the fill, Q11), the
 * station as a vendor, the pump receipt, and the summary from @kept/shared's `consumption()`,
 * `pricePerUnit()` and `perDistance()`. Module `fuel` (which needs `vehicles`); money through the
 * gate; undoable writes.
 */
import {
  consumption,
  distanceBetween,
  FUEL_UNITS,
  type FuelUnit,
  milli,
  perDistance,
  pricePerUnit,
} from '@kept/shared';
import { localDate, locOf, newId, recordHouseholdEvent } from '../../household/mock/db';
import { accessOf, paginate, versionError } from '../../inventory/mock/db';
import type { Reading } from '../../inventory/types';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { vehiclePaths as p } from '../paths';
import type { CreateFuelBody, FuelRow, FuelSummary, UpdateFuelBody } from '../types';
import { addMonths, monthStart } from './costs';
import { inWhen } from './series';
import {
  acceptedReadings,
  ensureVehiclesSeeded,
  mainMeter,
  moneyShown,
  readingList,
  type StoredFill,
  thingGate,
  thumb,
  touchMeter,
  vehiclesOf,
} from './state';

const DAY_MS = 86_400_000;
const until = () => new Date(Date.now() + 7 * DAY_MS).toISOString();
const DECIMAL = /^\d{1,7}(\.\d{1,3})?$/;
const MONEY = /^\d{1,12}(\.\d{1,4})?$/;

export function fuelRow(state: MockState, f: StoredFill): FuelRow {
  const money = moneyShown(state, f.locationId);
  const readings = state.inventory.readings;
  const r = f.readingId
    ? Object.values(readings)
        .flat()
        .find((x) => x.id === f.readingId)
    : undefined;
  const vendor = f.vendorId ? state.inventory.vendors.find((x) => x.id === f.vendorId) : undefined;
  const price = money ? pricePerUnit(f) : null;
  return {
    id: f.id,
    takenAt: f.takenAt,
    amount: f.amount,
    unit: f.unit,
    isFull: f.isFull,
    missedBefore: f.missedBefore,
    ...(money
      ? f.cost !== null && f.currency !== null
        ? { cost: f.cost, currency: f.currency }
        : {}
      : { moneyHidden: true as const }),
    ...(price ? { pricePerUnit: price.amount } : {}),
    ...(vendor ? { vendor: { id: vendor.id, name: vendor.name } } : {}),
    ...(r ? { reading: { id: r.id, value: r.value, state: r.state } } : {}),
    ...(f.receipt && money ? { receipt: f.receipt } : {}),
    loggedBy: f.loggedBy,
    rowVersion: f.rowVersion,
  };
}

/** The fills of a thing, oldest first, with their offset-free reading values (the mock has no
 * meter replacements). */
function fillsFor(state: MockState, thingId: string) {
  const meterReadings = Object.values(state.inventory.readings).flat();
  return vehiclesOf(state)
    .fills.filter((f) => f.thingId === thingId)
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt))
    .map((f) => {
      const r = f.readingId ? meterReadings.find((x) => x.id === f.readingId) : undefined;
      return { f, reading: r && r.state === 'accepted' ? { value: r.value } : null };
    });
}

export function fuelRoutes(state: MockState): MockRoute[] {
  const v = () => vehiclesOf(state);

  /** Writes a fill's odometer through the neighbours rule: backwards is a 409 with the neighbour. */
  const placeReading = (meterId: string, value: string, takenAt: string, by: string) => {
    const list = acceptedReadings(state, meterId);
    const previous = [...list].reverse().find((r) => r.takenAt <= takenAt);
    const next = list.find((r) => r.takenAt > takenAt);
    if (previous && milli(value) < milli(previous.value))
      return err(
        409,
        'conflict',
        'That conflicts with the current state.',
        `Lower than the reading before it (${previous.value}). Check the value, or record that the meter was replaced first.`,
        {
          reason: 'lower_than_previous',
          previous: { value: previous.value, takenAt: previous.takenAt },
        },
      );
    if (next && milli(value) > milli(next.value))
      return err(
        409,
        'conflict',
        'That conflicts with the current state.',
        `Higher than the reading after it (${next.value}). Check the value and the date it was taken.`,
        { reason: 'higher_than_next', next: { value: next.value, takenAt: next.takenAt } },
      );
    const reading: Reading = {
      id: newId(),
      value,
      takenAt,
      source: 'fuel',
      state: 'accepted',
      reviewReason: null,
      loggedBy: { displayName: by },
      note: null,
      rowVersion: 1,
    };
    readingList(state, meterId).push(reading);
    touchMeter(state, meterId);
    return reading;
  };

  const removeReading = (readingId: string | null) => {
    if (!readingId) return;
    for (const [meterId, list] of Object.entries(state.inventory.readings)) {
      if (!list.some((r) => r.id === readingId)) continue;
      state.inventory.readings[meterId] = list.filter((r) => r.id !== readingId);
      touchMeter(state, meterId);
    }
    v().owners.delete(readingId);
  };

  const invalid = (hint: string) => err(400, 'validation', 'The request is not valid.', hint);

  return [
    route('GET', p.thingFuel(':id'), ({ params, query }) => {
      ensureVehiclesSeeded(state);
      const g = thingGate(state, params.id, 'fuel', 'read');
      if ('reply' in g) return g.reply;
      const units = query.getAll('f.unit');
      const vendors = query.getAll('f.vendor');
      const full = query.get('f.full');
      const when = query.get('f.when');
      const sort = query.get('sort') ?? 'takenAt';
      const asc = (query.get('dir') ?? 'desc') === 'asc';
      const key = (f: StoredFill) =>
        sort === 'amount'
          ? Number(f.amount)
          : sort === 'cost'
            ? Number(f.cost ?? 0)
            : Date.parse(f.takenAt);
      const rows = v()
        .fills.filter((f) => f.thingId === g.thing.id)
        .filter((f) => units.length === 0 || units.includes(f.unit))
        .filter(
          (f) => vendors.length === 0 || (f.vendorId !== null && vendors.includes(f.vendorId)),
        )
        .filter((f) => full === null || f.isFull === (full === '1'))
        .filter((f) => inWhen(f.takenAt, when))
        .sort((a, b) => (key(a) - key(b)) * (asc ? 1 : -1))
        .map((f) => fuelRow(state, f));
      return paginate(rows, query, 20);
    }),

    route('POST', p.thingFuel(':id'), ({ params, body, headers }) => {
      ensureVehiclesSeeded(state);
      const g = thingGate(state, params.id, 'fuel', 'write');
      if ('reply' in g) return g.reply;
      const t = g.thing;
      const key = headers['idempotency-key'];
      if (!key)
        return err(400, 'validation', 'The request is not valid.', 'Send an Idempotency-Key.');
      const seen = v().idempotency.get(`fuel:${key}`);
      if (seen) return reply(201, seen);
      const b = body as CreateFuelBody;
      if (!DECIMAL.test(b.amount ?? '') || !(Number(b.amount) > 0))
        return invalid('Check body.amount: more than 0.');
      if (!(FUEL_UNITS as readonly string[]).includes(b.unit)) return invalid('Check body.unit.');
      if (b.cost !== undefined && !MONEY.test(b.cost)) return invalid('Check body.cost.');
      const money = moneyShown(state, t.locationId);
      if (b.cost !== undefined && !money)
        return err(409, 'module_off', 'This module is off in this location.');
      const me = state.me.user;
      let readingId: string | null = null;
      let placed: Reading | null = null;
      if (b.reading) {
        const meter = b.reading.meterId
          ? t.meters.find((m) => m.id === b.reading?.meterId)
          : mainMeter(t);
        if (!meter)
          return err(400, 'fuel_needs_meter', 'This thing has no meter for the odometer.');
        const out = placeReading(meter.id, b.reading.value, b.takenAt, me.displayName);
        if (!('id' in out)) return out;
        placed = out;
        readingId = out.id;
      }
      let vendorId: string | null = null;
      if (b.vendor && 'id' in b.vendor) vendorId = b.vendor.id;
      else if (b.vendor && 'name' in b.vendor) {
        vendorId = newId();
        state.inventory.vendors.push({
          id: vendorId,
          ownerAccountId: state.inventory.accountOf[t.locationId] ?? '',
          name: b.vendor.name,
          kind: 'station',
          address: null,
          phone: null,
          website: null,
          rowVersion: 1,
        });
      }
      const fill: StoredFill = {
        id: b.id ?? newId(),
        thingId: t.id,
        locationId: t.locationId,
        takenAt: b.takenAt,
        amount: b.amount,
        unit: b.unit as FuelUnit,
        isFull: b.isFull,
        missedBefore: b.missedBefore ?? false,
        cost: b.cost ?? null,
        currency:
          b.cost !== undefined
            ? (b.currency ?? locOf(state, t.locationId)?.currency ?? 'EGP')
            : null,
        vendorId,
        readingId,
        receipt: b.receiptFileId
          ? { attachmentId: newId(), fileId: b.receiptFileId, thumbUrl: thumb(b.receiptFileId) }
          : null,
        note: b.note ?? null,
        loggedBy: { displayName: me.displayName },
        loggedById: me.id,
        rowVersion: 1,
      };
      if (readingId) v().owners.set(readingId, { type: 'fuel', id: fill.id });
      if (placed && b.reading?.proofFileId)
        v().proofs.push({
          thingId: t.id,
          meterId: mainMeter(t)?.id ?? '',
          readingId: placed.id,
          takenAt: placed.takenAt,
          fileId: b.reading.proofFileId,
          attachmentId: newId(),
          by: placed.loggedBy,
        });
      v().fills.push(fill);
      const eventId = recordHouseholdEvent(state, {
        action: 'fuel.create',
        entity: { type: 'fuel_entry', id: fill.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
        undo: () => {
          v().fills = v().fills.filter((x) => x.id !== fill.id);
          removeReading(fill.readingId);
        },
      });
      const result = {
        entry: fuelRow(state, fill),
        ...(placed ? { reading: { id: placed.id, state: placed.state } } : {}),
        undo: { eventId, until: until() },
      };
      v().idempotency.set(`fuel:${key}`, result);
      return reply(201, result);
    }),

    route('PATCH', p.fuelEntry(':id'), ({ params, body, headers }) => {
      const fill = v().fills.find((f) => f.id === params.id);
      if (!fill) return notFound();
      const g = thingGate(state, fill.thingId, 'fuel', 'write');
      if ('reply' in g) return g.reply;
      const mine = fill.loggedById === state.me.user.id;
      if (!mine && !accessOf(state).isAdmin(fill.locationId))
        return err(403, 'forbidden', "You don't have permission.");
      const version = versionError(headers, fill);
      if (version) return reply(version.status, version.body);
      const b = body as UpdateFuelBody;
      if (b.amount !== undefined && !(Number(b.amount) > 0))
        return invalid('Check body.amount: more than 0.');
      if (b.cost !== undefined && !moneyShown(state, fill.locationId))
        return err(409, 'module_off', 'This module is off in this location.');
      const before = { ...fill };
      if (b.reading) {
        // A changed odometer re-places its reading (T11).
        const old = fill.readingId;
        removeReading(old);
        const meter = mainMeter(g.thing);
        if (!meter)
          return err(400, 'fuel_needs_meter', 'This thing has no meter for the odometer.');
        const out = placeReading(
          meter.id,
          b.reading.value,
          b.takenAt ?? fill.takenAt,
          fill.loggedBy.displayName,
        );
        if (!('id' in out)) return out;
        fill.readingId = out.id;
        v().owners.set(out.id, { type: 'fuel', id: fill.id });
      }
      Object.assign(fill, {
        ...(b.takenAt !== undefined ? { takenAt: b.takenAt } : {}),
        ...(b.amount !== undefined ? { amount: b.amount } : {}),
        ...(b.unit !== undefined ? { unit: b.unit } : {}),
        ...(b.cost !== undefined ? { cost: b.cost } : {}),
        ...(b.currency !== undefined ? { currency: b.currency } : {}),
        ...(b.isFull !== undefined ? { isFull: b.isFull } : {}),
        ...(b.missedBefore !== undefined ? { missedBefore: b.missedBefore } : {}),
        ...(b.note !== undefined ? { note: b.note } : {}),
      });
      fill.rowVersion += 1;
      recordHouseholdEvent(state, {
        action: 'fuel.update',
        entity: { type: 'fuel_entry', id: fill.id },
        locationId: fill.locationId,
        rootThingId: fill.thingId,
        name: g.thing.name ?? '',
        undo: () => Object.assign(fill, before),
      });
      return fuelRow(state, fill);
    }),

    route('DELETE', p.fuelEntry(':id'), ({ params, headers }) => {
      const fill = v().fills.find((f) => f.id === params.id);
      if (!fill) return notFound();
      const g = thingGate(state, fill.thingId, 'fuel', 'write');
      if ('reply' in g) return g.reply;
      const mine = fill.loggedById === state.me.user.id;
      if (!mine && !accessOf(state).isAdmin(fill.locationId))
        return err(403, 'forbidden', "You don't have permission.");
      const version = versionError(headers, fill);
      if (version) return reply(version.status, version.body);
      const meterId = mainMeter(g.thing)?.id;
      const reading =
        fill.readingId && meterId
          ? (state.inventory.readings[meterId] ?? []).find((r) => r.id === fill.readingId)
          : undefined;
      v().fills = v().fills.filter((f) => f.id !== fill.id);
      removeReading(fill.readingId);
      const eventId = recordHouseholdEvent(state, {
        action: 'fuel.delete',
        entity: { type: 'fuel_entry', id: fill.id },
        locationId: fill.locationId,
        rootThingId: fill.thingId,
        name: g.thing.name ?? '',
        undo: () => {
          v().fills.push(fill);
          if (reading && meterId) {
            readingList(state, meterId).push(reading);
            v().owners.set(reading.id, { type: 'fuel', id: fill.id });
            touchMeter(state, meterId);
          }
        },
      });
      return { undo: { eventId, until: until() } };
    }),

    route('GET', p.thingFuelSummary(':id'), ({ params, query }) => {
      ensureVehiclesSeeded(state);
      const g = thingGate(state, params.id, 'fuel', 'read');
      if ('reply' in g) return g.reply;
      const t = g.thing;
      const window = Number(query.get('window') ?? 5) || 5;
      const monthsBack = Number(query.get('months') ?? 6) || 6;
      const meter = mainMeter(t);
      const rows = fillsFor(state, t.id);
      const input = rows.map(({ f, reading }) => ({ ...f, reading }));
      const units = [...new Set(rows.map(({ f }) => f.unit))];
      const summary: FuelSummary = {
        byUnit: units.map((unit) => {
          const c = consumption(input, { window, unit });
          const all = consumption(input, { window: 1000, unit });
          return {
            unit,
            consumption:
              c.overall && meter
                ? {
                    perHundred: c.overall.perHundred,
                    distanceUnit: meter.unit,
                    fills: c.overall.fills,
                    from: String(c.overall.fromAt),
                    to: String(c.overall.toAt),
                  }
                : null,
            ...(c.whyNone ? { whyNone: c.whyNone } : {}),
            trend: all.intervals.map((i) => ({ at: String(i.toAt), perHundred: i.perHundred })),
          };
        }),
      };
      if (!moneyShown(state, t.locationId)) return { ...summary, moneyHidden: true };
      const priced = rows.filter(({ f }) => f.cost !== null && f.currency !== null);
      summary.pricePerUnit = [...new Set(priced.map(({ f }) => `${f.unit}|${f.currency}`))].map(
        (pair) => {
          const [unit, currency] = pair.split('|') as [FuelUnit, string];
          const trend = priced
            .filter(({ f }) => f.unit === unit && f.currency === currency)
            .map(({ f }) => ({ at: f.takenAt, price: pricePerUnit(f)?.amount ?? '0' }));
          return { unit, currency, latest: trend.at(-1)?.price ?? '0', trend };
        },
      );
      // Cost per distance and the monthly average over the last `months` full local months.
      const tz = locOf(state, t.locationId)?.timezone ?? 'Africa/Cairo';
      const thisMonth = localDate(tz).slice(0, 7);
      const startMonth = addMonths(thisMonth, -monthsBack);
      const inWindow = priced.filter(({ f }) => {
        const m = localDate(tz, new Date(f.takenAt)).slice(0, 7);
        return m >= startMonth && m < thisMonth;
      });
      const from = monthStart(startMonth, tz);
      const to = monthStart(thisMonth, tz);
      const distance = meter ? distanceBetween(acceptedReadings(state, meter.id), from, to) : null;
      const costs = inWindow.map(({ f }) => ({
        amount: f.cost as string,
        currency: f.currency as string,
      }));
      if (distance && meter)
        summary.perDistance = perDistance(costs, distance).map((x) => ({
          ...x,
          distanceUnit: meter.unit,
          from,
          to,
        }));
      summary.monthlyAverage = perDistance(costs, String(monthsBack)).map((x) => ({
        currency: x.currency,
        amount: x.amount,
        months: monthsBack,
      }));
      return summary;
    }),
  ];
}
