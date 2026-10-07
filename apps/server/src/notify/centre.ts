import {
  ACTIVE_SOURCE_TYPES,
  type ActiveSourceType,
  NOTIFICATION_KINDS,
  type NotificationKind,
  OCCURRENCE_KINDS,
  OCCURRENCE_STATES,
  type OccurrenceKind,
  type OccurrenceState,
  ROLES,
  type Role,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { AGENDA_ACTIONS, WRITER_ACTIONS } from '../agenda/view.js';
import type { KeptApp } from '../http/app.js';
import { encodeCursor, type PageRequest, paginate, paginationQuery } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import type { InventoryDeps } from '../http/routes.js';
import { scopedRead, scopedWrite } from '../http/write.js';
import { type SubjectRef, SubjectRefSchema, subjectRefSql } from '../paperwork/view.js';
import { COMPLETED_SINCE, READ_SINCE } from '../reminders/scan.js';

// The notification centre (plan T16; D39; screens frame 7; the web contract's "the notification
// centre (T16)" in apps/web/src/api/household/types.ts):
//
// GET  /api/v1/notifications?unread&kind&locationId&cursor&limit → {items, unread, next_cursor}
// GET  /api/v1/notifications/count → {unread}                      (the bell)
// POST /api/v1/notifications/read {ids (≤ 200)} | {all: true} → {unread}
//
// Everything is read as the caller on kept_app: 0055's policy gives them their own notifications
// while they still see the location, so a notice of a location they left disappears. A reminder
// is shown as it is now: its subject re-read (null-safe when the thing went to the trash), and its
// state the occurrence's, or `done`/`cancelled` at once when its source was completed or removed
// since the last scan (so Mark returned and a re-read agree without waiting 15 minutes). Only an
// open reminder has actions (the agenda's, agenda/view.ts WRITER_ACTIONS), and only a writer of
// its location gets more than `open`; each
// action is the source's own route (complete, snooze, return, renew), never duplicated here (Q32).
// Marking read is the person's own bookkeeping: not audited (route catalogue ALLOWLIST).

const AI_SCOPES = [
  'instance',
  'instance_account',
  'account',
  'location',
  'member',
  'user',
] as const;

/** What an `export_ready` notice is about: a claim pack or insurance report (step 4), or a Kept
 * export, of a location or of the person's own data (step 7: the export run's `kind`). */
const EXPORT_READY_KINDS = ['claim_pack', 'insurance_report', 'location', 'me'] as const;

export const NotificationSchema = z.object({
  id: z.uuid(),
  kind: z.enum(NOTIFICATION_KINDS),
  createdAt: z.string(),
  readAt: z.string().nullable(),
  locationId: z.uuid().nullable(),
  reminder: z
    .object({
      occurrenceId: z.uuid(),
      sourceType: z.enum(ACTIVE_SOURCE_TYPES),
      sourceId: z.uuid(),
      kind: z.enum(OCCURRENCE_KINDS),
      dueOn: z.string().nullable(),
      dueValue: z.string().nullable(),
      state: z.enum(OCCURRENCE_STATES),
      subject: SubjectRefSchema,
      title: z.string(),
      actions: z.array(z.enum(AGENDA_ACTIONS)),
    })
    .optional(),
  membership: z
    .object({ userName: z.string(), role: z.enum(ROLES), locationName: z.string() })
    .optional(),
  aiCap: z
    .object({
      scope: z.enum(AI_SCOPES),
      level: z.union([z.literal(80), z.literal(100)]),
      month: z.string(),
    })
    .optional(),
  exportReady: z.object({ runId: z.uuid(), kind: z.enum(EXPORT_READY_KINDS) }).optional(),
});
export type Notification = z.infer<typeof NotificationSchema>;

const Unread = z.object({ unread: z.number().int() });

const flag = z
  .enum(['1', 'true', '0', 'false'])
  .transform((v) => v === '1' || v === 'true')
  .optional();

const ListQuery = paginationQuery.extend({
  unread: flag,
  kind: z.enum(NOTIFICATION_KINDS).optional(),
  locationId: z.uuid().optional(),
});

const ReadBody = z
  .object({
    ids: z.array(z.uuid()).min(1).max(200).optional(),
    all: z.literal(true).optional(),
  })
  .refine((b) => (b.ids === undefined) !== (b.all === undefined), {
    message: 'ids (at most 200) or all: true',
  });

type Row = {
  id: string;
  kind: NotificationKind;
  created_at: Date;
  at: string;
  read_at: Date | null;
  location_id: string | null;
  payload: Record<string, unknown>;
  location_name: string | null;
  writer: boolean;
  occurrence_id: string | null;
  source_type: ActiveSourceType | null;
  source_id: string | null;
  occ_kind: OccurrenceKind | null;
  due_on: string | null;
  due_value: string | null;
  occ_state: OccurrenceState | null;
  subject: SubjectRef | null;
  title: string | null;
};

/**
 * An open occurrence's state now: `done` when its source was completed since it was written (a
 * loan returned, a document renewed, a warranty registered, a confirmed service completing the
 * schedule logged or confirmed after it, a newer reading for a stale one), `cancelled` when the
 * source is gone or its thing left use; otherwise the stored state. Read as the caller, so a
 * source they can't see counts as gone. The scan closes them the same way (reminders/scan.ts).
 */
const LIVE_STATE = `CASE WHEN o.state <> 'open' THEN o.state
  WHEN o.source_type = 'loan' THEN coalesce(
    (SELECT CASE WHEN l.returned_at IS NULL THEN 'open' ELSE 'done' END
       FROM public.loans l WHERE l.id = o.source_id), 'cancelled')
  WHEN o.source_type = 'document' THEN coalesce(
    (SELECT CASE WHEN d.superseded_by_id IS NULL THEN 'open' ELSE 'done' END
       FROM public.expiring_documents d WHERE d.id = o.source_id), 'cancelled')
  WHEN o.source_type = 'registration' THEN coalesce(
    (SELECT CASE WHEN w.registered THEN 'done' ELSE 'open' END
       FROM public.warranties w WHERE w.id = o.source_id), 'cancelled')
  WHEN o.source_type = 'warranty' THEN coalesce(
    (SELECT 'open' FROM public.warranties w WHERE w.id = o.source_id), 'cancelled')
  WHEN o.source_type = 'schedule' THEN coalesce(
    (SELECT CASE WHEN EXISTS (
              SELECT 1 FROM public.service_completions c
                JOIN public.service_records r ON r.id = c.service_record_id
               WHERE c.schedule_id = s.id AND ${COMPLETED_SINCE})
            THEN 'done' ELSE 'open' END
       FROM public.schedules s WHERE s.id = o.source_id), 'cancelled')
  WHEN o.source_type = 'reading_stale' THEN coalesce(
    (SELECT CASE WHEN ${READ_SINCE} THEN 'done' ELSE 'open' END
       FROM public.meters m JOIN public.things t ON t.id = m.thing_id
      WHERE m.id = o.source_id AND m.nudge_days IS NOT NULL
        AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'), 'cancelled')
  WHEN o.source_type = 'stock' THEN coalesce(
    (SELECT CASE WHEN t.quantity < r.min_quantity THEN 'open' ELSE 'done' END
       FROM public.stock_rules r JOIN public.things t ON t.id = r.thing_id
      WHERE r.id = o.source_id AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'), 'cancelled')
  WHEN o.source_type = 'thing_expiry' THEN coalesce(
    (SELECT 'open' FROM public.things t
      WHERE t.id = o.source_id AND t.deleted_at IS NULL AND t.lifecycle = 'in_use'), 'cancelled')
  ELSE o.state END`;

/** A reminder's own words: the schedule's name, the warranty's provider or kind, the document's
 * title or kind, a stale reading's meter label (or ''), the thing's name for a loan or an expiry
 * (the agenda's `title`). */
const TITLE = `CASE o.source_type
  WHEN 'schedule' THEN (SELECT s.name FROM public.schedules s WHERE s.id = o.source_id)
  WHEN 'warranty' THEN (SELECT coalesce(w.provider, w.kind) FROM public.warranties w WHERE w.id = o.source_id)
  WHEN 'registration' THEN (SELECT coalesce(w.provider, w.kind) FROM public.warranties w WHERE w.id = o.source_id)
  WHEN 'document' THEN (SELECT coalesce(d.title, d.kind) FROM public.expiring_documents d WHERE d.id = o.source_id)
  WHEN 'reading_stale' THEN (SELECT coalesce(m.label, '') FROM public.meters m WHERE m.id = o.source_id)
  ELSE (SELECT coalesce(t.name, '') FROM public.things t WHERE t.id = o.thing_id) END`;

const COLUMNS = `n.id, n.kind, n.created_at, n.created_at::text AS at, n.read_at, n.location_id,
  n.payload, l.name AS location_name,
  n.location_id IS NOT NULL AND n.location_id IN (SELECT kept.writable_location_ids()) AS writer,
  o.id AS occurrence_id, o.source_type, o.source_id, o.kind AS occ_kind,
  o.due_on::text AS due_on,
  CASE WHEN o.due_period LIKE 'meter:%' THEN substr(o.due_period, 7) END AS due_value,
  ${LIVE_STATE} AS occ_state,
  CASE WHEN o.id IS NOT NULL THEN ${subjectRefSql('o.thing_id', 'o.place_id', 'o.location_id')} END AS subject,
  CASE WHEN o.id IS NOT NULL THEN ${TITLE} END AS title`;

const text = (v: unknown) => (typeof v === 'string' ? v : '');

function viewOf(r: Row): Notification {
  const base: Notification = {
    id: r.id,
    kind: r.kind,
    createdAt: r.created_at.toISOString(),
    readAt: r.read_at?.toISOString() ?? null,
    locationId: r.location_id,
  };
  const p = r.payload ?? {};
  if (r.kind === 'reminder' && r.occurrence_id && r.source_type && r.source_id && r.occ_kind) {
    const state = r.occ_state ?? 'open';
    const subject: SubjectRef = r.subject ?? {
      type: 'location',
      id: r.location_id ?? r.occurrence_id,
      name: r.location_name ?? '',
      path: '',
    };
    return {
      ...base,
      reminder: {
        occurrenceId: r.occurrence_id,
        sourceType: r.source_type,
        sourceId: r.source_id,
        kind: r.occ_kind,
        dueOn: r.due_on,
        dueValue: r.due_value,
        state,
        subject,
        title: r.title ?? '',
        actions: state !== 'open' ? [] : r.writer ? [...WRITER_ACTIONS[r.source_type]] : ['open'],
      },
    };
  }
  if (r.kind === 'membership_added' || r.kind === 'membership_ended') {
    const role = ROLES.includes(p.role as Role) ? (p.role as Role) : 'member';
    return {
      ...base,
      membership: { userName: text(p.userName), role, locationName: r.location_name ?? '' },
    };
  }
  if (r.kind === 'ai_cap') {
    const scope = AI_SCOPES.find((s) => s === p.scope);
    const level = p.level === 100 ? 100 : p.level === 80 ? 80 : null;
    if (scope && level) return { ...base, aiCap: { scope, level, month: text(p.month) } };
    return base;
  }
  if (r.kind === 'export_ready') {
    const kind = EXPORT_READY_KINDS.find((k) => k === p.kind) ?? null;
    const runId = text(p.runId);
    if (kind && z.uuid().safeParse(runId).success) return { ...base, exportReady: { runId, kind } };
  }
  return base;
}

/** The caller's unread count, as the bell shows it (0055's policy: their own, where they see
 * the location). */
export async function unreadCount(client: pg.ClientBase): Promise<number> {
  const { rows } = await client.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM public.notifications WHERE read_at IS NULL',
  );
  return rows[0]?.n ?? 0;
}

