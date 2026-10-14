/**
 * Mock handlers for condition reports (1.x, D235), after apps/server/src/condition: a report
 * starts with the location's room places; rooms and their photos change until it is finished
 * (then 409 `report_finished`); viewers read, members write, owners and admins delete a finished
 * one. Photos are step 2's mock attachments with subject `{conditionRoomId}`. The PDF is a run
 * on the inventory report's mock (`GET /reports/:id`).
 */
import { newId } from '@kept/shared';
import { accessOf } from '../inventory/mock/db';
import { queueReportRun } from '../inventory/mock/reports';
import type { MockState } from '../mock/fixtures';
import { err, forbidden, type MockRoute, notFound, reply, route } from '../mock/kit';
import { conditionPaths as p } from './paths';
import type {
  ConditionPdfBody,
  ConditionPhoto,
  ConditionReport,
  ConditionReportRow,
  ConditionRoom,
  CreateConditionReportBody,
  CreateConditionRoomBody,
  UpdateConditionReportBody,
  UpdateConditionRoomBody,
} from './types';

type StoredRoom = Omit<ConditionRoom, 'photos'>;
type StoredReport = Omit<ConditionReportRow, 'roomCount' | 'photoCount'> & { rooms: StoredRoom[] };

const stores = new WeakMap<MockState, StoredReport[]>();
const storeOf = (state: MockState) => {
  let s = stores.get(state);
  if (!s) {
    s = [];
    stores.set(state, s);
  }
  return s;
};

/** For tests: a report as it would be stored. */
export function seedConditionReport(state: MockState, report: StoredReport): void {
  storeOf(state).push(report);
}

const finished = () =>
  err(
    409,
    'conflict',
    'This conflicts with a change already made.',
    'This report is finished, so it can’t change. Start a new one, or ask an owner or admin to delete it.',
    { reason: 'report_finished' },
  );

const stale = (rowVersion: number) =>
  err(412, 'precondition_failed', 'This changed since you loaded it.', undefined, {
    row_version: rowVersion,
  });

