/**
 * The vehicles list, a vehicle's meters with their estimates, the meter's settings, Home's count
 * of metered things, and starter schedules (plan T13, T8), after the server's `vehicles/` and
 * `meters/`. The step-2 routes this extends (`GET /things/:id`, `GET /home`) are answered by step
 * 2's handler first; this adds step 5's fields to what it returns.
 */
import {
  type AgendaState,
  consumption,
  normalize,
  STARTER_SCHEDULES,
  type StarterKey,
  starterInterval,
} from '@kept/shared';
import {
  documentView,
  hh,
  householdRowOf,
  newId,
  recordHouseholdEvent,
  scheduleView,
} from '../../household/mock/db';
import type { StoredSchedule } from '../../household/mock/state';
import type { Schedule } from '../../household/types';
import { accessOf, paginate, type StoredThing, versionError } from '../../inventory/mock/db';
import { homeRoutes } from '../../inventory/mock/home';
import { thingsRoutes } from '../../inventory/mock/things';
import { inventoryPaths } from '../../inventory/paths';
import type { HomeResponse, ThingView } from '../../inventory/types';
import type { MockState } from '../../mock/fixtures';
import {
  err,
  MockReply,
  type MockRoute,
  notFound,
  reply,
  route,
  sessionGate,
} from '../../mock/kit';
import { vehiclePaths as p } from '../paths';
import type {
  StarterSchedulesBody,
  ThingMeterV5,
  UpdateMeterBodyV5,
  VehicleRow,
  VehiclesParams,
} from '../types';
import {
  acceptedReadings,
  ensureVehiclesSeeded,
  estimateOf,
  etaOf,
  isVehicle,
  mainMeter,
  thingGate,
  thingOfMeter,
  vehiclesOf,
} from './state';

const SEVERITY: Record<AgendaState, number> = {
  overdue: 4,
  expired: 3,
  due: 2,
  expiring: 1,
  upcoming: 0,
};

/** Step 2's handler for a route, to answer first and extend. */
export function original(routes: MockRoute[], method: string, template: string) {
  const found = routes.find((r) => r.method === method && r.template === template);
  if (!found) throw new Error(`no step-2/4 handler for ${method} ${template}`);
  return found.handler;
}

/** A meter as GET /things/:id answers it in step 5: its estimate and nudge interval (T8). */
export function meterV5(state: MockState, m: StoredThing['meters'][number]): ThingMeterV5 {
  const nudge = vehiclesOf(state).nudgeDays;
  return {
    ...m,
    estimate: estimateOf(state, m.id),
    nudgeDays: nudge.has(m.id) ? (nudge.get(m.id) ?? null) : 30,
  };
}

/** A schedule with its estimated due date (T7): a unit side's date from the usage estimate. */
export function scheduleEstimate(state: MockState, s: Schedule) {
  const lead = s.leadUnits ?? (s.everyUnits ? String(Number(s.everyUnits) / 10) : '0');
  const estimatedOn =
    s.meter && s.next.dueValue
      ? etaOf(state, s.meter.id, String(Math.max(0, Number(s.next.dueValue) - Number(lead))))
      : null;
  const estimated = estimatedOn !== null && (!s.next.dueOn || estimatedOn < s.next.dueOn);
  return { estimatedOn, estimated, dueOn: estimated ? estimatedOn : s.next.dueOn };
}

