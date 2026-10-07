import {
  ACTIVE_SOURCE_TYPES,
  type ActiveSourceType,
  type AgendaState,
  can,
  type OccurrenceKind,
  type Role,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { pageOf } from '../http/conventions.js';
import { invalid } from '../http/errors.js';
import { type SubjectRef, subjectRefSql } from '../paperwork/view.js';
import { type AgendaCounts, type AgendaItem, WRITER_ACTIONS } from './view.js';

// The agenda (plan T13; Q7, Q24; engineering spec §7.13): every reminder source as one list,
// read from public.agenda_items (0053), the view the reminder scan (T14), the Schedules screen's
// `next` (T11) and Home's counts read too, so a count always equals the list it opens.
//
// - The view decides what exists: security_invoker, so row-level security shows only the caller's
//   locations, and its WHERE pauses a source whose module is off, whose subject is in the trash
//   or ended, a superseded document, an inactive schedule and a returned loan (§7.6, D162).
// - "Today" is each location's own date (the view's `loc.today`), so a Cairo location at 23:30
//   local on its due day still reads `due`.
// - An ended warranty (`expired`) isn't actionable (Q7) and is left out of the lists and counts.
// - Order: overdue, due, expiring, upcoming; then the due day (a reading-only due point last);
//   then the key.
// - `counts` are over everything the filters other than `state` and the cursor leave, so each
//   state's count is the length of the list that state opens.

/**
 * The sources the agenda lists and Home counts when none is asked for: every built one but low
 * stock, which has its own list (Consumables) and Home row (`lowStock`), so a low thing isn't
 * counted twice. It still reminds (the scan reads the view whole), and `sourceType=stock` asks
 * for it (the assistant's `upcoming` low_stock).
 */
export const LISTED_SOURCES = ACTIVE_SOURCE_TYPES.filter((s) => s !== 'stock');

/** Sources, comma-separated (`schedule,document`), or repeated. */
const Sources = z
  .union([z.string(), z.array(z.string())])
  .transform((v) =>
    [v]
      .flat()
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.enum(ACTIVE_SOURCE_TYPES)).max(ACTIVE_SOURCE_TYPES.length));

export const AgendaQuery = z.object({
  state: z.enum(['due', 'overdue', 'expiring', 'upcoming']).optional(),
  sourceType: Sources.optional(),
  locationId: z.uuid().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});
export type AgendaQuery = z.infer<typeof AgendaQuery>;

type Row = {
  key: string;
  source_type: ActiveSourceType;
  source_id: string;
  kind: OccurrenceKind;
  state: AgendaState;
  location_id: string;
  subject: SubjectRef | null;
  title: string;
  due_on: string | null;
  due_value: string | null;
  unit: string | null;
  sev: number;
  due_key: string;
};

type Key = [number, string, string];
const KeySchema = z.tuple([z.number().int(), z.string().max(10), z.string().max(300)]);

/** The rows the filters (not `state`, not the cursor) leave, as a CTE `items`. */
function itemsCte(q: AgendaQuery, values: unknown[]): string {
  const add = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where = [`a.state <> 'expired'`];
  where.push(
    `a.source_type = ANY (${add(q.sourceType?.length ? q.sourceType : LISTED_SOURCES)}::text[])`,
  );
  if (q.locationId) where.push(`a.location_id = ${add(q.locationId.toLowerCase())}::uuid`);
  if (q.from) where.push(`a.due_on IS NOT NULL AND a.due_on >= ${add(q.from)}::date`);
  if (q.to) where.push(`(a.due_on IS NULL OR a.due_on <= ${add(q.to)}::date)`);
  return `items AS (
    SELECT a.source_type, a.source_id, a.kind, a.state, a.location_id, a.thing_id, a.place_id,
           a.due_on::text AS due_on, a.due_value::text AS due_value, m.unit,
           CASE a.source_type
             WHEN 'warranty' THEN coalesce(a.title, w.kind)
             WHEN 'registration' THEN coalesce(a.title, w.kind)
             WHEN 'document' THEN coalesce(a.title, d.kind)
             WHEN 'loan' THEN coalesce(t.name, '')
             WHEN 'thing_expiry' THEN coalesce(t.name, '')
             WHEN 'stock' THEN coalesce(t.name, '')
             ELSE coalesce(a.title, '') END AS title,
           CASE a.state WHEN 'overdue' THEN 0 WHEN 'due' THEN 1 WHEN 'expiring' THEN 2 ELSE 3 END
             AS sev,
           coalesce(a.due_on::text, '9999-12-31') AS due_key,
           a.source_type || ':' || a.source_id || ':' || a.kind || ':' || a.due_period AS key
      FROM public.agenda_items a
      LEFT JOIN public.warranties w
        ON a.source_type IN ('warranty', 'registration') AND w.id = a.source_id
      LEFT JOIN public.expiring_documents d ON a.source_type = 'document' AND d.id = a.source_id
      LEFT JOIN public.things t ON t.id = a.thing_id
      LEFT JOIN public.meters m ON m.id = a.meter_id
     WHERE ${where.join(' AND ')})`;
}

/** The counts of the rows the filters leave (Home's rows and the Expiring screen's tabs). */
export async function agendaCounts(
  client: pg.ClientBase,
  q: Omit<AgendaQuery, 'state'>,
): Promise<AgendaCounts> {
  const values: unknown[] = [];
  const { rows } = await client.query<AgendaCounts>(
    `WITH ${itemsCte(q, values)}
     SELECT count(*) FILTER (WHERE state = 'overdue')::int AS overdue,
            count(*) FILTER (WHERE state = 'due')::int AS due,
            count(*) FILTER (WHERE state = 'expiring')::int AS expiring
       FROM items`,
    values,
  );
  return rows[0] ?? { overdue: 0, due: 0, expiring: 0 };
}

