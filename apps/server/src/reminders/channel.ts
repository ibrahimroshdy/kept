import {
  ACTIVE_SOURCE_TYPES,
  type ActiveSourceType,
  type ChannelKind10,
  type OccurrenceKind,
  type SourceType,
} from '@kept/shared';
import type { AdminAlertKind } from '../db/schema/alerts.js';
import type { StaleMeter } from '../notify/words.js';

// The delivery interface between the reminder engine (plan T14: the scan, deliveries, digests)
// and the channels (plan T15: email, web push, the webhook). The engine decides what goes to whom
// and when, keeps the ledger (reminder_deliveries, notification_digests) and calls a sender; a
// sender only turns a message into one email, push or webhook, in the recipient's language, and
// says how it went. The engine never renders words and a sender never writes the ledger.
//
// T15 implements `ChannelSender` for each channel it builds and hands the set to the worker as
// `SystemJobDeps.channels` (jobs/system.ts). A channel with no sender is off on this instance
// (no SMTP: no `email` sender), and the scan makes no deliveries for it.

/** Where something is, in words: a thing, a place or the whole location (L113). */
export type ReminderSubject = {
  type: 'thing' | 'place' | 'location';
  id: string;
  /** The thing's or place's name; the location's name for a location. */
  name: string;
  /** The places and containers above it, outermost first, without the location and without
   * itself: ['Kitchen', 'Top drawer']. Empty for a location, or something at its root. */
  path: string[];
};

/**
 * One reminder, with everything a template needs to name it (L113): the thing (or place), its
 * path, the location and the local due date. Never money, contact details or secrets (D110).
 */
export type ReminderItem = {
  occurrenceId: string;
  /** The §7.13 key, `${sourceType}:${sourceId}:${kind}:${duePeriod}`: stable across re-sends,
   * so the push sender can hash it into its `topic` (a re-send replaces rather than stacks). */
  key: string;
  sourceType: ActiveSourceType;
  sourceId: string;
  kind: OccurrenceKind;
  /** `date:YYYY-MM-DD` or `meter:<value>`. */
  duePeriod: string;
  /** The due date, `YYYY-MM-DD`, a date in the location's own zone (D122); null for a reading. */
  dueOn: string | null;
  /** The due reading for a unit schedule ("at 60000"), else null. */
  dueValue: string | null;
  /** The meter's unit for `dueValue` (`km`, `h`), else null. */
  unit: string | null;
  /**
   * The source's own words, when it has them: a schedule's name, a warranty's provider, a
   * document's title. Null: the template names the source by its kind (`warrantyKind`,
   * `documentKind`) or by the subject alone (a loan, a thing's expiry).
   */
  title: string | null;
  /** A warranty's (and its registration deadline's) kind code, `manufacturer`, …; else null. */
  warrantyKind: string | null;
  /** An expiring document's kind code, `lease`, `insurance`, …; else null. */
  documentKind: string | null;
  /** A loan's direction: `out` (lent) or `in` (borrowed); else null. */
  loanDirection: 'out' | 'in' | null;
  /** A stale-reading nudge's meter (step 5): its kind, label and the day it was last read. */
  meter?: StaleMeter | null;
  subject: ReminderSubject;
  location: { id: string; name: string; timezone: string };
  /** The item's page, a path under KEPT_PUBLIC_URL: `/t/<id>` (with `?tab=loans` or
   * `?tab=schedules`), `/p/<id>` or `/loc/<id>` (notify/words.ts ReminderFacts.link). */
  link: string;
  /** The same page, absolute (KEPT_PUBLIC_URL + `link`). */
  url: string;
};

/** Who a message is for. Only Kept users ever receive anything (D57). */
export type ReminderRecipient = {
  userId: string;
  /** Their display name, for a greeting. */
  name: string;
  /** Their profile language (a BCP 47 tag, `ar-EG`); the sender picks the mail language. */
  locale: string;
  /** Their own zone (user_profiles.timezone), for times in the text; dates stay the location's. */
  timezone: string;
  /** Their address when it is verified and deliverable (never a managed account's); else null. */
  email: string | null;
};

/** What to send. */
export type ChannelMessage =
  /** An overdue item, sent at once (after quiet hours). */
  | { mode: 'immediate'; item: ReminderItem }
  /** The daily digest (D29): every waiting item, all locations, one message per channel. */
  | { mode: 'digest'; digestOn: string; items: ReminderItem[] }
  /** An admin alert to an instance admin's own channel (D166; only web push in step 4). */
  | { mode: 'alert'; alert: AdminAlertKind; details: Record<string, unknown> }
  /** A channel's test from Settings → Me → Notifications (T15's routes, through the
   * `reminder-deliver` job's `{kind: 'test'}` data, or called directly). */
  | { mode: 'test' };

/** The channel row a message goes out on (notification_channels). A sender that needs the
 * row's sealed config (the webhook) or its devices (web push) reads them by `id` itself, as
 * kept_system. */
export type ChannelTarget = { id: string; kind: ChannelKind10; userId: string };

/**
 * How a send went:
 * - `sent`: handed to the channel (mailed; pushed to at least one device; the webhook job
 *   queued, whose own retries are T15's);
 * - `failed`: try again later (the deliver job fails, and pg-boss retries it);
 * - `skipped`: nothing to send to and no point retrying (every push device answered 404/410 and
 *   was dropped; no deliverable address). The delivery ends `skipped`.
 *
 * `error` is a short machine code, `^[a-z_0-9]{1,40}$` (reminder_deliveries.error's CHECK):
 * `smtp_unavailable`, `push_gone`, `http_503`, never a message with data in it.
 */
export type SendOutcome =
  | { status: 'sent' }
  | { status: 'failed'; error: string }
  | { status: 'skipped'; error: string };

export interface ChannelSender {
  send(target: ChannelTarget, to: ReminderRecipient, message: ChannelMessage): Promise<SendOutcome>;
}

/** The senders this instance has. A missing one means that channel is off here. */
export type ChannelSenders = Partial<Record<ChannelKind10, ChannelSender>>;

/** The reminder sources built (Q3; step 5 added `reading_stale`, step 7 `stock`). */
export function isActiveSource(t: SourceType): t is ActiveSourceType {
  return (ACTIVE_SOURCE_TYPES as readonly SourceType[]).includes(t);
}

/** An error code a delivery row accepts: lowercased, other characters as `_`, at most 40. */
export function errorCode(raw: string): string {
  const code = raw
    .toLowerCase()
    .replace(/[^a-z_0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return code || 'error';
}