function vehicleRow(state: MockState, t: StoredThing): VehicleRow {
  const m = mainMeter(t);
  const latest = m ? acceptedReadings(state, m.id).at(-1) : undefined;
  const schedules = hh(state)
    .schedules.filter((s) => s.active && 'thingId' in s.subject && s.subject.thingId === t.id)
    .map((s) => scheduleView(state, s))
    .filter((s): s is Schedule => s !== null)
    .map((s) => ({ s, e: scheduleEstimate(state, s) }))
    .sort(
      (a, b) =>
        SEVERITY[b.s.next.state] - SEVERITY[a.s.next.state] ||
        (a.e.dueOn ?? '9999').localeCompare(b.e.dueOn ?? '9999'),
    );
  const next = schedules[0];
  const documentsDue = hh(state)
    .documents.filter(
      (d) => !d.supersededById && 'thingId' in d.subject && d.subject.thingId === t.id,
    )
    .map((d) => documentView(state, d))
    .filter((d) => d !== null && d.state !== 'ok')
    .map((d) => ({
      id: d?.id ?? '',
      kind: d?.kind ?? 'other',
      expiresOn: d?.expiresOn ?? '',
      state: d?.state ?? 'ok',
    }));
  const fills = vehiclesOf(state)
    .fills.filter((f) => f.thingId === t.id)
    .sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  const readingValue = (id: string | null) =>
    m && id ? acceptedReadings(state, m.id).find((r) => r.id === id)?.value : undefined;
  const fuelOn = (state.locations.find((l) => l.id === t.locationId)?.modules ?? []).includes(
    'fuel',
  );
  const c = fuelOn
    ? consumption(
        fills.map((f) => {
          const value = readingValue(f.readingId);
          return { ...f, reading: value ? { value } : null };
        }),
      ).overall
    : null;
  return {
    thing: householdRowOf(state, t),
    ...(m
      ? {
          meter: {
            id: m.id,
            unit: m.unit,
            ...(latest
              ? {
                  latest: {
                    value: latest.value,
                    takenAt: latest.takenAt,
                    source: latest.source,
                    by: latest.loggedBy,
                  },
                }
              : {}),
            estimate: estimateOf(state, m.id),
          },
        }
      : {}),
    ...(next
      ? {
          nextDue: {
            name: next.s.name,
            ...(next.e.dueOn ? { dueOn: next.e.dueOn } : {}),
            ...(next.s.next.dueValue ? { dueValue: next.s.next.dueValue } : {}),
            estimated: next.e.estimated,
            state: next.s.next.state,
          },
        }
      : {}),
    documentsDue,
    ...(c && m ? { fuel: { perHundred: c.perHundred, unit: c.unit, distanceUnit: m.unit } } : {}),
  };
}

const all = (query: URLSearchParams, key: string) => query.getAll(key).filter(Boolean);

