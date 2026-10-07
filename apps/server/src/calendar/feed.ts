import { createHash, randomBytes } from 'node:crypto';
import {
  ACTIVE_SOURCE_TYPES,
  type ActiveSourceType,
  CALENDAR_FEED_WINDOW,
  type NotifyKind,
  type OccurrenceKind,
  PREFERENCE_CHANNELS,
  type Role,
} from '@kept/shared';
import type pg from 'pg';
import { mailLocale } from '../mail/messages.js';
import { myPreferences, preferenceDefault, storedMap } from '../notify/prefs.js';
import { REMINDER_WORDS, type ReminderFacts, shortTitle } from '../notify/words.js';
import { type AllDayEvent, writeCalendar } from './ical.js';

// The calendar feed's content (D142, D110, D116; plan T17, Q23). Built in the feed owner's own
// scope (kept_app, row-level security as for their requests), from the one agenda
// (public.agenda_items) the scan, Home and the lists read:
// - states upcoming, due, overdue and expiring, a month back to 13 months ahead, in each
//   location's own calendar;
// - only the kinds the person gets on some channel (their choice, else the default: Q23), and
//   none from a module they hid;
// - one all-day event per item, named as a reminder is (notify/words.ts), with the path and
//   location and a deep link; no money, secrets, notes or anyone's contact details;
// - a unit schedule without a date has no day to sit on, so it is left out.

/** A new feed token: 32 random bytes, base64url (43 characters), shown once. */
export function newFeedToken(): string {
  return randomBytes(32).toString('base64url');
}

export const FEED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** What is stored: the token's SHA-256, hex. */
export function feedTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

type Row = {
  source_type: ActiveSourceType;
  source_id: string;
  location_id: string;
  thing_id: string | null;
  place_id: string | null;
  kind: OccurrenceKind;
  due_on: string;
  due_period: string;
  title: string | null;
  location_name: string;
  role: Role;
  subject_name: string;
  path: string | null;
  document_kind: string | null;
  recorded_by_me: boolean | null;
};

const FEED_SQL = `
SELECT a.source_type, a.source_id::text AS source_id, a.location_id, a.thing_id, a.place_id,
       a.kind, a.due_on::text AS due_on, a.due_period, a.title,
       l.name AS location_name, m.role,
       coalesce(t.name, p.name, l.name) AS subject_name,
       CASE WHEN t.id IS NOT NULL THEN nullif(t.place_path, '')
            WHEN p.id IS NOT NULL THEN
              (SELECT string_agg(e->>'name', ' › ' ORDER BY x.n)
                 FROM jsonb_array_elements(kept.path_of(p.parent_id, NULL)) WITH ORDINALITY x(e, n))
       END AS path,
       d.kind AS document_kind,
       (o.created_by = kept.current_user_id()) AS recorded_by_me
  FROM public.agenda_items a
  JOIN public.locations l ON l.id = a.location_id
  JOIN public.memberships m ON m.location_id = a.location_id
                           AND m.user_id = kept.current_user_id()
                           AND (m.expires_at IS NULL OR m.expires_at > now())
  LEFT JOIN public.things t ON t.id = a.thing_id
  LEFT JOIN public.places p ON p.id = a.place_id
  LEFT JOIN public.expiring_documents d ON a.source_type = 'document' AND d.id = a.source_id
  LEFT JOIN public.loans o ON a.source_type = 'loan' AND o.id = a.source_id
 WHERE a.state IN ('upcoming', 'due', 'overdue', 'expiring')
   -- The sources built so far, less the stale-reading nudge: its day moves with every reading,
   -- so it is a nudge, not a date to plan around (step 5, T14).
   AND a.source_type = ANY ($3::text[])
   AND a.due_on IS NOT NULL
   AND a.due_on >= ((now() AT TIME ZONE l.timezone)::date - make_interval(months => $1))::date
   AND a.due_on <= ((now() AT TIME ZONE l.timezone)::date + make_interval(months => $2))::date
   AND NOT EXISTS (SELECT 1 FROM public.user_hidden_modules h
                    WHERE h.user_id = kept.current_user_id() AND h.location_id = a.location_id
                      AND h.module = a.module)
 ORDER BY a.due_on, a.source_type, a.source_id
 LIMIT 5000`;

const PAGE = { thing: '/t/', place: '/p/', location: '/loc/' } as const;

/** The caller's feed as an iCalendar document. `now` is the DTSTAMP. */
export async function buildFeed(
  client: pg.ClientBase,
  publicUrl: string,
  now = new Date(),
): Promise<string> {
  const { rows: profile } = await client.query<{ locale: string }>(
    'SELECT locale FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  const words = REMINDER_WORDS[mailLocale(profile[0]?.locale)];
  const prefs = storedMap(await myPreferences(client));
  /** On some channel: chosen, else the default (Q23). */
  const wanted = (r: Row) =>
    PREFERENCE_CHANNELS.some((channel) => {
      const kind = r.source_type as NotifyKind;
      return (
        prefs.get(`${r.location_id}|${kind}|${channel}`) ??
        preferenceDefault({
          role: r.role,
          kind,
          channel,
          ...(r.source_type === 'loan' ? { recordedByMe: r.recorded_by_me === true } : {}),
        })
      );
    });
  const { rows } = await client.query<Row>(FEED_SQL, [
    CALENDAR_FEED_WINDOW.monthsBack,
    CALENDAR_FEED_WINDOW.monthsAhead,
    // A nudge to read a meter and low stock are no day to keep: not in the calendar.
    ACTIVE_SOURCE_TYPES.filter((s) => s !== 'reading_stale' && s !== 'stock'),
  ]);
  const host = new URL(publicUrl).host;
  const events: AllDayEvent[] = rows.filter(wanted).map((r) => {
    const type = r.thing_id ? 'thing' : r.place_id ? 'place' : 'location';
    const id = r.thing_id ?? r.place_id ?? r.location_id;
    const link = `${PAGE[type]}${id}`;
    const facts: ReminderFacts = {
      sourceType: r.source_type,
      kind: r.kind,
      title: r.title,
      documentKind: r.document_kind,
      subject: { type, name: r.subject_name, path: r.path },
      locationName: r.location_name,
      dueOn: r.due_on,
      dueValue: null,
      unit: null,
      link,
    };
    return {
      uid: `${r.source_type}-${r.source_id}-${r.due_period}@${host}`,
      date: r.due_on,
      summary: shortTitle(words, facts),
      description: words.where(facts),
      url: new URL(link, publicUrl).toString(),
    };
  });
  return writeCalendar({ prodId: '-//Kept//Calendar feed//EN', name: 'Kept', stamp: now, events });
}