export function conditionMockRoutes(state: MockState): MockRoute[] {
  const reports = () => storeOf(state);
  const access = () => accessOf(state);
  const photosOf = (roomId: string): ConditionPhoto[] =>
    state.inventory.attachments
      .filter((a) => 'conditionRoomId' in a.subject && a.subject.conditionRoomId === roomId)
      .map(({ locationId: _l, ...a }) => ({ ...a, addedAt: new Date().toISOString() }));
  const rowOf = (r: StoredReport): ConditionReportRow => {
    const { rooms, ...row } = r;
    return {
      ...row,
      roomCount: rooms.length,
      photoCount: rooms.reduce((n, x) => n + photosOf(x.id).length, 0),
    };
  };
  const viewOf = (r: StoredReport): ConditionReport => ({
    ...rowOf(r),
    timezone: state.locations.find((l) => l.id === r.locationId)?.timezone ?? 'UTC',
    rooms: r.rooms.map((x) => ({ ...x, photos: photosOf(x.id) })),
    others: reports()
      .filter((o) => o.locationId === r.locationId && o.kind !== r.kind)
      .sort((a, b) => b.heldOn.localeCompare(a.heldOn))
      .map((o) => ({ id: o.id, kind: o.kind, heldOn: o.heldOn, finishedAt: o.finishedAt })),
  });
  const find = (id: string) => {
    const r = reports().find((x) => x.id === id);
    return r && access().visible(r.locationId) ? r : null;
  };
  const roomOf = (id: string) => {
    for (const r of reports()) {
      const room = r.rooms.find((x) => x.id === id);
      if (room && access().visible(r.locationId)) return { report: r, room };
    }
    return null;
  };
  const me = () => ({ displayName: state.me.user.displayName });
  const version = (headers: Record<string, string>) =>
    Number((headers['if-match'] ?? '').replace(/"/g, ''));

  return [
    route('GET', p.reports, ({ query }) => {
      const loc = query.get('locationId');
      const kind = query.get('kind');
      const st = query.get('state');
      const items = reports()
        .filter((r) => access().visible(r.locationId))
        .filter((r) => !loc || r.locationId === loc)
        .filter((r) => !kind || r.kind === kind)
        .filter((r) => !st || (r.finishedAt !== null) === (st === 'finished'))
        .sort((a, b) => b.heldOn.localeCompare(a.heldOn))
        .map(rowOf);
      return { items, next_cursor: null };
    }),

    route('GET', p.report(':id'), ({ params }) => {
      const r = find(params.id ?? '');
      return r ? viewOf(r) : notFound();
    }),

    route('POST', p.locationReports(':id'), ({ params, body }) => {
      const locationId = params.id ?? '';
      if (!access().visible(locationId)) return notFound();
      if (!access().canWrite(locationId)) return forbidden();
      const b = body as CreateConditionReportBody;
      const id = b.id ?? newId();
      const places = state.inventory.places
        .filter((x) => x.locationId === locationId && !x.deletedAt && !x.isUnplaced)
        .sort((a, b) => a.sort - b.sort);
      const rooms = places.filter((x) => x.kindKey === 'room');
      const report: StoredReport = {
        id,
        locationId,
        kind: b.kind,
        heldOn: b.heldOn,
        notes: b.notes?.trim() || null,
        createdBy: me(),
        createdAt: new Date().toISOString(),
        finishedAt: null,
        finishedBy: null,
        rowVersion: 1,
        rooms: (rooms.length ? rooms : places.filter((x) => !x.parentId)).map((x, i) => ({
          id: newId(),
          reportId: id,
          placeId: x.id,
          name: x.name,
          condition: null,
          note: null,
          sort: i + 1,
          rowVersion: 1,
        })),
      };
      reports().push(report);
      return reply(201, viewOf(report));
    }),

    route('PATCH', p.report(':id'), ({ params, body, headers }) => {
      const r = find(params.id ?? '');
      if (!r) return notFound();
      if (!access().canWrite(r.locationId)) return forbidden();
      if (r.finishedAt) return finished();
      if (version(headers) !== r.rowVersion) return stale(r.rowVersion);
      const b = body as UpdateConditionReportBody;
      if (b.kind) r.kind = b.kind;
      if (b.heldOn) r.heldOn = b.heldOn;
      if (b.notes !== undefined) r.notes = b.notes?.trim() || null;
      r.rowVersion += 1;
      return viewOf(r);
    }),

    route('POST', p.finish(':id'), ({ params, headers }) => {
      const r = find(params.id ?? '');
      if (!r) return notFound();
      if (!access().canWrite(r.locationId)) return forbidden();
      if (r.finishedAt) return finished();
      if (version(headers) !== r.rowVersion) return stale(r.rowVersion);
      r.finishedAt = new Date().toISOString();
      r.finishedBy = me();
      r.rowVersion += 1;
      return viewOf(r);
    }),

    route('DELETE', p.report(':id'), ({ params }) => {
      const r = find(params.id ?? '');
      if (!r) return notFound();
      if (!access().canWrite(r.locationId)) return forbidden();
      if (r.finishedAt && !access().isAdmin(r.locationId)) return forbidden();
      stores.set(
        state,
        reports().filter((x) => x.id !== r.id),
      );
      return reply(204);
    }),

    route('POST', p.rooms(':id'), ({ params, body }) => {
      const r = find(params.id ?? '');
      if (!r) return notFound();
      if (!access().canWrite(r.locationId)) return forbidden();
      if (r.finishedAt) return finished();
      const b = body as CreateConditionRoomBody;
      const place = b.placeId ? state.inventory.places.find((x) => x.id === b.placeId) : null;
      if (b.placeId && r.rooms.some((x) => x.placeId === b.placeId))
        return err(409, 'conflict', 'This conflicts with a change already made.');
      const room: StoredRoom = {
        id: b.id ?? newId(),
        reportId: r.id,
        placeId: place?.id ?? null,
        name: b.name?.trim() || place?.name || '',
        condition: null,
        note: null,
        sort: r.rooms.length + 1,
        rowVersion: 1,
      };
      r.rooms.push(room);
      return reply(201, { ...room, photos: [] });
    }),

    route('PATCH', p.room(':id'), ({ params, body, headers }) => {
      const found = roomOf(params.id ?? '');
      if (!found) return notFound();
      const { report, room } = found;
      if (!access().canWrite(report.locationId)) return forbidden();
      if (report.finishedAt) return finished();
      if (version(headers) !== room.rowVersion) return stale(room.rowVersion);
      const b = body as UpdateConditionRoomBody;
      if (b.name) room.name = b.name.trim();
      if (b.condition !== undefined) room.condition = b.condition;
      if (b.note !== undefined) room.note = b.note?.trim() || null;
      if (b.sort !== undefined) room.sort = b.sort;
      room.rowVersion += 1;
      return { ...room, photos: photosOf(room.id) };
    }),

    route('DELETE', p.room(':id'), ({ params }) => {
      const found = roomOf(params.id ?? '');
      if (!found) return notFound();
      const { report, room } = found;
      if (!access().canWrite(report.locationId)) return forbidden();
      if (report.finishedAt) return finished();
      report.rooms = report.rooms.filter((x) => x.id !== room.id);
      return reply(204);
    }),

    route('POST', p.pdf, ({ body }) => {
      const b = body as ConditionPdfBody;
      const r = find(b.reportId);
      if (!r) return notFound();
      if (b.compareWith && find(b.compareWith)?.locationId !== r.locationId) return notFound();
      const photos = r.rooms.reduce((n, x) => n + photosOf(x.id).length, 0);
      return reply(202, queueReportRun(state, { locationId: r.locationId }, photos));
    }),
  ];
}
