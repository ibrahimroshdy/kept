import { ACTIVE_SOURCE_TYPES, HINT_KEYS, type ModuleId, type Preset } from '@kept/shared';
import type pg from 'pg';
import { z } from 'zod';
import { agendaCountsBySource } from '../agenda/query.js';
import { audited } from '../audit/audited.js';
import { lowStockCount } from '../consumables/service.js';
import type { Tx } from '../db/scope.js';
import { LIVE_SUBJECT } from '../inbox/view.js';
import { switchedOn } from '../locations/views.js';

// Home (T22; D138, D185, D191, D193; screens spec §5 Home and §8): the Get-started checklist,
// the attention panel's rows, the sidebar's counts and the location cards, all computed from
// data on every read, and the per-person hints behind them.
//
// Everything is read as the signed-in user on kept_app, so row-level security decides what is
// counted: a thing in a location she can't see never reaches a count.
//
// The checklist (D138), in the web's order:
// - locationCreated: she owns a non-personal location, or is a member of one (a member who
//   joined someone's home has one; the web words it "Joined Home").
// - threeThings: at least 3 non-deleted things she created herself (plan Q22).
// - labelPrinted: a printed short ID in a location she can see (false until step 3 prints).
//   Left out when Labels is switched off in every location she has: the step would lead
//   nowhere (screens §3, and D138's "only for enabled modules").
// - invited: a non-personal location she owns or administers has another member, or an invite
//   still pending. Left out, with aiConnected, for an invited member: someone who is owner or
//   admin of no non-personal location (screens §5 Home).
// - aiConnected (step 3, T22): done when an AI provider resolves (`kept.ai_provider_resolved`,
//   plan Q5's cascade) in any location she owns or administers, her Personal one included.
//   Shown only to someone who administers a non-personal location, and only where AI is on
//   offer there (D191): a preset other than Essentials with AI capture or the assistant switched
//   on; or, on Essentials, once a provider is connected or she opened AI settings (the
//   `ai_settings_opened` hint), unless both AI modules are switched off there.
// - installed: the `installed_standalone` hint, posted by the web in standalone display mode.
// "Put Kept on HTTPS" is never here: the server can't see the scheme behind a proxy, so the web
// adds it over http (D193).
//
// The attention rows (§8 order) use the same conditions as search's `state` filter
// (search/query.ts STATE_SQL), so a count and the list it opens agree; the home test checks
// that against the search route. The exception is "to review" (step 3, T22): it also counts the
// open inbox items of her writable locations, "Mine" and everyone's (inbox_items' policy shows
// members and above only; an item whose subject is in the trash is hidden, as in the inbox), and
// a reading that waits in the inbox as an item is counted there, not again as a reading. The
// web opens the inbox from the row when `counts.inbox` > 0, and search's `to_review` otherwise.
//
// Step 4 (T13; screens §5 and §8 order: to review · overdue · due · expiring · lent out ·
// borrowed in · uncertain · long unseen · Unplaced): `overdue`, `due` and `expiring` are
// GET /agenda's counts (agenda/query.ts, the same rows), and `agendaBySource` splits each by
// source, so the web opens Schedules when every item of a row is a schedule and Expiring
// otherwise. `lentOut` and `borrowedIn` are the open loans on live things in the locations with
// Lending on, out and in (GET /loans?state=open's `counts.out` and `counts.in`).
//
// Step 7 (T17; screens §8 order: last): `lowStock`, the live things in use below their "keep at
// least" (quantity < minimum, plan Q19) in the locations with Consumables on, as GET
// /consumables?state=low lists them.
//
// `counts` (step 3): `inbox`, the same open items, for the sidebar's Inbox badge; and
// `unprintedLabels`, the things whose code was never printed (Q28, as GET /labels/summary counts
// them) in the locations where Labels is switched on.
//
// `meteredThings` (step 5, T13; screens §6 Quick log): the things in use with a meter, in the
// locations where she may log a reading (members and above), so Home shows "Log a reading" only
// when she has one to log.

export const CHECKLIST_KEYS = [
  'locationCreated',
  'threeThings',
  'labelPrinted',
  'invited',
  'aiConnected',
  'installed',
] as const;
export type ChecklistKey = (typeof CHECKLIST_KEYS)[number];

