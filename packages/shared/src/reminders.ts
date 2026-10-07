/**
 * Reminders and notifications (step 4): the sources the agenda reads, the kinds of occurrence
 * each produces, the key that makes an occurrence exactly-once, what people receive by default,
 * and the channels (engineering spec §1.9, §7.13; product design D29, D30, D111, D113, D122,
 * D141, D162; step-4 plan Q3–Q13, Q35).
 *
 * As for every value list in Kept, each is a text column with a CHECK (D183) that reads this file.
 */

import type { ModuleId } from './modules.js';
import type { Role } from './roles.js';

/**
 * Every reminder source (§1.9). `stock` lands with consumables (step 7) and `reading_stale` with
 * the vehicle work (step 5, D52); the tables' CHECKs already hold both slots (Q3).
 * `registration` is D55's warranty-registration deadline (Q4, inferred).
 */
export const SOURCE_TYPES = [
  'schedule',
  'warranty',
  'registration',
  'document',
  'loan',
  'thing_expiry',
  'stock',
  'reading_stale',
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** The sources built (Q3): the agenda view's branches and the preference kinds. Step 4 built the
 * first six; step 5 adds the stale-reading nudge (D52, T14), and step 7 low stock (D14, T17;
 * 0104). Every §1.9 source is built now. */
export const ACTIVE_SOURCE_TYPES = [
  'schedule',
  'warranty',
  'registration',
  'document',
  'loan',
  'thing_expiry',
  'reading_stale',
  'stock',
] as const satisfies readonly SourceType[];
export type ActiveSourceType = (typeof ACTIVE_SOURCE_TYPES)[number];

/**
 * The module a source belongs to: switched off, its reminders pause (D113, D162). Thing expiries
 * follow Schedules (D141); documents follow Paperwork (Q5), and a vehicle's documents Paperwork or
 * Vehicles (step 5: `sourceModuleOn`); `reading_stale` is core (null, step-5 plan T7, D113).
 */
export const SOURCE_MODULE: Readonly<Record<SourceType, ModuleId | null>> = Object.freeze({
  schedule: 'schedules',
  warranty: 'warranties',
  registration: 'warranties',
  document: 'paperwork',
  loan: 'lending',
  thing_expiry: 'schedules',
  stock: 'consumables',
  reading_stale: null,
});

/** `reminder_occurrences.kind` (§1.9). */
export const OCCURRENCE_KINDS = ['due', 'overdue', 'expiring'] as const;
export type OccurrenceKind = (typeof OCCURRENCE_KINDS)[number];

/**
 * The kinds each source produces (Q7): schedules due and overdue; warranties expiring only (an
 * ended warranty isn't actionable); a registration deadline due; documents and thing expiries
 * expiring and overdue; loans overdue only (D57), with their due date on the Lending screen.
 * A stale reading is due (step 5, D52); low stock is due from the day it ran low (step 7).
 */
export const SOURCE_KINDS: Readonly<Record<SourceType, readonly OccurrenceKind[]>> = Object.freeze({
  schedule: ['due', 'overdue'],
  warranty: ['expiring'],
  registration: ['due'],
  document: ['expiring', 'overdue'],
  loan: ['overdue'],
  thing_expiry: ['expiring', 'overdue'],
  stock: ['due'],
  reading_stale: ['due'],
});

/**
 * Whether a source's module state lets it remind in a location (D113, D162), as the agenda view
 * decides it: a core source always; a document on a vehicle while Paperwork or Vehicles is on
 * (step 5, step 4's Q5); any other while its module is on. `isOn` is the location's effective
 * module state (effectiveModules()).
 */
export function sourceModuleOn(
  source: SourceType,
  isOn: (module: ModuleId) => boolean,
  subject: { vehicle?: boolean } = {},
): boolean {
  const module = SOURCE_MODULE[source];
  if (module === null) return true;
  if (source === 'document' && subject.vehicle) return isOn('paperwork') || isOn('vehicles');
  return isOn(module);
}

/** `reminder_occurrences.state`: open until the scan closes it (§7.13). */
export const OCCURRENCE_STATES = ['open', 'done', 'superseded', 'cancelled'] as const;
export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];

/**
 * `agenda_items.state`, as the view computes it on the location's local date (L2: end dates are
 * inclusive). Schedules, loans and registration deadlines are upcoming, due or overdue;
 * warranties, documents and thing expiries are upcoming, expiring or expired.
 */
export const AGENDA_STATES = ['upcoming', 'due', 'overdue', 'expiring', 'expired'] as const;
export type AgendaState = (typeof AGENDA_STATES)[number];

/**
 * An occurrence's due period, the last part of its exactly-once key (§7.13, D111):
 * `date:YYYY-MM-DD` for a date due point, `meter:<value>` for a reading (canonical: no leading or
 * trailing zeros, at most 3 decimals). The CHECK is
 * `^(date:\d{4}-\d{2}-\d{2}|meter:\d+(\.\d{1,3})?)$`; the view computes the same in SQL.
 */
