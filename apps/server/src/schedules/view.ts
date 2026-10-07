import {
  canonicalAmount,
  reconcileTotal,
  SERVICE_LINE_KINDS,
  type ServiceLineKind,
} from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import {
  ATTACHMENT_SELECT,
  type AttachmentRow,
  type AttachmentView,
  attachmentViews,
  MONEY_ROLES,
} from '../files/views.js';
import type { Gate } from '../serialize/gates.js';
import {
  placeSubjectJson,
  type SubjectRef,
  SubjectRefSchema,
  thingSubjectJson,
} from '../serialize/subject.js';
import type { FileStorage } from '../storage/blob-store.js';

// The shapes of schedules and service records (plan T11), in the web contract's words
// (apps/web/src/api/household/types.ts: SubjectRef, Schedule, ServiceRecord). Everything is read
// as the caller on kept_app, so RLS decides what exists. A schedule's `next` comes from SQL
// (kept.schedule_next(), the function the agenda view calls; never recomputed here), so a list,
// its count and the reminder scan agree. Money (a service's total, a line's cost) leaves only
// through the location's gate: hidden, it is `{moneyHidden: true}`, whether or not there was one.

// ---------------------------------------------------------------------------------------------
// SubjectRef: what a record is about (a thing, a place, or a location), with where it is
// ---------------------------------------------------------------------------------------------

export { type SubjectRef, SubjectRefSchema };

const locationName = (loc: string) => `(SELECT l.name FROM public.locations l WHERE l.id = ${loc})`;

/** SQL: the SubjectRef (jsonb) of the thing aliased `t`. */
export const thingSubjectSql = (t: string) => thingSubjectJson(t, locationName(`${t}.location_id`));

/** SQL: the SubjectRef (jsonb) of the place aliased `p`: its location and the places above it. */
export const placeSubjectSql = (p: string) => placeSubjectJson(p, locationName(`${p}.location_id`));

/** SQL: the SubjectRef of a thing-or-place row, over `LEFT JOIN things t … LEFT JOIN places p`. */
export const subjectSql = (t = 't', p = 'p') =>
  `CASE WHEN ${t}.id IS NOT NULL THEN ${thingSubjectSql(t)} ELSE ${placeSubjectSql(p)} END`;