/** The hint the web posts when Kept runs installed (screens §8). */
export const INSTALLED_HINT = 'installed_standalone';
/** The hint that holds the checklist's dismissal (D138), shared by every device. */
export const CHECKLIST_HINT = 'checklist';

export const HomeResponse = z.object({
  checklist: z.object({
    dismissed: z.boolean(),
    items: z.array(z.object({ key: z.enum(CHECKLIST_KEYS), done: z.boolean() })),
  }),
  attention: z.object({
    toReview: z.number().int(),
    uncertain: z.number().int(),
    longUnseen: z.number().int(),
    unplaced: z.number().int(),
    overdue: z.number().int(),
    due: z.number().int(),
    expiring: z.number().int(),
    lentOut: z.number().int(),
    borrowedIn: z.number().int(),
    lowStock: z.number().int(),
  }),
  agendaBySource: z.object({
    overdue: z.partialRecord(z.enum(ACTIVE_SOURCE_TYPES), z.number().int()),
    due: z.partialRecord(z.enum(ACTIVE_SOURCE_TYPES), z.number().int()),
    expiring: z.partialRecord(z.enum(ACTIVE_SOURCE_TYPES), z.number().int()),
  }),
  counts: z.object({ inbox: z.number().int(), unprintedLabels: z.number().int() }),
  locations: z.array(
    z.object({ id: z.uuid(), thingCount: z.number().int(), unplacedCount: z.number().int() }),
  ),
  /** Step 5 (T13; screens §6 Quick log): the things in use with a meter she can log a reading
   * on (`logs.add`: members and above), so Home offers "Log a reading" only when there is one. */
  meteredThings: z.number().int(),
});
export type HomeResponse = z.infer<typeof HomeResponse>;

/** The hint the AI settings page posts when opened (D191: Essentials then shows AI setup). */
export const AI_SETTINGS_HINT = 'ai_settings_opened';

type LocationRow = {
  id: string;
  kind: string;
  preset: Preset;
  role: string;
  others: boolean;
  provider_resolved: boolean;
  thing_count: number;
  unplaced_count: number;
};

/** Her locations, Personal first then by name (the order of GET /locations), with what the
 * checklist and the cards need. A card counts the things in use: an ended one (sold, or a
 * borrowed thing given back) isn't in the house any more. */
async function locationRows(client: pg.ClientBase): Promise<LocationRow[]> {
  const { rows } = await client.query<LocationRow>(
    `SELECT l.id, l.kind, l.preset, m.role,
            (EXISTS (SELECT 1 FROM public.memberships mm
                      WHERE mm.location_id = l.id AND mm.user_id <> m.user_id
                        AND (mm.expires_at IS NULL OR mm.expires_at > now()))
             OR EXISTS (SELECT 1 FROM public.invites i
                         WHERE i.location_id = l.id AND i.accepted_at IS NULL
                           AND i.expires_at > now())) AS others,
            (m.role IN ('owner', 'admin') AND kept.ai_provider_resolved(l.id)) AS provider_resolved,
            coalesce(c.thing_count, 0)::int AS thing_count,
            coalesce(c.unplaced_count, 0)::int AS unplaced_count
       FROM public.locations l
       JOIN public.memberships m ON m.location_id = l.id AND m.user_id = kept.current_user_id()
       LEFT JOIN (
         SELECT t.location_id, count(*) FILTER (WHERE t.lifecycle = 'in_use') AS thing_count,
                count(*) FILTER (WHERE pl.is_unplaced) AS unplaced_count
           FROM public.things t
           LEFT JOIN public.places pl ON pl.id = t.place_id
          WHERE t.deleted_at IS NULL
          GROUP BY t.location_id
       ) c ON c.location_id = l.id
      WHERE l.id IN (SELECT kept.visible_location_ids())
      ORDER BY CASE WHEN l.kind = 'personal' THEN 0 ELSE 1 END, lower(l.name), l.id`,
  );
  return rows;
}

type Switch = { location_id: string; module: string; enabled: boolean };

/** Each location's own module switches (location_modules rows). */
async function switchesOf(
  client: pg.ClientBase,
  locations: readonly LocationRow[],
): Promise<Switch[]> {
  const { rows } = await client.query<Switch>(
    'SELECT location_id, module, enabled FROM public.location_modules WHERE location_id = ANY($1)',
    [locations.map((l) => l.id)],
  );
  return rows;
}