type Cursor = [string, string];

/** One page of the caller's notifications, newest first. */
export async function listNotifications(
  client: pg.ClientBase,
  q: {
    unread?: boolean | undefined;
    kind?: NotificationKind | undefined;
    locationId?: string | undefined;
  },
  page: PageRequest<Cursor>,
): Promise<{ items: Notification[]; unread: number; next_cursor: string | null }> {
  const after = page.after;
  if (
    after !== null &&
    (!Array.isArray(after) || typeof after[0] !== 'string' || !z.uuid().safeParse(after[1]).success)
  ) {
    throw invalid('The cursor is not valid; start again from the first page.');
  }
  const { rows } = await client.query<Row>(
    `SELECT ${COLUMNS}
       FROM public.notifications n
       LEFT JOIN public.locations l ON l.id = n.location_id
       LEFT JOIN public.reminder_occurrences o ON o.id = n.occurrence_id
      WHERE ($1::boolean IS NOT TRUE OR n.read_at IS NULL)
        AND ($2::text IS NULL OR n.kind = $2)
        AND ($3::uuid IS NULL OR n.location_id = $3)
        AND ($4::timestamptz IS NULL OR (n.created_at, n.id) < ($4::timestamptz, $5::uuid))
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $6`,
    [
      q.unread ?? null,
      q.kind ?? null,
      q.locationId ?? null,
      after?.[0] ?? null,
      after?.[1] ?? null,
      page.limit + 1,
    ],
  );
  const items = rows.slice(0, page.limit);
  const last = rows.length > page.limit ? items.at(-1) : undefined;
  return {
    items: items.map(viewOf),
    unread: await unreadCount(client),
    next_cursor: last ? encodeCursor([last.at, last.id]) : null,
  };
}