export function vehicleListRoutes(state: MockState): MockRoute[] {
  const step2Things = thingsRoutes(state);
  const step2Home = homeRoutes(state);
  const getThing = original(step2Things, 'GET', inventoryPaths.thing(':id'));
  const getHome = original(step2Home, 'GET', inventoryPaths.home);

  return [
    // GET /api/v1/vehicles (T13): global across the caller's locations with Vehicles on.
    route('GET', p.vehicles, ({ query }) => {
      const gate = sessionGate(state);
      if (gate) return gate;
      ensureVehiclesSeeded(state);
      const access = accessOf(state);
      const on = new Set(
        state.locations
          .filter((l) => access.visible(l.id) && l.modules.includes('vehicles'))
          .map((l) => l.id),
      );
      const not = new Set(all(query, 'not'));
      const filter = <T>(
        key: NonNullable<VehiclesParams['not']>[number],
        value: (r: VehicleRow) => T,
      ) => {
        const wanted = all(query, `f.${key}`);
        return (r: VehicleRow) =>
          wanted.length === 0 || wanted.includes(String(value(r))) !== not.has(key);
      };
      const states = all(query, 'f.state');
      const q = normalize(query.get('q') ?? '');
      let rows = state.inventory.things
        .filter((t) => !t.deletedAt && on.has(t.locationId) && isVehicle(state, t))
        .filter((t) =>
          states.length === 0
            ? t.lifecycle === 'in_use'
            : states.includes(t.lifecycle) !== not.has('state'),
        )
        .filter((t) => !q || normalize(t.name ?? '').includes(q))
        .map((t) => vehicleRow(state, t))
        .filter(filter('location', (r) => r.thing.locationId))
        .filter(filter('type', (r) => r.thing.type?.id ?? ''))
        .filter(filter('reading', (r) => r.meter?.estimate.advice ?? 'none'))
        .filter(
          filter('due', (r) =>
            r.nextDue?.state === 'overdue'
              ? 'overdue'
              : r.nextDue?.state === 'due' || r.documentsDue.length > 0
                ? 'soon'
                : '',
          ),
        );
      const sort = query.get('sort') ?? 'name';
      const loc = (id: string) => state.locations.find((l) => l.id === id)?.name ?? '';
      const key = (r: VehicleRow): string =>
        sort === 'lastReading'
          ? (r.meter?.latest?.takenAt ?? '')
          : sort === 'nextDue'
            ? (r.nextDue?.dueOn ?? '9999')
            : sort === 'location'
              ? `${loc(r.thing.locationId)}\u0000${r.thing.name ?? ''}`
              : (r.thing.name ?? '');
      // Dates newest first by default; names A to Z (D211).
      const descByDefault = sort === 'lastReading';
      const desc = (query.get('dir') ?? (descByDefault ? 'desc' : 'asc')) === 'desc';
      rows = rows.sort((a, b) => key(a).localeCompare(key(b)) * (desc ? -1 : 1));
      return paginate(rows, query);
    }),

    // GET /api/v1/things/:id: each meter gains its estimate and nudge interval (T8).
    route('GET', inventoryPaths.thing(':id'), async (req) => {
      const out = await getThing(req);
      if (out instanceof MockReply || !vehiclesOf(state).seeded) return out;
      const view = out as ThingView;
      const t = state.inventory.things.find((x) => x.id === view.id);
      return t ? { ...view, meters: t.meters.map((m) => meterV5(state, m)) } : view;
    }),

    // PATCH /api/v1/meters/:id (If-Match): the label, the daily limit and the nudge (Q19).
    route('PATCH', inventoryPaths.meter(':id'), ({ params, body, headers }) => {
      const t = thingOfMeter(state, params.id ?? '');
      if (!t || !accessOf(state).visible(t.locationId)) return notFound();
      if (!accessOf(state).isAdmin(t.locationId))
        return err(403, 'forbidden', "You don't have permission.");
      const m = t.meters.find((x) => x.id === params.id);
      if (!m) return notFound();
      const version = versionError(headers, m);
      if (version) return reply(version.status, version.body);
      const b = body as UpdateMeterBodyV5;
      if (b.nudgeDays !== undefined) {
        if (b.nudgeDays !== null && !(b.nudgeDays >= 7 && b.nudgeDays <= 365))
          return err(
            400,
            'validation',
            'The request is not valid.',
            'Check body.nudgeDays: 7 to 365, or null.',
          );
        vehiclesOf(state).nudgeDays.set(m.id, b.nudgeDays);
      }
      if (b.label !== undefined) m.label = b.label;
      m.rowVersion += 1;
      return meterV5(state, m);
    }),

    // GET /api/v1/home: how many metered things you can log a reading on (T13).
    route('GET', inventoryPaths.home, async (req) => {
      const out = await getHome(req);
      if (out instanceof MockReply || !vehiclesOf(state).seeded) return out;
      const access = accessOf(state);
      const meteredThings = state.inventory.things.filter(
        (t) =>
          !t.deletedAt &&
          t.lifecycle === 'in_use' &&
          t.meters.length > 0 &&
          access.canWrite(t.locationId),
      ).length;
      return { ...(out as HomeResponse), meteredThings };
    }),

    // POST /api/v1/things/:id/starter-schedules (T13): the four, or `keys`; names it has skipped.
    route('POST', p.thingStarterSchedules(':id'), ({ params, body }) => {
      ensureVehiclesSeeded(state);
      const g = thingGate(state, params.id, 'vehicles', 'write');
      if ('reply' in g) return g.reply;
      const t = g.thing;
      if (
        !(state.locations.find((l) => l.id === t.locationId)?.modules ?? []).includes('schedules')
      )
        return err(409, 'module_off', 'This module is off in this location.');
      // `schedules-claims.manage`: owners, admins and members (thingGate's write check).
      const keys = (body as StarterSchedulesBody | undefined)?.keys ?? null;
      const h = hh(state);
      const has = new Set(
        h.schedules
          .filter((s) => 'thingId' in s.subject && s.subject.thingId === t.id)
          .map((s) => normalize(s.name)),
      );
      const meter = mainMeter(t);
      const latest = meter ? acceptedReadings(state, meter.id).at(-1) : undefined;
      const today = new Date().toISOString().slice(0, 10);
      const made: StoredSchedule[] = [];
      for (const s of STARTER_SCHEDULES) {
        if (keys && !keys.includes(s.key as StarterKey)) continue;
        if (has.has(normalize(s.name))) continue;
        const interval = starterInterval(s, meter);
        const row: StoredSchedule = {
          id: newId(),
          locationId: t.locationId,
          subject: { thingId: t.id },
          meterId: interval.everyUnits && meter ? meter.id : null,
          name: s.name,
          everyMonths: interval.everyMonths,
          everyUnits: interval.everyUnits,
          dueOn: null,
          leadDays: 14,
          leadUnits: null,
          anchorOn: today,
          anchorValue: interval.everyUnits && latest ? latest.value : null,
          snoozedUntil: null,
          snoozedUntilValue: null,
          skipNext: false,
          active: true,
          rowVersion: 1,
        };
        h.schedules.push(row);
        made.push(row);
      }
      // Nothing made (every name was there): no event, and so no undo (the server's shape).
      if (made.length === 0) return reply(201, { schedules: [] });
      const eventId = recordHouseholdEvent(state, {
        action: 'schedule.starter',
        entity: { type: 'thing', id: t.id },
        locationId: t.locationId,
        rootThingId: t.id,
        name: t.name ?? '',
        undo: () => {
          h.schedules = h.schedules.filter((s) => !made.includes(s));
        },
      });
      return reply(201, {
        schedules: made.map((s) => scheduleView(state, s)).filter(Boolean),
        undo: { eventId, until: new Date(Date.now() + 7 * 86_400_000).toISOString() },
      });
    }),
  ];
}