/** The modules switched on in each location (preset, then its own switches). */
function switchedModules(
  locations: readonly LocationRow[],
  switches: readonly Switch[],
): Map<string, Set<ModuleId>> {
  return new Map(
    locations.map((l) => [
      l.id,
      switchedOn(
        l.preset,
        switches.filter((r) => r.location_id === l.id),
      ),
    ]),
  );
}

const AI_MODULES = ['ai_capture', 'ai_assistant'] as const;

type Facts = {
  three_things: boolean;
  label_printed: boolean;
  installed: boolean;
  ai_settings_opened: boolean;
  dismissed: boolean;
  inbox: number;
  unprinted: number;
  to_review: number;
  uncertain: number;
  long_unseen: number;
  unplaced: number;
  metered: number;
};

async function facts(client: pg.ClientBase, labelsOn: readonly string[]): Promise<Facts> {
  const { rows } = await client.query<Facts>(
    `SELECT
       (SELECT count(*) FROM public.things t
         WHERE t.created_by = kept.current_user_id() AND t.deleted_at IS NULL) >= 3
         AS three_things,
       EXISTS (SELECT 1 FROM public.short_ids s WHERE s.printed_at IS NOT NULL) AS label_printed,
       EXISTS (SELECT 1 FROM public.user_hints h
                WHERE h.user_id = kept.current_user_id() AND h.hint_key = $1) AS installed,
       EXISTS (SELECT 1 FROM public.user_hints h
                WHERE h.user_id = kept.current_user_id() AND h.hint_key = $3)
         AS ai_settings_opened,
       coalesce((SELECT h.dismissed FROM public.user_hints h
                  WHERE h.user_id = kept.current_user_id() AND h.hint_key = $2), false)
         AS dismissed,
       (SELECT count(*)::int FROM public.inbox_items i WHERE ${LIVE_SUBJECT}) AS inbox,
       (SELECT count(*)::int FROM public.things t
         WHERE t.deleted_at IS NULL AND t.location_id = ANY ($4::uuid[])
           AND EXISTS (SELECT 1 FROM public.short_ids s
                        WHERE s.thing_id = t.id AND s.state = 'assigned')
           AND NOT EXISTS (SELECT 1 FROM public.short_ids s
                            WHERE s.thing_id = t.id AND s.state = 'assigned'
                              AND s.printed_at IS NOT NULL)) AS unprinted,
       (SELECT count(*)::int FROM public.things t
         WHERE t.deleted_at IS NULL AND t.lifecycle = 'in_use'
           AND t.location_id IN (SELECT kept.writable_location_ids())
           AND EXISTS (SELECT 1 FROM public.meters m WHERE m.thing_id = t.id)) AS metered,
       a.to_review, a.uncertain, a.long_unseen, a.unplaced
     FROM (
       SELECT
         -- One hashed set of the things with a reading to review, not a lookup per thing (the
         -- step-5 perf fix: with 50 vehicles' meters that lookup was most of Home's facts).
         count(*) FILTER (WHERE t.id IN (
           SELECT m.thing_id FROM public.meters m
             JOIN public.meter_readings r ON r.meter_id = m.id
            WHERE r.state = 'needs_review'
              AND NOT EXISTS (SELECT 1 FROM public.inbox_items i
                               WHERE i.meter_reading_id = r.id AND i.resolved_at IS NULL)))::int
           AS to_review,
         count(*) FILTER (WHERE t.location_uncertain)::int AS uncertain,
         count(*) FILTER (WHERE t.lifecycle = 'in_use'
           AND t.last_seen_at < now() - make_interval(months => l.long_unseen_months))::int
           AS long_unseen,
         count(*) FILTER (WHERE pl.is_unplaced)::int AS unplaced
       FROM public.things t
       JOIN public.locations l ON l.id = t.location_id
       LEFT JOIN public.places pl ON pl.id = t.place_id
      WHERE t.deleted_at IS NULL
     ) a`,
    [INSTALLED_HINT, CHECKLIST_HINT, AI_SETTINGS_HINT, labelsOn],
  );
  const row = rows[0];
  if (!row) throw new Error('home: the facts query returned no row');
  return row;
}