export function duePeriod(due: { dueOn: string } | { dueValue: string }): string {
  if ('dueOn' in due) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due.dueOn)) throw new RangeError(`Not a date: ${due.dueOn}`);
    return `date:${due.dueOn}`;
  }
  const m = /^(\d+)(?:\.(\d+))?$/.exec(due.dueValue.trim());
  const frac = (m?.[2] ?? '').replace(/0+$/, '');
  if (!m || frac.length > 3) throw new RangeError(`Not a meter value: ${due.dueValue}`);
  const int = (m[1] ?? '0').replace(/^0+(?=\d)/, '');
  return frac ? `meter:${int}.${frac}` : `meter:${int}`;
}

/**
 * `notification_preferences.kind`: the reminder sources, plus the notices steps 1–3 could only
 * mail (membership changes, AI caps) and the AI monthly summary.
 */
export const NOTIFY_KINDS = [...ACTIVE_SOURCE_TYPES, 'membership', 'ai_cap', 'ai_summary'] as const;
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

/**
 * `notification_preferences_kind_chk`'s list (0067): the slot for step 5's stale-reading nudge
 * (D52) was held before it was built, so NOTIFY_KINDS took it (T14) with no migration; step 7's
 * low stock widened it (0103). The two lists are equal (reminders.test.ts).
 */
export const NOTIFY_KIND_SLOTS = [
  'schedule',
  'warranty',
  'registration',
  'document',
  'loan',
  'thing_expiry',
  'reading_stale',
  'stock',
  'membership',
  'ai_cap',
  'ai_summary',
] as const;

/** Kinds that belong to a person's account, not a location: their preference row has a null
 * `location_id` (Q35). */
export const ACCOUNT_LEVEL_KINDS = ['ai_summary'] as const satisfies readonly NotifyKind[];

/**
 * `notifications.kind`, what the in-app centre lists (D39). A reminder carries its source in
 * the payload; `payload` holds ids and codes only, never money, secrets or contact details.
 */
export const NOTIFICATION_KINDS = [
  'reminder',
  'membership_added',
  'membership_ended',
  'ai_cap',
  'ai_summary',
  'export_ready',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Every channel kind in the spec (§1.9, D30). ntfy, Telegram and Apprise are 1.x (D130). */
export const CHANNEL_KINDS = [
  'email',
  'webpush',
  'webhook',
  'ntfy',
  'telegram',
  'apprise',
] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** The channels 1.0 builds: `notification_channels.kind`'s CHECK. */
export const CHANNEL_KINDS_1_0 = [
  'email',
  'webpush',
  'webhook',
] as const satisfies readonly ChannelKind[];
export type ChannelKind10 = (typeof CHANNEL_KINDS_1_0)[number];

/**
 * `notification_preferences.channel`: the 1.0 channels plus `inapp`. The centre isn't a channel
 * (every enabled kind lands there), but an `inapp` row lets a person silence a kind entirely (Q10).
 */
export const PREFERENCE_CHANNELS = ['inapp', ...CHANNEL_KINDS_1_0] as const;
export type PreferenceChannel = (typeof PREFERENCE_CHANNELS)[number];

/** `reminder_deliveries.status` (§7.13): `digest` waits for the person's digest; `skipped` was
 * never sent (the channel went, the kind was switched off). */
export const DELIVERY_STATUSES = [
  'digest',
  'queued',
  'sending',
  'sent',
  'failed',
  'skipped',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** At most this many webhook channels per person (T7's trigger). */
export const MAX_WEBHOOK_CHANNELS = 5;

/** At most this many live calendar feed links per person (Q23; T7's trigger). */
export const MAX_CALENDAR_FEEDS = 3;

/** The calendar feed's window (Q23): a month back to 13 months ahead. */
export const CALENDAR_FEED_WINDOW = Object.freeze({ monthsBack: 1, monthsAhead: 13 });

/**
 * Who receives a kind when they haven't chosen (D29; Q8). A preference row exists only where a
 * person chose, so a change here reaches everyone who never did.
 *
 * - Owners and admins: every kind.
 * - Members: loans they recorded (D57: "reminders go to the user") and membership notices;
 *   everything else is opt-in.
 * - Viewers: no reminder kinds (they can't act on them), only membership notices.
 * - The AI monthly summary is account-level and opt-out: on for everyone (Q35).
 *
 * The same default holds on every channel, `inapp` included (Q10).
 */
export function defaultPreference(p: {
  role: Role;
  kind: NotifyKind;
  /** For a loan: whether this person recorded it. */
  recordedByMe?: boolean;
}): boolean {
  if (p.kind === 'ai_summary' || p.kind === 'membership') return true;
  if (p.role === 'owner' || p.role === 'admin') return true;
  if (p.role === 'member') return p.kind === 'loan' && p.recordedByMe === true;
  return false;
}

/**
 * Lead times when a record sets none (§3.4; Q9): days before a date due point, and for a unit
 * schedule a share of its interval. Loans have no lead: they remind when overdue (D57).
 */
export const LEAD_DEFAULTS = Object.freeze({
  warranty: 30,
  document: 30,
  thing_expiry: 30,
  registration: 14,
  schedule_days: 14,
  schedule_units_ratio: 0.1,
});

/** A person's digest time when they haven't set one (Q9), in their own time zone. */
export const DEFAULT_DIGEST_TIME = '08:00';
