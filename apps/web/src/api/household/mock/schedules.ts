/**
 * Mock handlers for schedules and service records (T11; D29, D39, D52, D162; Q1, Q2, Q28).
 * "Every N units and/or M months, whichever first", or a one-off date; completion through a
 * service record, which re-anchors the schedule; snooze to a date or a reading (replacing the due
 * point); skip once. `next` comes from the agenda's computation (db.ts `scheduleNextOf`), so a list
 * and its count agree. Service records are core; `completes` needs Schedules on.
 */
import { liveThing, paginate, versionError } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { householdPaths as p } from '../paths';
import type {
  CompleteScheduleBody,
  CreateScheduleBody,
  CreateServiceRecordBody,
  Schedule,
  ServiceRecord,
  SnoozeBody,
  UpdateScheduleBody,
  UpdateServiceRecordBody,
} from '../types';
import {
  ensureSeeded,
  gateFor,
  hh,
  listLocations,
  locOf,
  newId,
  recordHouseholdEvent,
  resolveSubject,
  scheduleView,
  serviceRecordView,
  todayIn,
} from './db';
import type { ScheduleSubject, StoredSchedule, StoredServiceRecord } from './state';

const invalid = (hint: string) => err(400, 'validation', 'The request is not valid.', hint);

export function schedulesRoutes(state: MockState): MockRoute[] {
  const h = () => hh(state);
  const me = () => state.me.user;
  const views = (rows: StoredSchedule[]) =>
    rows.map((s) => scheduleView(state, s)).filter((s): s is Schedule => s !== null);
  const records = (rows: StoredServiceRecord[]) =>
    rows.map((r) => serviceRecordView(state, r)).filter((r): r is ServiceRecord => r !== null);
  const subjectKey = (s: ScheduleSubject) => ('thingId' in s ? s.thingId : s.placeId);
  const rootOf = (s: ScheduleSubject) => ('thingId' in s ? s.thingId : null);

  /** The schedule's re-anchor after a completing service (T6's trigger; D162). */
  const reanchor = (s: StoredSchedule) => {
    const last = h()
      .serviceRecords.filter((r) => r.completes.some((c) => c.scheduleId === s.id))
      .sort((a, b) => b.servicedOn.localeCompare(a.servicedOn))[0];
    if (last) {
      s.anchorOn = last.servicedOn;
      if (last.reading) s.anchorValue = last.reading.value;
    }
    s.snoozedUntil = null;
    s.snoozedUntilValue = null;
    s.skipNext = false;
  };

  const withSchedule = (
    id: string | undefined,
    headers: Record<string, string>,
    fn: (s: StoredSchedule) => unknown,
  ) => {
    const s = h().schedules.find((x) => x.id === id);
    if (!s || !resolveSubject(state, s.subject)) return notFound();
    const gated = gateFor(state, s.locationId, 'schedules', 'write');
    if (gated) return gated;
    const stale = versionError(headers, s);
    if (stale) return reply(stale.status, stale.body);
    return fn(s);
  };

  /** A write that changes a schedule's due point: audited and undoable (D150). */
  const change = (s: StoredSchedule, action: string, mutate: () => void) => {
    const before = { ...s };
    mutate();
    s.rowVersion += 1;
    recordHouseholdEvent(state, {
      action,
      entity: { type: 'schedule', id: s.id },
      locationId: s.locationId,
      rootThingId: rootOf(s.subject),
      name: s.name,
      undo: () => Object.assign(s, before, { rowVersion: s.rowVersion + 1 }),
    });
    return scheduleView(state, s);
  };

  const newRecord = (
    b: Omit<CreateServiceRecordBody, 'subject'> & { subject: ScheduleSubject },
    locationId: string,
  ): StoredServiceRecord => {
    const vendor = b.vendor
      ? 'id' in b.vendor
        ? state.inventory.vendors.find((v) => v.id === (b.vendor as { id: string }).id)
        : { id: newId(), name: b.vendor.name }
      : undefined;
    const currency = b.currency ?? locOf(state, locationId)?.currency ?? 'EGP';
    return {
      id: b.id ?? newId(),
      locationId,
      subject: b.subject,
      servicedOn: b.servicedOn,
      reading: b.reading ? { id: newId(), value: b.reading.value, unit: '' } : null,
      vendor: vendor ? { id: vendor.id, name: vendor.name } : null,
      total: b.total ? { amount: b.total, currency } : null,
      lines: (b.lines ?? []).map((l) => ({
        id: newId(),
        kind: l.kind,
        description: l.description,
        quantity: l.quantity ?? null,
        unitCost: l.unitCost ? { amount: l.unitCost, currency } : null,
      })),
      completes: (b.completes ?? []).flatMap((id) => {
        const s = h().schedules.find((x) => x.id === id);
        return s ? [{ scheduleId: s.id, name: s.name }] : [];
      }),
      notes: b.notes ?? null,
      invoices: [],
      loggedBy: { displayName: me().displayName },
      loggedById: me().id,
      rowVersion: 1,
    };
  };

  return [
    // The Schedules screen: global, module `schedules` per row's location.
    route('GET', p.schedules, ({ query }) => {
      ensureSeeded(state);
      const allowed = listLocations(state, 'schedules');
      const loc = query.get('locationId');
      const want = query.get('state');
      const subjectType = query.get('subjectType');
      const q = query.get('q')?.trim().toLowerCase();
      const all = views(
        h().schedules.filter(
          (s) => s.active && allowed.has(s.locationId) && (!loc || s.locationId === loc),
        ),
      );
      const counts = {
        due: all.filter((s) => s.next.state === 'due').length,
        overdue: all.filter((s) => s.next.state === 'overdue').length,
      };
      const RANK = { overdue: 0, due: 1, upcoming: 2 } as const;
      const items = all
        .filter(
          (s) =>
            (!want || s.next.state === want) &&
            (!subjectType || s.subject.type === subjectType) &&
            (!q || s.name.toLowerCase().includes(q) || s.subject.name.toLowerCase().includes(q)),
        )
        .sort(
          (a, b) =>
            RANK[a.next.state] - RANK[b.next.state] ||
            (a.next.dueOn ?? '9999').localeCompare(b.next.dueOn ?? '9999'),
        );
      return { ...paginate(items, query, 20), counts };
    }),
    route('GET', p.thingSchedules(':id'), ({ params }) => {
      ensureSeeded(state);
      const t = liveThing(state.inventory, params.id ?? null);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, 'schedules', 'read');
      if (gated) return gated;
      return {
        items: views(
          h().schedules.filter((s) => 'thingId' in s.subject && s.subject.thingId === t.id),
        ),
      };
    }),
    route('GET', p.placeSchedules(':id'), ({ params }) => {
      ensureSeeded(state);
      const at = resolveSubject(state, { placeId: params.id ?? '' });
      if (!at) return notFound();
      const gated = gateFor(state, at.locationId, 'schedules', 'read');
      if (gated) return gated;
      return {
        items: views(
          h().schedules.filter((s) => 'placeId' in s.subject && s.subject.placeId === params.id),
        ),
      };
    }),
    route('POST', p.schedules, ({ body }) => {
      ensureSeeded(state);
      const b = body as CreateScheduleBody;
      const at = resolveSubject(state, b.subject);
      if (!at) return notFound();
      const gated = gateFor(state, at.locationId, 'schedules', 'write');
      if (gated) return gated;
      if (b.everyMonths == null && b.everyUnits == null && b.dueOn == null)
        return err(
          400,
          'schedule_interval_required',
          'Set how often: every so many months or units, or a date.',
        );
      if (!b.name?.trim()) return invalid('name: required');
      if (b.everyUnits != null && !b.meterId) return invalid('meterId: required with everyUnits');
      const t = 'thingId' in b.subject ? liveThing(state.inventory, b.subject.thingId) : undefined;
      const meter = t?.meters.find((m) => m.id === b.meterId);
      const row: StoredSchedule = {
        id: b.id ?? newId(),
        locationId: at.locationId,
        subject: b.subject,
        meterId: b.meterId ?? null,
        name: b.name.trim(),
        everyMonths: b.everyMonths ?? null,
        everyUnits: b.everyUnits ?? null,
        dueOn: b.dueOn ?? null,
        leadDays: b.leadDays ?? 14,
        leadUnits: b.leadUnits ?? (b.everyUnits != null ? String(Number(b.everyUnits) / 10) : null),
        anchorOn: b.anchorOn ?? todayIn(state, at.locationId),
        anchorValue: b.anchorValue ?? meter?.latest?.value ?? null,
        snoozedUntil: null,
        snoozedUntilValue: null,
        skipNext: false,
        active: true,
        rowVersion: 1,
      };
      h().schedules.push(row);
      recordHouseholdEvent(state, {
        action: 'schedule.create',
        entity: { type: 'schedule', id: row.id },
        locationId: row.locationId,
        rootThingId: rootOf(row.subject),
        name: row.name,
      });
      return reply(201, scheduleView(state, row));
    }),
    route('PATCH', p.schedule(':id'), ({ params, body, headers }) =>
      withSchedule(params.id, headers, (s) =>
        change(s, 'schedule.update', () => Object.assign(s, body as UpdateScheduleBody)),
      ),
    ),
    route('DELETE', p.schedule(':id'), ({ params, headers }) =>
      withSchedule(params.id, headers, (s) => {
        h().schedules = h().schedules.filter((x) => x !== s);
        recordHouseholdEvent(state, {
          action: 'schedule.delete',
          entity: { type: 'schedule', id: s.id },
          locationId: s.locationId,
          rootThingId: rootOf(s.subject),
          name: s.name,
          undo: () => {
            h().schedules.push(s);
          },
        });
        return reply(204);
      }),
    ),
    route('POST', p.scheduleComplete(':id'), ({ params, body, headers }) =>
      withSchedule(params.id, headers, (s) => {
        const b = (body ?? {}) as CompleteScheduleBody;
        const servicedOn = b.servicedOn ?? todayIn(state, s.locationId);
        if (servicedOn > todayIn(state, s.locationId))
          return invalid('servicedOn: not in the future');
        const record = newRecord(
          {
            subject: s.subject,
            servicedOn,
            ...(b.reading && s.meterId
              ? { reading: { meterId: s.meterId, value: b.reading.value } }
              : {}),
            ...(b.vendor ? { vendor: b.vendor } : {}),
            ...(b.total ? { total: b.total } : {}),
            ...(b.currency ? { currency: b.currency } : {}),
            ...(b.notes ? { notes: b.notes } : {}),
            completes: [s.id],
          },
          s.locationId,
        );
        const before = { ...s };
        h().serviceRecords.push(record);
        reanchor(s);
        s.rowVersion += 1;
        recordHouseholdEvent(state, {
          action: 'service_record.create',
          entity: { type: 'service_record', id: record.id },
          locationId: s.locationId,
          rootThingId: rootOf(s.subject),
          name: s.name,
          // Undo deletes the record (and its reading); the anchor falls back.
          undo: () => {
            h().serviceRecords = h().serviceRecords.filter((r) => r !== record);
            Object.assign(s, before, { rowVersion: s.rowVersion + 1 });
          },
        });
        return {
          serviceRecord: serviceRecordView(state, record),
          schedule: scheduleView(state, s),
        };
      }),
    ),
    route('POST', p.scheduleSnooze(':id'), ({ params, body, headers }) =>
      withSchedule(params.id, headers, (s) => {
        const b = body as SnoozeBody;
        return change(s, 'schedule.snooze', () => {
          if ('untilDate' in b) s.snoozedUntil = b.untilDate;
          else s.snoozedUntilValue = b.untilValue;
        });
      }),
    ),
    route('POST', p.scheduleSkip(':id'), ({ params, headers }) =>
      withSchedule(params.id, headers, (s) => {
        if (s.everyMonths == null && s.everyUnits == null)
          return invalid('A one-off date has no interval to skip.');
        return change(s, 'schedule.skip', () => {
          s.skipNext = true;
        });
      }),
    ),
    route('POST', p.scheduleUnsnooze(':id'), ({ params, headers }) =>
      withSchedule(params.id, headers, (s) =>
        change(s, 'schedule.unsnooze', () => {
          s.snoozedUntil = null;
          s.snoozedUntilValue = null;
        }),
      ),
    ),

    // ----- service records (core; D113) -----
    route('GET', p.thingServiceRecords(':id'), ({ params, query }) => {
      ensureSeeded(state);
      const t = liveThing(state.inventory, params.id ?? null);
      if (!t) return notFound();
      const gated = gateFor(state, t.locationId, null, 'read');
      if (gated) return gated;
      const rows = h()
        .serviceRecords.filter((r) => subjectKey(r.subject) === t.id)
        .sort((a, b) => b.servicedOn.localeCompare(a.servicedOn));
      return paginate(records(rows), query, 20);
    }),
    route('GET', p.placeServiceRecords(':id'), ({ params, query }) => {
      ensureSeeded(state);
      const at = resolveSubject(state, { placeId: params.id ?? '' });
      if (!at) return notFound();
      const gated = gateFor(state, at.locationId, null, 'read');
      if (gated) return gated;
      const rows = h()
        .serviceRecords.filter((r) => subjectKey(r.subject) === params.id)
        .sort((a, b) => b.servicedOn.localeCompare(a.servicedOn));
      return paginate(records(rows), query, 20);
    }),
    route('POST', p.serviceRecords, ({ body }) => {
      ensureSeeded(state);
      const b = body as CreateServiceRecordBody;
      const at = resolveSubject(state, b.subject);
      if (!at) return notFound();
      const gated = gateFor(state, at.locationId, null, 'write');
      if (gated) return gated;
      if ((b.completes?.length ?? 0) > 0) {
        const off = gateFor(state, at.locationId, 'schedules', 'write');
        if (off) return off;
      }
      if (!b.servicedOn || b.servicedOn > todayIn(state, at.locationId))
        return invalid('servicedOn: a date, not in the future');
      if ((b.lines?.length ?? 0) > 50) return invalid('lines: at most 50');
      const record = newRecord(b, at.locationId);
      h().serviceRecords.push(record);
      const completed = h().schedules.filter((s) => b.completes?.includes(s.id));
      const befores = completed.map((s) => ({ ...s }));
      for (const s of completed) {
        reanchor(s);
        s.rowVersion += 1;
      }
      recordHouseholdEvent(state, {
        action: 'service_record.create',
        entity: { type: 'service_record', id: record.id },
        locationId: at.locationId,
        rootThingId: rootOf(b.subject),
        name: at.ref.name,
        undo: () => {
          h().serviceRecords = h().serviceRecords.filter((r) => r !== record);
          for (const [i, s] of completed.entries())
            Object.assign(s, befores[i], { rowVersion: s.rowVersion + 1 });
        },
      });
      return reply(201, serviceRecordView(state, record));
    }),
    route('PATCH', p.serviceRecord(':id'), ({ params, body, headers }) => {
      const r = h().serviceRecords.find((x) => x.id === params.id);
      if (!r) return notFound();
      const gated = gateFor(state, r.locationId, null, 'write');
      if (gated) return gated;
      // logs.edit-own for your own; logs.edit-delete-others (owner, admin) for anyone's.
      const role = locOf(state, r.locationId)?.role;
      if (r.loggedById !== me().id && role !== 'owner' && role !== 'admin')
        return err(403, 'forbidden', "You don't have permission.");
      const stale = versionError(headers, r);
      if (stale) return reply(stale.status, stale.body);
      const b = body as UpdateServiceRecordBody;
      const before = { ...r };
      if (b.servicedOn !== undefined) r.servicedOn = b.servicedOn;
      if (b.notes !== undefined) r.notes = b.notes;
      if (b.total !== undefined)
        r.total = { amount: b.total, currency: b.currency ?? r.total?.currency ?? 'EGP' };
      r.rowVersion += 1;
      recordHouseholdEvent(state, {
        action: 'service_record.update',
        entity: { type: 'service_record', id: r.id },
        locationId: r.locationId,
        rootThingId: rootOf(r.subject),
        name: resolveSubject(state, r.subject)?.ref.name ?? '',
        undo: () => Object.assign(r, before, { rowVersion: r.rowVersion + 1 }),
      });
      return serviceRecordView(state, r);
    }),
    route('DELETE', p.serviceRecord(':id'), ({ params, headers }) => {
      const r = h().serviceRecords.find((x) => x.id === params.id);
      if (!r) return notFound();
      const gated = gateFor(state, r.locationId, null, 'write');
      if (gated) return gated;
      const role = locOf(state, r.locationId)?.role;
      if (r.loggedById !== me().id && role !== 'owner' && role !== 'admin')
        return err(403, 'forbidden', "You don't have permission.");
      const stale = versionError(headers, r);
      if (stale) return reply(stale.status, stale.body);
      h().serviceRecords = h().serviceRecords.filter((x) => x !== r);
      const completed = h().schedules.filter((s) => r.completes.some((c) => c.scheduleId === s.id));
      const befores = completed.map((s) => ({ ...s }));
      for (const s of completed) {
        reanchor(s);
        s.rowVersion += 1;
      }
      recordHouseholdEvent(state, {
        action: 'service_record.delete',
        entity: { type: 'service_record', id: r.id },
        locationId: r.locationId,
        rootThingId: rootOf(r.subject),
        name: resolveSubject(state, r.subject)?.ref.name ?? '',
        undo: () => {
          h().serviceRecords.push(r);
          for (const [i, s] of completed.entries())
            Object.assign(s, befores[i], { rowVersion: s.rowVersion + 1 });
        },
      });
      return reply(204);
    }),
  ];
}