/** Open loans on live things where Lending is on, out and in (D56, D57). */
async function openLoans(client: pg.ClientBase): Promise<{ out: number; in: number }> {
  const { rows } = await client.query<{ out: number; in: number }>(
    `SELECT count(*) FILTER (WHERE o.direction = 'out')::int AS out,
            count(*) FILTER (WHERE o.direction = 'in')::int AS in
       FROM public.loans o
       JOIN public.things t ON t.id = o.thing_id
      WHERE o.returned_at IS NULL AND t.deleted_at IS NULL
        AND kept.module_on(o.location_id, 'lending')`,
  );
  return rows[0] ?? { out: 0, in: 0 };
}

/** GET /api/v1/home for the signed-in user. */
export async function homeOf(client: pg.ClientBase): Promise<HomeResponse> {
  // One read of the agenda: the totals are the per-source counts summed (the same rows as
  // agendaCounts({}): overdue, due and expiring, never expired).
  const agendaBySource = await agendaCountsBySource(client);
  const total = (state: 'overdue' | 'due' | 'expiring') =>
    Object.values(agendaBySource[state]).reduce((sum, n) => sum + (n ?? 0), 0);
  const agenda = { overdue: total('overdue'), due: total('due'), expiring: total('expiring') };
  const loans = await openLoans(client);
  const lowStock = await lowStockCount(client);
  const locations = await locationRows(client);
  const switches = await switchesOf(client, locations);
  const modules = switchedModules(locations, switches);
  const labelsIn = locations.filter((l) => modules.get(l.id)?.has('labels')).map((l) => l.id);
  const f = await facts(client, labelsIn);

  const shared = locations.filter((l) => l.kind !== 'personal');
  const administers = shared.filter((l) => l.role === 'owner' || l.role === 'admin');
  const aiConnected = locations.some((l) => l.provider_resolved);
  const bothAiOff = (l: LocationRow) =>
    AI_MODULES.every((m) =>
      switches.some((s) => s.location_id === l.id && s.module === m && !s.enabled),
    );
  const aiOffered = administers.some((l) => {
    if (l.preset !== 'essentials') {
      const on = modules.get(l.id);
      return AI_MODULES.some((m) => on?.has(m));
    }
    return (aiConnected || f.ai_settings_opened) && !bothAiOff(l);
  });

  const items: HomeResponse['checklist']['items'] = [
    { key: 'locationCreated', done: shared.length > 0 },
    { key: 'threeThings', done: f.three_things },
  ];
  if (labelsIn.length > 0) items.push({ key: 'labelPrinted', done: f.label_printed });
  if (administers.length > 0) {
    items.push({ key: 'invited', done: administers.some((l) => l.others) });
    if (aiOffered) items.push({ key: 'aiConnected', done: aiConnected });
  }
  items.push({ key: 'installed', done: f.installed });

  return {
    checklist: { dismissed: f.dismissed, items },
    attention: {
      toReview: f.inbox + f.to_review,
      uncertain: f.uncertain,
      longUnseen: f.long_unseen,
      unplaced: f.unplaced,
      overdue: agenda.overdue,
      due: agenda.due,
      expiring: agenda.expiring,
      lentOut: loans.out,
      borrowedIn: loans.in,
      lowStock,
    },
    agendaBySource,
    counts: { inbox: f.inbox, unprintedLabels: f.unprinted },
    locations: locations.map((l) => ({
      id: l.id,
      thingCount: l.thing_count,
      unplacedCount: l.unplaced_count,
    })),
    meteredThings: f.metered,
  };
}

// ---------------------------------------------------------------------------------------------
// Hints (D138): once per person, remembered on the server so every phone agrees.
//
// A row in user_hints means the hint was seen (seen_at is set when the row is made and never
// moved); `dismissed` says whether it is dismissed now. The table keeps no dismissal time, so
// `dismissedAt` is read from the audit log: every dismissal writes a `hint.dismiss` event in
// the same transaction, account-level on the user's own account, which only she can read. A
// dismissed row with no such event (written some other way) reports its seen_at.
//
// Writes, each audited `hint.<verb>` with the diff keyed by the hint:
// - `seen: true` on a hint with no row makes the row (`hint.seen`); on one that has it, nothing.
// - `dismissed: true|false` sets the flag (`hint.dismiss` / `hint.restore`, the undo). Dismissing
//   a hint never seen makes its row, seen now; restoring one never seen stores nothing.
// - `seen: false` is ignored: a hint once seen stays seen.
// A request that changes nothing writes nothing, audit included.
// ---------------------------------------------------------------------------------------------