/** Marks some (or all) of the caller's notifications read; returns what's left unread. */
export async function markRead(
  client: pg.ClientBase,
  body: { ids?: string[] | undefined; all?: true | undefined },
): Promise<number> {
  await client.query(
    `UPDATE public.notifications SET read_at = now()
      WHERE read_at IS NULL AND ($1::boolean OR id = ANY($2::uuid[]))`,
    [body.all === true, body.ids ?? []],
  );
  return unreadCount(client);
}

export async function centreRoutes(app: KeptApp, deps: InventoryDeps): Promise<void> {
  const { pools } = deps;

  app.get(
    '/api/v1/notifications',
    {
      schema: {
        querystring: ListQuery,
        response: {
          200: z.object({
            items: z.array(NotificationSchema),
            unread: z.number().int(),
            next_cursor: z.string().nullable(),
          }),
        },
      },
    },
    (req) => {
      const page = paginate<Cursor>(req.query);
      return scopedRead(pools, req, (_tx, client) => listNotifications(client, req.query, page));
    },
  );

  app.get('/api/v1/notifications/count', { schema: { response: { 200: Unread } } }, (req) =>
    scopedRead(pools, req, async (_tx, client) => ({ unread: await unreadCount(client) })),
  );

  // Not audited: a read receipt is the person's own bookkeeping (route catalogue ALLOWLIST).
  app.post(
    '/api/v1/notifications/read',
    { schema: { body: ReadBody, response: { 200: Unread } } },
    (req, reply) =>
      scopedWrite(pools, req, reply, async (_tx, client) => ({
        status: 200,
        body: { unread: await markRead(client, req.body) },
      })),
  );
}
