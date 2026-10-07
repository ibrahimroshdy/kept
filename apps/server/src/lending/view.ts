import { LOAN_DIRECTIONS, type LoanDirection } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import {
  ATTACHMENT_SELECT,
  type AttachmentRow,
  type AttachmentView,
  attachmentViews,
} from '../files/views.js';
import {
  placeSubjectSql,
  type SubjectRef,
  SubjectRefSchema,
  subjectOf,
  thingSubjectSql,
} from '../schedules/view.js';
import type { FileStorage } from '../storage/blob-store.js';
import {
  ROW_COLUMNS,
  type RowRecord,
  rowOf,
  type ThingRow,
  ThingRowSchema,
} from '../things/view.js';

// The shapes of lending and borrowing (plan T10), in the web contract's words
// (apps/web/src/api/household/types.ts: PersonRef, Loan, LoanRow). Read as the caller on
// kept_app, so RLS decides what exists. A person is a name and whether they use Kept, never a
// contact detail (D57, D177). `overdue` is the location's own date past the due date (§7.13).

export type PersonRef = { id: string; name: string; isMember: boolean };

export type Loan = {
  id: string;
  thingId: string;
  direction: LoanDirection;
  person: PersonRef;
  startedAt: string;
  dueOn: string | null;
  returnedAt: string | null;
  overdue: boolean;
  quantity: string;
  splitFromThingId: string | null;
  returnPlace: SubjectRef | null;
  previousPlace: SubjectRef | null;
  notes: string | null;
  conditionOut: AttachmentView[];
  conditionIn: AttachmentView[];
  rowVersion: number;
  createdBy: { displayName: string };
};
export type LoanRow = Loan & { thing: ThingRow };

const Attachments = z.array(z.looseObject({ id: z.uuid() }));

export const LoanSchema = z.object({
  id: z.uuid(),
  thingId: z.uuid(),
  direction: z.enum(LOAN_DIRECTIONS),
  person: z.object({ id: z.uuid(), name: z.string(), isMember: z.boolean() }),
  startedAt: z.string(),
  dueOn: z.string().nullable(),
  returnedAt: z.string().nullable(),
  overdue: z.boolean(),
  quantity: z.string(),
  splitFromThingId: z.uuid().nullable(),
  returnPlace: SubjectRefSchema.nullable(),
  previousPlace: SubjectRefSchema.nullable(),
  notes: z.string().nullable(),
  conditionOut: Attachments,
  conditionIn: Attachments,
  rowVersion: z.number(),
  createdBy: z.object({ displayName: z.string() }),
});
export const LoanRowSchema = LoanSchema.extend({ thing: ThingRowSchema });

/** The raw columns of a loan (for writes, undo and the audit image). */
export type LoanRecord = {
  id: string;
  location_id: string;
  thing_id: string;
  direction: LoanDirection;
  person_id: string;
  started_at: Date;
  due_on: string | null;
  returned_at: Date | null;
  return_place_id: string | null;
  return_container_id: string | null;
  previous_place_id: string | null;
  previous_container_id: string | null;
  split_from_thing_id: string | null;
  lead_days: number;
  notes: string | null;
  created_by: string;
  row_version: number;
};

export const LOAN_COLUMNS = `o.id, o.location_id, o.thing_id, o.direction, o.person_id, o.started_at,
       o.due_on::text AS due_on, o.returned_at, o.return_place_id, o.return_container_id, o.previous_place_id,
       o.previous_container_id, o.split_from_thing_id, o.lead_days, o.notes, o.created_by,
       o.row_version`;

/** A loan's audit image (snake_case): what a write changes and an undo puts back. */
export const loanImage = (r: LoanRecord) => ({
  thing_id: r.thing_id,
  direction: r.direction,
  person_id: r.person_id,
  started_at: r.started_at,
  due_on: r.due_on,
  returned_at: r.returned_at,
  return_place_id: r.return_place_id,
  return_container_id: r.return_container_id,
  previous_place_id: r.previous_place_id,
  previous_container_id: r.previous_container_id,
  split_from_thing_id: r.split_from_thing_id,
  lead_days: r.lead_days,
  notes: r.notes,
});

/** `FROM` a loan `o`, with what its view needs. The caller adds WHERE and ORDER BY. */
export const LOAN_FROM = `
  FROM public.loans o
  JOIN public.locations l ON l.id = o.location_id
  JOIN public.things t ON t.id = o.thing_id
  LEFT JOIN public.people pe ON pe.id = o.person_id
  LEFT JOIN public.places rp ON rp.id = o.return_place_id
  LEFT JOIN public.things rc ON rc.id = o.return_container_id
  LEFT JOIN public.places pp ON pp.id = o.previous_place_id
  LEFT JOIN public.things pc ON pc.id = o.previous_container_id
  LEFT JOIN public.user_profiles up ON up.user_id = o.created_by`;