/** Per state, the count of each source (Home: whether a row's items are all schedules). One read
 * of the view, without the title joins a count doesn't need (step-4 perf: each read of
 * agenda_items costs about 95 ms at 10,000 things, docs/perf/2026-09-30-step4.md). */
export async function agendaCountsBySource(
  client: pg.ClientBase,
): Promise<Record<'overdue' | 'due' | 'expiring', Partial<Record<ActiveSourceType, number>>>> {
  const { rows } = await client.query<{ state: string; source_type: ActiveSourceType; n: number }>(
    `SELECT a.state, a.source_type, count(*)::int AS n FROM public.agenda_items a
      WHERE a.state IN ('overdue', 'due', 'expiring') AND a.source_type = ANY ($1::text[])
      GROUP BY a.state, a.source_type ORDER BY a.state, a.source_type`,
    [LISTED_SOURCES],
  );
  const out = { overdue: {}, due: {}, expiring: {} } as Record<
    'overdue' | 'due' | 'expiring',
    Partial<Record<ActiveSourceType, number>>
  >;
  for (const r of rows) out[r.state as 'overdue' | 'due' | 'expiring'][r.source_type] = r.n;
  return out;
}

/** The caller's role in each location they belong to (actions are by role). */
async function roles(client: pg.ClientBase): Promise<Map<string, Role>> {
  const { rows } = await client.query<{ location_id: string; role: Role }>(
    `SELECT m.location_id, m.role FROM public.memberships m
      WHERE m.user_id = kept.current_user_id()
        AND (m.expires_at IS NULL OR m.expires_at > now())`,
  );
  return new Map(rows.map((r) => [r.location_id, r.role]));
}

/** Who may act on a source's row: Complete and Snooze manage schedules; Renew and Mark returned
 * edit things (roles.ts). A viewer only opens it. */
const ACTION_RIGHT = {
  schedule: 'schedules-claims.manage',
  document: 'things.edit',
  loan: 'things.edit',
} as const;

function actionsFor(source: ActiveSourceType, role: Role | undefined) {
  const right = ACTION_RIGHT[source as keyof typeof ACTION_RIGHT];
  if (!right) return [...WRITER_ACTIONS[source]];
  return role && can(role, right) ? [...WRITER_ACTIONS[source]] : ['open' as const];
}

export async function listAgenda(
  client: pg.ClientBase,
  q: AgendaQuery,
  page: { limit: number; after: unknown },
): Promise<{ items: AgendaItem[]; counts: AgendaCounts; next_cursor: string | null }> {
  let after: Key | null = null;
  if (page.after !== null) {
    const parsed = KeySchema.safeParse(page.after);
    if (!parsed.success) throw invalid('The cursor is not valid; start again from the first page.');
    after = parsed.data;
  }
  // One read of the view for the counts and the page (the step-5 perf fix: the view is the cost,
  // and two reads were twice it): the counts' row, joined to the page's rows, or to none.
  const values: unknown[] = [];
  const cte = itemsCte(q, values);
  const add = (v: unknown) => {
    values.push(v);
    return `$${values.length}`;
  };
  const where: string[] = [];
  if (q.state) where.push(`i.state = ${add(q.state)}::text`);
  if (after) {
    where.push(
      `(i.sev, i.due_key COLLATE "C", i.key COLLATE "C")
        > (${add(after[0])}::int, ${add(after[1])}::text, ${add(after[2])}::text)`,
    );
  }
  const { rows: joined } = await client.query<
    Partial<Row> & { overdue: number; due: number; expiring: number }
  >(
    `WITH ${cte},
     counts AS (
       SELECT count(*) FILTER (WHERE state = 'overdue')::int AS overdue,
              count(*) FILTER (WHERE state = 'due')::int AS due,
              count(*) FILTER (WHERE state = 'expiring')::int AS expiring
         FROM items),
     page AS (
       SELECT i.key, i.source_type, i.source_id, i.kind, i.state, i.location_id, i.title,
              i.due_on, i.due_value, i.unit, i.sev, i.due_key,
              ${subjectRefSql('i.thing_id', 'i.place_id', 'i.location_id')} AS subject
         FROM items i
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY i.sev, i.due_key COLLATE "C", i.key COLLATE "C"
        LIMIT ${add(page.limit + 1)})
     SELECT c.overdue, c.due, c.expiring, p.*
       FROM counts c LEFT JOIN page p ON true
      ORDER BY p.sev, p.due_key COLLATE "C", p.key COLLATE "C"`,
    values,
  );
  const first = joined[0];
  const counts: AgendaCounts = {
    overdue: first?.overdue ?? 0,
    due: first?.due ?? 0,
    expiring: first?.expiring ?? 0,
  };
  const rows = joined.filter((r): r is Row & typeof r => typeof r.key === 'string');
  const paged = pageOf(rows, page.limit, (r): Key => [r.sev, r.due_key, r.key]);
  const role = await roles(client);
  const items = paged.items.flatMap((r): AgendaItem[] =>
    r.subject
      ? [
          {
            key: r.key,
            sourceType: r.source_type,
            sourceId: r.source_id,
            kind: r.kind,
            state: r.state,
            locationId: r.location_id,
            subject: r.subject,
            title: r.title,
            dueOn: r.due_on,
            dueValue: r.due_value,
            unit: r.unit,
            actions: actionsFor(r.source_type, role.get(r.location_id)),
          },
        ]
      : [],
  );
  return { items, counts, next_cursor: paged.next_cursor };
}