export const HINT_KEY = /^[a-z0-9_.:-]{1,64}$/;

/** The hint keys a person may store (security review #34): @kept/shared's HINT_KEYS and the
 * checklist's dismissal. Anything else is a 400, so user_hints can't grow without bound. */
export const ALLOWED_HINTS: ReadonlySet<string> = new Set<string>([...HINT_KEYS, CHECKLIST_HINT]);

export const HintSchema = z.object({
  key: z.string(),
  seenAt: z.string().nullable(),
  dismissedAt: z.string().nullable(),
});
export type Hint = z.infer<typeof HintSchema>;

export const UpdateHintBody = z
  .strictObject({ seen: z.boolean(), dismissed: z.boolean() })
  .partial()
  .refine((b) => b.seen !== undefined || b.dismissed !== undefined, {
    message: 'Say whether the hint was seen or dismissed.',
  });
export type UpdateHintBody = z.infer<typeof UpdateHintBody>;

type HintRow = { hint_key: string; seen_at: Date; dismissed: boolean; dismissed_at: Date | null };

export async function listHints(client: pg.ClientBase): Promise<Hint[]> {
  const { rows } = await client.query<HintRow>(
    `SELECT h.hint_key, h.seen_at, h.dismissed,
            CASE WHEN h.dismissed THEN coalesce(
              (SELECT max(e.at) FROM public.audit_events e
                WHERE e.location_id IS NULL
                  AND e.owner_account_id = kept.current_owner_account_id()
                  AND e.actor_id = h.user_id
                  AND e.entity_type = 'hint' AND e.action = 'hint.dismiss'
                  AND e.diff ? h.hint_key),
              h.seen_at) END AS dismissed_at
       FROM public.user_hints h
      WHERE h.user_id = kept.current_user_id()
      ORDER BY h.hint_key`,
  );
  return rows.map((r) => ({
    key: r.hint_key,
    seenAt: r.seen_at.toISOString(),
    dismissedAt: r.dismissed_at?.toISOString() ?? null,
  }));
}

type HintState = { seen: boolean; dismissed: boolean };

export async function updateHint(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  key: string,
  body: UpdateHintBody,
  requestId: string,
): Promise<void> {
  const { rows } = await client.query<{ dismissed: boolean }>(
    `SELECT dismissed FROM public.user_hints
      WHERE user_id = kept.current_user_id() AND hint_key = $1 FOR UPDATE`,
    [key],
  );
  const current = rows[0];
  const before: HintState = { seen: !!current, dismissed: current?.dismissed ?? false };
  const after: HintState = {
    seen: before.seen || body.seen === true || body.dismissed === true,
    dismissed: body.dismissed ?? before.dismissed,
  };
  if (after.seen === before.seen && after.dismissed === before.dismissed) return;

  if (!current) {
    await client.query(
      `INSERT INTO public.user_hints (user_id, hint_key, dismissed)
       VALUES (kept.current_user_id(), $1, $2)`,
      [key, after.dismissed],
    );
  } else {
    await client.query(
      `UPDATE public.user_hints SET dismissed = $2
        WHERE user_id = kept.current_user_id() AND hint_key = $1`,
      [key, after.dismissed],
    );
  }

  const { rows: account } = await client.query<{ id: string | null }>(
    'SELECT kept.current_owner_account_id() AS id',
  );
  const verb =
    after.dismissed !== before.dismissed ? (after.dismissed ? 'dismiss' : 'restore') : 'seen';
  await audited(tx, {
    locationId: null,
    ownerAccountId: account[0]?.id ?? null,
    actor: { type: 'user', id: userId },
    action: `hint.${verb}`,
    entity: { type: 'hint' },
    before: { [key]: before },
    after: { [key]: after },
    requestId,
  });
}