/** A jsonb subject as the contract has it (the path of a top-level thing is just the location). */
export function subjectOf(raw: unknown): SubjectRef {
  const s = raw as SubjectRef;
  return {
    type: s.type,
    id: s.id,
    name: s.name ?? '',
    path: s.path ?? '',
    shortCode: s.shortCode ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

export type GatedMoney = { amount: string; currency: string } | { moneyHidden: true };

export const GatedMoneySchema = z.union([
  z.object({ amount: z.string(), currency: z.string() }),
  z.object({ moneyHidden: z.literal(true) }),
]);

/** An amount through the gate: hidden is `{moneyHidden: true}` whether or not there was one. */
export function gatedMoney(
  gate: Gate,
  amount: string | null,
  currency: string | null,
): GatedMoney | null {
  if (!gate.showMoney) return { moneyHidden: true };
  if (amount === null || currency === null) return null;
  return { amount: canonicalAmount(amount) as string, currency };
}

// ---------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------

export type ScheduleState = 'upcoming' | 'due' | 'overdue';
/** Which rule the schedule has (the web's wording): both intervals, one of them, or a date. */
export type ScheduleBasis = 'months' | 'units' | 'both' | 'once';

export type Schedule = {
  id: string;
  locationId: string;
  subject: SubjectRef;
  name: string;
  everyMonths: number | null;
  everyUnits: string | null;
  meter: { id: string; label: string; unit: string } | null;
  dueOn: string | null;
  leadDays: number;
  leadUnits: string | null;
  anchorOn: string;
  anchorValue: string | null;
  next: {
    dueOn: string | null;
    dueValue: string | null;
    state: ScheduleState;
    basis: ScheduleBasis;
  };
  snoozedUntil: string | null;
  snoozedUntilValue: string | null;
  skipNext: boolean;
  active: boolean;
  lastService: { id: string; servicedOn: string } | null;
  rowVersion: number;
};

export const ScheduleSchema = z.object({
  id: z.uuid(),
  locationId: z.uuid(),
  subject: SubjectRefSchema,
  name: z.string(),
  everyMonths: z.number().nullable(),
  everyUnits: z.string().nullable(),
  meter: z.object({ id: z.uuid(), label: z.string(), unit: z.string() }).nullable(),
  dueOn: z.string().nullable(),
  leadDays: z.number(),
  leadUnits: z.string().nullable(),
  anchorOn: z.string(),
  anchorValue: z.string().nullable(),
  next: z.object({
    dueOn: z.string().nullable(),
    dueValue: z.string().nullable(),
    state: z.enum(['upcoming', 'due', 'overdue']),
    basis: z.enum(['months', 'units', 'both', 'once']),
  }),
  snoozedUntil: z.string().nullable(),
  snoozedUntilValue: z.string().nullable(),
  skipNext: z.boolean(),
  active: z.boolean(),
  lastService: z.object({ id: z.uuid(), servicedOn: z.string() }).nullable(),
  rowVersion: z.number(),
});

/** The raw columns of a schedule (for writes, undo and the audit image). */
export type ScheduleRow = {
  id: string;
  location_id: string;
  thing_id: string | null;
  place_id: string | null;
  name: string;
  every_months: number | null;
  every_units: string | null;
  meter_id: string | null;
  due_on: string | null;
  lead_days: number;
  lead_units: string | null;
  base_on: string;
  base_value: string | null;
  anchor_on: string;
  anchor_value: string | null;
  snoozed_until: string | null;
  snoozed_until_value: string | null;
  skip_next: boolean;
  active: boolean;
  created_by: string;
  row_version: number;
};

export const SCHEDULE_COLUMNS = `s.id, s.location_id, s.thing_id, s.place_id, s.name, s.every_months,
       trim_scale(s.every_units)::text AS every_units, s.meter_id, s.due_on::text AS due_on,
       s.lead_days, trim_scale(s.lead_units)::text AS lead_units, s.base_on::text AS base_on,
       trim_scale(s.base_value)::text AS base_value, s.anchor_on::text AS anchor_on,
       trim_scale(s.anchor_value)::text AS anchor_value, s.snoozed_until::text AS snoozed_until,
       trim_scale(s.snoozed_until_value)::text AS snoozed_until_value, s.skip_next, s.active,
       s.created_by, s.row_version`;

/** A schedule's audit image: what a write changes and an undo puts back (snake_case). */
export const scheduleImage = (r: ScheduleRow) => ({
  thing_id: r.thing_id,
  place_id: r.place_id,
  name: r.name,
  every_months: r.every_months,
  every_units: r.every_units,
  meter_id: r.meter_id,
  due_on: r.due_on,
  lead_days: r.lead_days,
  lead_units: r.lead_units,
  base_on: r.base_on,
  base_value: r.base_value,
  snoozed_until: r.snoozed_until,
  snoozed_until_value: r.snoozed_until_value,
  skip_next: r.skip_next,
  active: r.active,
});

type ScheduleRecord = ScheduleRow & {
  meter_label: string | null;
  meter_unit: string | null;
  next_due_on: string | null;
  next_due_value: string | null;
  next_state: ScheduleState;
  subject: unknown;
  last_service: { id: string; servicedOn: string } | null;
};

/**
 * `FROM` a schedule `s`, with what its view needs. `next` is `kept.schedule_next()` on the
 * location's own date (the function the agenda view calls). The caller adds WHERE and ORDER BY.
 */
export const SCHEDULE_FROM = `
  FROM public.schedules s
  JOIN public.locations l ON l.id = s.location_id
  LEFT JOIN public.meters m ON m.id = s.meter_id
  LEFT JOIN public.things t ON t.id = s.thing_id
  LEFT JOIN public.places p ON p.id = s.place_id
  CROSS JOIN LATERAL kept.schedule_next(s.id, (now() AT TIME ZONE l.timezone)::date) n`;

/** Where `next` comes from: `n` (kept.schedule_next()) by default, or an agenda row. */
export type NextSource = { dueOn: string; dueValue: string; state: string };
const NEXT_OF_N: NextSource = { dueOn: 'n.due_on', dueValue: 'n.due_value', state: 'n.state' };

export const scheduleViewColumns = (next: NextSource = NEXT_OF_N) => `${SCHEDULE_COLUMNS},
       coalesce(m.label, m.kind) AS meter_label, m.unit AS meter_unit,
       ${next.dueOn}::text AS next_due_on, trim_scale(${next.dueValue})::text AS next_due_value,
       ${next.state} AS next_state,
       ${subjectSql()} AS subject,
       (SELECT jsonb_build_object('id', r.id, 'servicedOn', r.serviced_on::text)
          FROM public.service_completions c
          JOIN public.service_records r ON r.id = c.service_record_id
         WHERE c.schedule_id = s.id
         ORDER BY r.serviced_on DESC, r.created_at DESC, r.id DESC LIMIT 1) AS last_service`;

function basisOf(r: ScheduleRow): ScheduleBasis {
  if (r.every_months !== null && r.every_units !== null) return 'both';
  if (r.every_months !== null) return 'months';
  if (r.every_units !== null) return 'units';
  return 'once';
}

function scheduleOf(r: ScheduleRecord): Schedule {
  return {
    id: r.id,
    locationId: r.location_id,
    subject: subjectOf(r.subject),
    name: r.name,
    everyMonths: r.every_months,
    everyUnits: r.every_units,
    meter:
      r.meter_id && r.meter_unit !== null
        ? { id: r.meter_id, label: r.meter_label ?? '', unit: r.meter_unit }
        : null,
    dueOn: r.due_on,
    leadDays: r.lead_days,
    leadUnits: r.lead_units,
    anchorOn: r.anchor_on,
    anchorValue: r.anchor_value,
    next: {
      dueOn: r.next_due_on,
      dueValue: r.next_due_value,
      state: r.next_state,
      basis: basisOf(r),
    },
    snoozedUntil: r.snoozed_until,
    snoozedUntilValue: r.snoozed_until_value,
    skipNext: r.skip_next,
    active: r.active,
    lastService: r.last_service,
    rowVersion: r.row_version,
  };
}

/** Schedules matching `where` (over `s`, `t`, `p`, `l`, `n`), in `order`. */
export async function schedulesWhere(
  client: pg.ClientBase,
  where: string,
  values: unknown[],
  order = 's.created_at, s.id',
): Promise<Schedule[]> {
  const { rows } = await client.query<ScheduleRecord>(
    `SELECT ${scheduleViewColumns()} ${SCHEDULE_FROM} WHERE ${where} ORDER BY ${order}`,
    values,
  );
  return rows.map(scheduleOf);
}

/** One schedule's view (it exists: the caller checked). */
export async function scheduleView(client: pg.ClientBase, id: string): Promise<Schedule> {
  const [view] = await schedulesWhere(client, 's.id = $1', [id]);
  return view as Schedule;
}

/** Views of rows already read with scheduleViewColumns(). */
export const schedulesOf = (rows: readonly unknown[]): Schedule[] =>
  (rows as ScheduleRecord[]).map(scheduleOf);

// ---------------------------------------------------------------------------------------------
// Service record
// ---------------------------------------------------------------------------------------------

export type ServiceLine = {
  id: string;
  kind: ServiceLineKind;
  description: string;
  quantity: string | null;
  unitCost: GatedMoney | null;
};

export type ServiceRecord = {
  id: string;
  subject: SubjectRef;
  servicedOn: string;
  reading: { id: string; value: string; unit: string } | null;
  vendor: { id: string; name: string } | null;
  total: GatedMoney | null;
  lines: ServiceLine[];
  completes: { scheduleId: string; name: string }[];
  notes: string | null;
  invoices: AttachmentView[];
  loggedBy: { displayName: string };
  rowVersion: number;
  /** Step 5 (Q12): a draft (an invoice read by AI) counts nowhere until it is confirmed. */
  reviewState: 'draft' | 'confirmed';
  /** `total_mismatch`: the priced lines and the total disagree by more than 1% (reconcileTotal);
   * `currency_unclear`: the invoice's currency mark maps to no enabled code (a bare `$`, D189),
   * so no currency is suggested. */
  flags: string[];
  /** Drafts only: what the invoice's read suggests, never applied (D19, D131). */
  suggestions?: ServiceSuggestion[];
  /** Drafts only: the latest read of the invoice. */
  extraction?: { id: string; status: string; statusReason?: string; pausedUntil?: string };
};

/** A suggestion read from a draft's invoice (step 5, T9/T10; web `ServiceSuggestion`). Money in
 * one (the total, the currency, a line's unit cost) is withheld where the gate hides money. */
export type ServiceSuggestion = {
  field: 'line' | 'vendor' | 'servicedOn' | 'total' | 'currency';
  value: unknown;
  confidence: number;
  source: { extractionId: string; attachmentId: string };
};

const ServiceSuggestionSchema = z.object({
  field: z.enum(['line', 'vendor', 'servicedOn', 'total', 'currency']),
  value: z.unknown(),
  confidence: z.number(),
  source: z.object({ extractionId: z.uuid(), attachmentId: z.uuid() }),
});

export const ServiceRecordSchema = z.object({
  id: z.uuid(),
  subject: SubjectRefSchema,
  servicedOn: z.string(),
  reading: z.object({ id: z.uuid(), value: z.string(), unit: z.string() }).nullable(),
  vendor: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  total: GatedMoneySchema.nullable(),
  lines: z.array(
    z.object({
      id: z.uuid(),
      kind: z.enum(SERVICE_LINE_KINDS),
      description: z.string(),
      quantity: z.string().nullable(),
      unitCost: GatedMoneySchema.nullable(),
    }),
  ),
  completes: z.array(z.object({ scheduleId: z.uuid(), name: z.string() })),
  notes: z.string().nullable(),
  // The attachment view (files/routes.ts's schema): checked there; passed through here.
  invoices: z.array(z.looseObject({ id: z.uuid() })),
  loggedBy: z.object({ displayName: z.string() }),
  rowVersion: z.number(),
  reviewState: z.enum(['draft', 'confirmed']),
  flags: z.array(z.string()),
  suggestions: z.array(ServiceSuggestionSchema).optional(),
  extraction: z
    .object({
      id: z.uuid(),
      status: z.string(),
      statusReason: z.string().optional(),
      pausedUntil: z.string().optional(),
    })
    .optional(),
});

export type ServiceRow = {
  id: string;
  location_id: string;
  thing_id: string | null;
  place_id: string | null;
  serviced_on: string;
  meter_reading_id: string | null;
  vendor_id: string | null;
  total: string | null;
  currency: string | null;
  notes: string | null;
  logged_by: string;
  row_version: number;
  review_state: 'draft' | 'confirmed';
};

export const SERVICE_COLUMNS = `r.id, r.location_id, r.thing_id, r.place_id,
       r.serviced_on::text AS serviced_on, r.meter_reading_id, r.vendor_id,
       trim_scale(r.total)::text AS total, r.currency::text AS currency, r.notes, r.logged_by,
       r.row_version, r.review_state`;

type ServiceRecordRow = ServiceRow & {
  subject: unknown;
  reading_value: string | null;
  reading_unit: string | null;
  vendor_name: string | null;
  logged_by_name: string | null;
  created_at: Date;
};

export const SERVICE_FROM = `
  FROM public.service_records r
  LEFT JOIN public.things t ON t.id = r.thing_id
  LEFT JOIN public.places p ON p.id = r.place_id
  LEFT JOIN public.meter_readings d ON d.id = r.meter_reading_id
  LEFT JOIN public.meters mm ON mm.id = d.meter_id
  LEFT JOIN public.vendors v ON v.id = r.vendor_id
  LEFT JOIN public.user_profiles up ON up.user_id = r.logged_by`;

export const SERVICE_VIEW_COLUMNS = `${SERVICE_COLUMNS}, ${subjectSql()} AS subject,
       trim_scale(d.value)::text AS reading_value, mm.unit AS reading_unit,
       v.name AS vendor_name, up.display_name AS logged_by_name, r.created_at`;

type LineRow = {
  id: string;
  service_record_id: string;
  kind: ServiceLineKind;
  description: string;
  quantity: string | null;
  unit_cost: string | null;
  sort: number;
};

/** Views of service rows read with SERVICE_VIEW_COLUMNS, their lines, completions and files read
 * in one go each. `gateOf` gives each row's location gate (money). */
export async function serviceRecordsOf(
  client: pg.ClientBase,
  files: FileStorage | null,
  gateOf: (locationId: string) => Promise<Gate>,
  rows: readonly unknown[],
): Promise<ServiceRecord[]> {
  const records = rows as ServiceRecordRow[];
  if (records.length === 0) return [];
  const ids = records.map((r) => r.id);
  // One query at a time: a pg client runs them in turn anyway (and warns when asked at once).
  const lines = await client.query<LineRow>(
    `SELECT id, service_record_id, kind, description, trim_scale(quantity)::text AS quantity,
              trim_scale(unit_cost)::text AS unit_cost, sort
         FROM public.service_lines WHERE service_record_id = ANY ($1::uuid[])
        ORDER BY sort, created_at, id`,
    [ids],
  );
  const completes = await client.query<{
    service_record_id: string;
    schedule_id: string;
    name: string;
  }>(
    `SELECT c.service_record_id, c.schedule_id, s.name
         FROM public.service_completions c JOIN public.schedules s ON s.id = c.schedule_id
        WHERE c.service_record_id = ANY ($1::uuid[])
        ORDER BY s.name, s.id`,
    [ids],
  );
  const attachments = await client.query<AttachmentRow>(
    `${ATTACHMENT_SELECT} WHERE a.service_record_id = ANY ($1::uuid[])
        ORDER BY a.sort, a.created_at, a.id`,
    [ids],
  );
  const reads = await draftReads(
    client,
    records.filter((r) => r.review_state === 'draft').map((r) => r.id),
  );
  const out: ServiceRecord[] = [];
  for (const r of records) {
    const gate = await gateOf(r.location_id);
    const ownLines = lines.rows.filter((l) => l.service_record_id === r.id);
    const flags: string[] = [];
    // A flag about amounts is money too: shown only where the amounts are.
    if (
      gate.showMoney &&
      reconcileTotal(
        r.total,
        ownLines.map((l) => ({ quantity: l.quantity, unitCost: l.unit_cost })),
      ).result === 'flag'
    ) {
      flags.push('total_mismatch');
    }
    const read = reads.get(r.id);
    // A read's flags are about its amounts and currency: money too.
    if (gate.showMoney) for (const f of read?.flags ?? []) if (!flags.includes(f)) flags.push(f);
    const mine = attachments.rows.filter(
      (a) =>
        a.service_record_id === r.id &&
        (gate.showMoney || !(MONEY_ROLES as readonly string[]).includes(a.role)),
    );
    out.push({
      id: r.id,
      subject: subjectOf(r.subject),
      servicedOn: r.serviced_on,
      reading:
        r.meter_reading_id && r.reading_value !== null
          ? { id: r.meter_reading_id, value: r.reading_value, unit: r.reading_unit ?? '' }
          : null,
      vendor: r.vendor_id ? { id: r.vendor_id, name: r.vendor_name ?? '' } : null,
      total: gatedMoney(gate, r.total, r.currency),
      lines: ownLines.map((l) => ({
        id: l.id,
        kind: l.kind,
        description: l.description,
        quantity: l.quantity,
        unitCost:
          l.unit_cost === null && gate.showMoney
            ? null
            : gatedMoney(gate, l.unit_cost, r.currency ?? null),
      })),
      completes: completes.rows
        .filter((c) => c.service_record_id === r.id)
        .map((c) => ({ scheduleId: c.schedule_id, name: c.name })),
      notes: r.notes,
      invoices: await attachmentViews(client, files, mine),
      loggedBy: { displayName: r.logged_by_name ?? '' },
      rowVersion: r.row_version,
      reviewState: r.review_state,
      flags,
      ...(r.review_state === 'draft'
        ? {
            suggestions: (read?.suggestions ?? []).flatMap((x) => gatedSuggestion(gate, x)),
            ...(read ? { extraction: read.extraction } : {}),
          }
        : {}),
    });
  }
  return out;
}

/** Suggestion fields that are money (D110): withheld, or a line's cost left out, behind the gate. */
const MONEY_SUGGESTIONS = new Set(['total', 'currency']);

function gatedSuggestion(gate: Gate, s: ServiceSuggestion): ServiceSuggestion[] {
  if (gate.showMoney) return [s];
  if (MONEY_SUGGESTIONS.has(s.field)) return [];
  if (s.field === 'line' && s.value && typeof s.value === 'object') {
    const { unitCost: _cost, lineTotal: _total, ...line } = s.value as Record<string, unknown>;
    return [{ ...s, value: line }];
  }
  return [s];
}

type DraftRead = {
  extraction: ServiceRecord['extraction'] & {};
  suggestions: ServiceSuggestion[];
  flags: string[];
};

/**
 * Each draft's latest invoice read (step 5, T9/T10): its status, and the suggestions and flags a
 * succeeded run left in `extractions.result` (extraction/apply.ts). A superseded attempt is
 * never the latest one shown.
 */
async function draftReads(
  client: pg.ClientBase,
  ids: readonly string[],
): Promise<Map<string, DraftRead>> {
  const out = new Map<string, DraftRead>();
  if (ids.length === 0) return out;
  const { rows } = await client.query<{
    service_record_id: string;
    id: string;
    status: string;
    status_reason: string | null;
    paused_until: Date | null;
    result: { suggestions?: ServiceSuggestion[]; flags?: string[] } | null;
  }>(
    `SELECT DISTINCT ON (e.service_record_id) e.service_record_id, e.id, e.status,
            e.status_reason, e.paused_until, e.result
       FROM public.extractions e
      WHERE e.service_record_id = ANY ($1::uuid[]) AND e.status <> 'superseded'
      ORDER BY e.service_record_id, e.created_at DESC, e.id DESC`,
    [ids],
  );
  for (const e of rows) {
    out.set(e.service_record_id, {
      extraction: {
        id: e.id,
        status: e.status,
        ...(e.status_reason ? { statusReason: e.status_reason } : {}),
        ...(e.paused_until ? { pausedUntil: e.paused_until.toISOString() } : {}),
      },
      suggestions: e.status === 'succeeded' ? (e.result?.suggestions ?? []) : [],
      flags: e.status === 'succeeded' ? (e.result?.flags ?? []) : [],
    });
  }
  return out;
}