/** SQL: whether loan `o` is overdue on its location's own date (`l`). */
export const OVERDUE_SQL = `(o.returned_at IS NULL AND o.due_on IS NOT NULL
       AND (now() AT TIME ZONE l.timezone)::date > o.due_on)`;

export const LOAN_VIEW_COLUMNS = `${LOAN_COLUMNS},
       coalesce(pe.display_name, '') AS person_name, pe.member_user_id IS NOT NULL AS is_member,
       trim_scale(t.quantity)::text AS quantity, ${OVERDUE_SQL} AS overdue,
       up.display_name AS created_by_name,
       CASE WHEN rc.id IS NOT NULL THEN ${thingSubjectSql('rc')}
            WHEN rp.id IS NOT NULL THEN ${placeSubjectSql('rp')} END AS return_place,
       CASE WHEN pc.id IS NOT NULL THEN ${thingSubjectSql('pc')}
            WHEN pp.id IS NOT NULL THEN ${placeSubjectSql('pp')} END AS previous_place,
       -- A returned part that merged back (D172) is in the trash: its row is the one it joined.
       CASE WHEN t.deleted_at IS NOT NULL AND o.split_from_thing_id IS NOT NULL
            THEN o.split_from_thing_id ELSE o.thing_id END AS row_thing_id`;

type LoanViewRecord = LoanRecord & {
  person_name: string;
  is_member: boolean;
  quantity: string;
  overdue: boolean;
  created_by_name: string | null;
  return_place: unknown;
  previous_place: unknown;
  row_thing_id: string;
};

/** Views of loan rows read with LOAN_VIEW_COLUMNS, their condition photos read in one go. */
export async function loansOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  rows: readonly unknown[],
): Promise<Loan[]> {
  const loans = rows as LoanViewRecord[];
  if (loans.length === 0) return [];
  const { rows: attachments } = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT} WHERE a.loan_id = ANY ($1::uuid[]) ORDER BY a.sort, a.created_at, a.id`,
    [loans.map((o) => o.id)],
  );
  const views = await attachmentViews(client, files, attachments);
  const byLoan = new Map<string, AttachmentView[]>();
  attachments.forEach((a, i) => {
    const list = byLoan.get(a.loan_id as string) ?? [];
    list.push(views[i] as AttachmentView);
    byLoan.set(a.loan_id as string, list);
  });
  return loans.map((o) => {
    const photos = byLoan.get(o.id) ?? [];
    return {
      id: o.id,
      thingId: o.thing_id,
      direction: o.direction,
      person: { id: o.person_id, name: o.person_name, isMember: o.is_member },
      startedAt: o.started_at.toISOString(),
      dueOn: o.due_on,
      returnedAt: o.returned_at ? o.returned_at.toISOString() : null,
      overdue: o.overdue,
      quantity: o.quantity,
      splitFromThingId: o.split_from_thing_id,
      returnPlace: o.return_place ? subjectOf(o.return_place) : null,
      previousPlace: o.previous_place ? subjectOf(o.previous_place) : null,
      notes: o.notes,
      conditionOut: photos.filter((a) => a.role === 'condition_out'),
      conditionIn: photos.filter((a) => a.role === 'condition_in'),
      rowVersion: o.row_version,
      createdBy: { displayName: o.created_by_name ?? '' },
    };
  });
}

/** A thing's row whether or not it is in the trash (a part that merged back, D172). No thumbs. */
export async function anyRowsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  ids: readonly string[],
): Promise<Map<string, ThingRow>> {
  const out = new Map<string, ThingRow>();
  if (ids.length === 0) return out;
  const { rows } = await client.query<RowRecord>(
    `SELECT ${ROW_COLUMNS}
       FROM public.things t LEFT JOIN public.types ty ON ty.id = t.type_id
      WHERE t.id = ANY ($1::uuid[])`,
    [[...new Set(ids)]],
  );
  for (const r of rows) out.set(r.id, await rowOf(files, new Map(), r));
  return out;
}

/** LoanRows: each loan with its thing's row (for a merged part, the row it joined). */
export async function loanRowsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  rows: readonly unknown[],
): Promise<LoanRow[]> {
  const loans = await loansOf(client, files, rows);
  const things = await anyRowsOf(
    client,
    files,
    (rows as LoanViewRecord[]).map((o) => o.row_thing_id),
  );
  const out: LoanRow[] = [];
  (rows as LoanViewRecord[]).forEach((o, i) => {
    const thing = things.get(o.row_thing_id);
    if (thing) out.push({ ...(loans[i] as Loan), thing });
  });
  return out;
}

/** One loan's view (it exists: the caller checked). */
export async function loanView(
  client: pg.ClientBase,
  files: FileStorage | null,
  id: string,
): Promise<Loan> {
  const { rows } = await client.query(`SELECT ${LOAN_VIEW_COLUMNS} ${LOAN_FROM} WHERE o.id = $1`, [
    id,
  ]);
  const [view] = await loansOf(client, files, rows);
  return view as Loan;
}
