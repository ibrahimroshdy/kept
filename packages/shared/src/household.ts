/**
 * Household records (step 4): warranties and claims, loans, valuations, incidents, expiring
 * documents, service lines, reports and exports, and the pure date and schedule rules their SQL
 * twins must agree with (engineering spec §1.4–§1.7, §7.13; product design D53–D57, D141, D158).
 *
 * Every list here is a text column with a CHECK (D183, never a Postgres enum): the CHECK, the zod
 * schema and the web picker all read the list, so a value is added in one place. Dates are
 * `YYYY-MM-DD` strings, compared as strings; a day is a calendar day, never a timestamp.
 */

import { fromScaled, toScaled } from './decimal.js';
import { LEAD_DEFAULTS } from './reminders.js';

/** `warranties.kind` (D53). */
export const WARRANTY_KINDS = [
  'manufacturer',
  'extended',
  'store',
  'credit_card',
  'insurance',
] as const;
export type WarrantyKind = (typeof WARRANTY_KINDS)[number];

/** `claims.status` (D54). `in_repair` makes the thing read "at <service centre>". */
export const CLAIM_STATUSES = ['open', 'in_repair', 'resolved', 'rejected'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * The status changes a claim may make. A closed claim (resolved, rejected) reopens only through
 * undo (step-4 plan Q18), which the `claims_transition` trigger lets through.
 */
export const CLAIM_TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> =
  Object.freeze({
    open: ['in_repair', 'resolved', 'rejected'],
    in_repair: ['resolved', 'rejected', 'open'],
    resolved: [],
    rejected: [],
  });

/** The statuses that close a claim (`closed_on` is set exactly for these). */
export const CLOSED_CLAIM_STATUSES = [
  'resolved',
  'rejected',
] as const satisfies readonly ClaimStatus[];

export function canTransitionClaim(from: ClaimStatus, to: ClaimStatus): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

/** `loans.direction` (D56): lent out to someone, or borrowed in from someone. */
export const LOAN_DIRECTIONS = ['out', 'in'] as const;
export type LoanDirection = (typeof LOAN_DIRECTIONS)[number];

/** `valuations.source` (D158). */
export const VALUATION_SOURCES = ['purchase', 'appraisal', 'estimate', 'insurer'] as const;
export type ValuationSource = (typeof VALUATION_SOURCES)[number];

/** `incidents.kind` (D158). */
export const INCIDENT_KINDS = ['burglary', 'fire', 'flood', 'loss', 'other'] as const;
export type IncidentKind = (typeof INCIDENT_KINDS)[number];

/** `expiring_documents.kind` (§1.6, D155). `other` needs a title (Q31). */
export const DOCUMENT_KINDS = [
  'registration',
  'insurance',
  'licence',
  'inspection',
  'lease',
  'contract',
  'other',
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** `service_lines.kind` (§1.6). */
export const SERVICE_LINE_KINDS = ['part', 'labour', 'fluid', 'other'] as const;
export type ServiceLineKind = (typeof SERVICE_LINE_KINDS)[number];

/** `report_runs.kind` (D201): the inventory report, step 4's insurance report and step 5's vehicle
 * history report (Q17). */
export const REPORT_KINDS = ['inventory', 'insurance', 'vehicle_history'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

/** `export_runs.kind` (§1.10, D158): step 4's claim pack, and step 7's Kept export of one
 * location (`location`) or of the requester's Personal location with their own data (`me`, plan
 * Q14). The API's `scope` (portability.ts EXPORT_SCOPES) is the last two. */
export const EXPORT_RUN_KINDS = ['claim_pack', 'location', 'me'] as const;
export type ExportRunKind = (typeof EXPORT_RUN_KINDS)[number];

/** `export_runs.status`, as stored and as the API reports it: `expired` is set by the hourly
 * purge, and a `done` run already past its `expiresAt` is reported `expired` before the purge
 * reaches it. `cancelled`: stopped by its creator (step 7). */
export const EXPORT_RUN_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
  'expired',
] as const;
export type ExportRunStatus = (typeof EXPORT_RUN_STATUSES)[number];

/**
 * Bounds the CHECKs, the routes' zod schemas and the pickers share (step-4 plan T4–T7).
 * Lead times are days (or a meter's units) before the due point.
 */
export const HOUSEHOLD_LIMITS = Object.freeze({
  warrantyTermMonths: { min: 1, max: 600 },
  warrantyLeadDays: { min: 0, max: 365 },
  loanLeadDays: { min: 0, max: 60 },
  scheduleEveryMonths: { min: 1, max: 600 },
  scheduleLeadDays: { min: 0, max: 365 },
  documentLeadDays: { min: 0, max: 365 },
  providerLength: 120,
  claimContactLength: 300,
  referenceLength: 100,
  scheduleNameLength: 120,
  documentTitleLength: 120,
  serviceLineDescriptionLength: 300,
  /** The claim pack's link lives this long at most (Q19: §3.3's export retention). */
  claimPackLinkDays: 7,
});

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(iso: string): [number, number, number] {
  const m = DAY.exec(iso);
  if (!m) throw new RangeError(`Not a date: ${iso}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const isoOf = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Add `months` (may be negative) and clamp the day to the month's end (Q27):
 * `addMonthsClamped('2026-01-31', 1)` → `'2026-02-28'`. Postgres' `date + interval 'n months'`
 * does the same, so the SQL twins agree.
 */
export function addMonthsClamped(iso: string, months: number): string {
  const [y, m, d] = parts(iso);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return isoOf(ny, nm, Math.min(d, daysIn(ny, nm)));
}

/** Add `days` (may be negative) to a calendar date. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = parts(iso);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// ---------------------------------------------------------------------------------------------
// Warranties
// ---------------------------------------------------------------------------------------------

export type WarrantyTerm = {
  startsOn: string;
  endsOn?: string | null;
  termMonths?: number | null;
  lifetime?: boolean;
};

/**
 * The last day a warranty covers, inclusive (L2), or `'lifetime'`; null when it has neither an
 * end date nor a term. A term ends the day before the same day `termMonths` later: 24 months
 * from 2026-10-01 covers through 2028-09-30. The twin is `warranties.effective_ends_on`.
 */
export function warrantyEnds(w: WarrantyTerm): 'lifetime' | string | null {
  if (w.lifetime) return 'lifetime';
  if (w.endsOn) return w.endsOn;
  if (w.termMonths != null) return addDays(addMonthsClamped(w.startsOn, w.termMonths), -1);
  return null;
}

export type Coverage = {
  /** The warranty that covers longest, among those not yet ended; null when none covers. */
  longestId: string | null;
  /** Its last day, or `'lifetime'`; null when nothing covers any more. */
  coveredUntil: 'lifetime' | string | null;
  /** The earliest start among the warranties (the bar's left end); null for none. */
  boughtOn: string | null;
};

/**
 * The coverage bar (D195: bought → today → covered until). A warranty that starts later (an
 * extended one after the manufacturer's) still counts: it covers the thing from its start. Gaps
 * between warranties are not shown (inferred: the bar has one span). Ties go to the first given.
 */
export function coverage(
  warranties: readonly (WarrantyTerm & { id: string })[],
  today: string,
): Coverage {
  let boughtOn: string | null = null;
  let longestId: string | null = null;
  let coveredUntil: 'lifetime' | string | null = null;
  for (const w of warranties) {
    if (boughtOn === null || w.startsOn < boughtOn) boughtOn = w.startsOn;
    const end = warrantyEnds(w);
    if (end === null || (end !== 'lifetime' && end < today)) continue;
    const longer =
      coveredUntil === null ||
      (coveredUntil !== 'lifetime' && (end === 'lifetime' || end > coveredUntil));
    if (longer) {
      longestId = w.id;
      coveredUntil = end;
    }
  }
  return { longestId, coveredUntil, boughtOn };
}

// ---------------------------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------------------------

/** LEAD_DEFAULTS.schedule_units_ratio (10%) as an exact divisor of the interval. */
export const UNITS_LEAD_DIVISOR = 10n;

export type ScheduleRule = {
  /** Every N months, from `anchorOn`. */
  everyMonths?: number | null;
  /** Every N units of the schedule's meter, from `anchorValue` (a decimal string). */
  everyUnits?: string | null;
  /** A one-off date: set only when there is no interval (D146). */
  dueOn?: string | null;
  /** The last completion's date, else the schedule's creation date (D162). */
  anchorOn: string;
  /** The last completion's reading, else the reading when the schedule was made. Null reads as 0. */
  anchorValue?: string | null;
  snoozedUntil?: string | null;
  snoozedUntilValue?: string | null;
  skipNext?: boolean;
  /** Days before a date due point at which it becomes due (default 14, §3.4). */
  leadDays?: number | null;
  /** Units before a unit due point at which it becomes due (default 10% of `everyUnits`). */
  leadUnits?: string | null;
};

export type ScheduleState = 'upcoming' | 'due' | 'overdue';

export type ScheduleNext = {
  /** The date side's due day; null for a meter-only schedule, or a snooze by reading only. */
  dueOn: string | null;
  /** The unit side's due reading, canonical (at most 3 decimals); null without one. */
  dueValue: string | null;
  state: ScheduleState;
  /** The side that decides `state` ("whichever comes first"); the date side on a tie. */
  basis: 'date' | 'units';
  /** Step 5 (D52): the local date the meter is expected to reach the unit side's due-from reading
   * (`dueValue - leadUnits`), from `at.eta`; null without a unit side, a known rate, or when the
   * reading is already there. */
  estimatedOn: string | null;
  /** The estimate is what brings the schedule due first: labelled "estimated" everywhere. */
  estimated: boolean;
};

const SEVERITY: Record<ScheduleState, number> = { upcoming: 0, due: 1, overdue: 2 };

/**
 * The next due point of a schedule, and its state on `today` (the location's local date) with the
 * meter's newest accepted reading `latestValue` (D29, D52, D162; plan Q2, Q28).
 *
 * - The date side is `anchorOn` plus `everyMonths` (clamped, Q27), or the one-off `dueOn`. It is
 *   due from `leadDays` before, and overdue from the day after.
 * - The unit side is `anchorValue` plus `everyUnits`. It is due once the reading reaches
 *   `dueValue - leadUnits`, and overdue once it passes `dueValue`. No reading yet: upcoming (no
 *   estimate in step 4, Q2).
 * - "Whichever comes first": the more urgent side wins.
 * - `skipNext` moves an interval's due point one interval on (`anchor + 2 × interval`, counted
 *   from the anchor so month ends don't drift). A one-off has no interval to skip.
 * - A snooze replaces the whole due point: the date side becomes `snoozedUntil` and the unit side
 *   `snoozedUntilValue` (either may be absent), and neither has a lead, so a short snooze isn't
 *   due again at once (inferred: otherwise a snooze inside the lead would change nothing).
 * - Step 5's estimate (D52; step-5 plan T7, Q8): `at.eta(value)` answers the local date the meter
 *   is expected to reach `value` (the SQL's `kept.meter_eta`, the one implementation; null when
 *   unknown). The unit side's due-from reading gives `estimatedOn`; from that day an upcoming
 *   schedule is due by its unit side (an estimate never makes it overdue). `estimated` when that
 *   day comes before the date side's due-from day, or there is no date side.
 */
export function scheduleNext(
  rule: ScheduleRule,
  at: {
    today: string;
    latestValue?: string | null;
    eta?: ((value: string) => string | null) | null;
  },
): ScheduleNext {
  const snoozed = rule.snoozedUntil != null || rule.snoozedUntilValue != null;
  const steps = rule.skipNext ? 2 : 1;

  let dueOn: string | null = null;
  let dueValue: bigint | null = null;
  let leadDays = rule.leadDays ?? LEAD_DEFAULTS.schedule_days;
  let leadUnits: bigint | null = null;

  if (snoozed) {
    dueOn = rule.snoozedUntil ?? null;
    dueValue = rule.snoozedUntilValue != null ? toScaled(rule.snoozedUntilValue) : null;
    leadDays = 0;
    leadUnits = 0n;
  } else {
    if (rule.everyMonths != null) dueOn = addMonthsClamped(rule.anchorOn, rule.everyMonths * steps);
    else if (rule.dueOn != null) dueOn = rule.dueOn;
    if (rule.everyUnits != null) {
      const every = toScaled(rule.everyUnits);
      dueValue = toScaled(rule.anchorValue ?? '0') + every * BigInt(steps);
      leadUnits = rule.leadUnits != null ? toScaled(rule.leadUnits) : every / UNITS_LEAD_DIVISOR;
    }
  }
  if (dueOn === null && dueValue === null) {
    throw new RangeError('A schedule needs an interval in months or units, or a date');
  }

  let dateState: ScheduleState | null = null;
  if (dueOn !== null) {
    dateState =
      at.today > dueOn ? 'overdue' : at.today >= addDays(dueOn, -leadDays) ? 'due' : 'upcoming';
  }
  let unitState: ScheduleState | null = null;
  if (dueValue !== null) {
    const latest = at.latestValue != null ? toScaled(at.latestValue) : null;
    unitState =
      latest === null
        ? 'upcoming'
        : latest > dueValue
          ? 'overdue'
          : latest >= dueValue - (leadUnits ?? 0n)
            ? 'due'
            : 'upcoming';
  }

  const byUnits =
    unitState !== null && (dateState === null || SEVERITY[unitState] > SEVERITY[dateState]);
  let state = (byUnits ? unitState : dateState) as ScheduleState;
  let basis: ScheduleNext['basis'] = byUnits ? 'units' : 'date';

  let estimatedOn: string | null = null;
  if (dueValue !== null && at.eta) {
    // Only ahead of the latest reading: one already there is due by the reading itself.
    const from = dueValue - (leadUnits ?? 0n);
    const latest = at.latestValue != null ? toScaled(at.latestValue) : null;
    if (from > 0n && (latest === null || latest < from)) estimatedOn = at.eta(fromScaled(from, 12));
  }
  if (estimatedOn !== null && state === 'upcoming' && at.today >= estimatedOn) {
    state = 'due';
    basis = 'units';
  }
  return {
    dueOn,
    dueValue: dueValue === null ? null : fromScaled(dueValue, 3),
    state,
    basis,
    estimatedOn,
    estimated: estimatedOn !== null && (dueOn === null || estimatedOn < addDays(dueOn, -leadDays)),
  };
}
