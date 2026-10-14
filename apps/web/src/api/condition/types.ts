/**
 * Condition reports' contract (1.x, D171, D235), after `apps/server/src/condition/service.ts`.
 *
 * A report is one move-in or move-out walk-through of a location on a day, room by room; each
 * room has how it was found, a note and dated photos (attachments, subject `{conditionRoomId}`,
 * role `photo`; `addedAt` is when Kept received the photo). Finishing it locks it (409 `conflict`
 * with `reason: 'report_finished'` after). Everyone who sees the location reads its reports;
 * members and above write them; owners and admins delete a finished one.
 */
import type { ConditionReportKind, RoomCondition } from '@kept/shared';
import type { AttachmentView } from '../inventory/types';

export type { ConditionReportKind, RoomCondition };

type Person = { displayName: string };

export type ConditionReportRow = {
  id: string;
  locationId: string;
  kind: ConditionReportKind;
  /** `YYYY-MM-DD`, the location's day of the walk-through. */
  heldOn: string;
  notes: string | null;
  createdBy: Person;
  createdAt: string;
  finishedAt: string | null;
  finishedBy: Person | null;
  roomCount: number;
  photoCount: number;
  rowVersion: number;
};

export type ConditionPhoto = AttachmentView & { addedAt: string };

export type ConditionRoom = {
  id: string;
  reportId: string;
  placeId: string | null;
  name: string;
  condition: RoomCondition | null;
  note: string | null;
  sort: number;
  photos: ConditionPhoto[];
  rowVersion: number;
};

export type ConditionReport = ConditionReportRow & {
  /** The location's time zone, for photo times and the finished time. */
  timezone: string;
  rooms: ConditionRoom[];
  /** The location's reports of the other kind, newest first: what this one compares with. */
  others: { id: string; kind: ConditionReportKind; heldOn: string; finishedAt: string | null }[];
};

/** GET /api/v1/condition-reports. */
export type ConditionReportsParams = {
  locationId?: string;
  kind?: ConditionReportKind;
  state?: 'open' | 'finished';
  limit?: number;
  cursor?: string;
};

/** POST /api/v1/locations/:id/condition-reports. */
export type CreateConditionReportBody = {
  id?: string;
  kind: ConditionReportKind;
  heldOn: string;
  notes?: string;
};
/** PATCH /api/v1/condition-reports/:id (If-Match). */
export type UpdateConditionReportBody = {
  kind?: ConditionReportKind;
  heldOn?: string;
  notes?: string | null;
};
/** POST /api/v1/condition-reports/:id/rooms: a place of the location, or a name. */
export type CreateConditionRoomBody = { id?: string; placeId?: string; name?: string };
/** PATCH /api/v1/condition-rooms/:id (If-Match). */
export type UpdateConditionRoomBody = {
  name?: string;
  condition?: RoomCondition | null;
  note?: string | null;
  sort?: number;
};

/** POST /api/v1/reports/condition → 202 {id, status, expiresAt}; poll with reportsApi.run. */
export type ConditionPdfBody = {
  reportId: string;
  compareWith?: string;
  include?: { photos?: boolean };
  locale?: 'en' | 'ar';
  digits?: 'western' | 'eastern';
};
