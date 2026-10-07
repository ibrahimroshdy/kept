import {
  type ChannelKind10,
  defaultPreference,
  type NotifyKind,
  type PreferenceChannel,
  type Role,
  SOURCE_MODULE,
} from '@kept/shared';
import type pg from 'pg';
import { isUndeliverableEmail } from '../auth/emails.js';
import type { Pools } from '../db/pools.js';
import type { ChannelSenders, ChannelTarget, ReminderRecipient } from './channel.js';
import type { OccurrenceRow } from './items.js';

// Who hears of an occurrence, and on which channels (plan T14; D29, D57, D113, D122; Q8, Q10,
// Q13, Q16). Only Kept users ever receive anything (D57): a person in the registry is never a
// recipient, only the member a person row is linked to.
//
// - The members of the location whose membership is live and whose role isn't viewer;
// - minus anyone who hid the source's module there (user_hidden_modules, §7.6);
// - plus, for a loan to a person linked to a member of the location (people.member_user_id),
//   that member: it's their own household (Q16);
// - a kind is on when the person chose it (notification_preferences), else defaultPreference():
//   owners and admins every kind, members only the loans they recorded (Q8). `inapp` off
//   silences the kind entirely (Q10); on, it lands in the centre and on each channel that's on:
//   - email: a verified, deliverable address (never a managed account's), SMTP on this instance
//     (an `email` sender), and the email preference on (the kind's default); the row is made
//     lazily (Q13);
//   - web push: a device subscribed and the preference on (the kind's default);
//   - webhooks: only when chosen (default off), every webhook channel of theirs.
//
// Everything is read as kept_system (0006 system_all on memberships and user_profiles; 0053's
// SELECT policies; 0055's on channels, subscriptions and preferences; 0056's on
// user_hidden_modules), and auth."user" through the auth pool (the jobs' way into schema auth,
// jobs/boss.ts). The email channel row is inserted as kept_system too (0056: kind 'email' only).

export type RecipientDeps = {
  pools: Pick<Pools, 'system' | 'auth'> & Partial<Pick<Pools, 'app'>>;
  /** The channel senders this instance has; a missing one is a channel that's off here. */
  channels?: ChannelSenders | null;
};

/** A person as a message addresses them, plus the times the engine needs. */
export type UserInfo = ReminderRecipient & {
  managed: boolean;
  banned: boolean;
  /** `HH:MM:SS`, their zone; null: the default (08:00, Q9). */
  digestTime: string | null;
  quietFrom: string | null;
  quietTo: string | null;
};

/** Profiles (kept_system) and auth rows (kept_auth) of `userIds`. */
export async function loadUsers(
  deps: Pick<RecipientDeps, 'pools'>,
  client: pg.ClientBase,
  userIds: readonly string[],
): Promise<Map<string, UserInfo>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, UserInfo>();
  if (ids.length === 0) return out;
  const { rows: profiles } = await client.query<{
    user_id: string;
    display_name: string;
    timezone: string;
    locale: string;
    digest_time: string | null;
    quiet_from: string | null;
    quiet_to: string | null;
    managed: boolean;
  }>(
    `SELECT user_id, display_name, timezone, locale, digest_time::text AS digest_time,
            quiet_from::text AS quiet_from, quiet_to::text AS quiet_to, managed
       FROM public.user_profiles WHERE user_id = ANY($1::uuid[])`,
    [ids],
  );
  const { rows: users } = await deps.pools.auth.query<{
    id: string;
    email: string;
    email_verified: boolean;
    banned: boolean | null;
  }>('SELECT id, email, email_verified, banned FROM auth."user" WHERE id = ANY($1::uuid[])', [ids]);
  const auth = new Map(users.map((u) => [u.id, u]));
  for (const p of profiles) {
    const u = auth.get(p.user_id);
    if (!u) continue;
    const banned = u.banned === true;
    const deliverable = u.email_verified && !p.managed && !banned && !isUndeliverableEmail(u.email);
    out.set(p.user_id, {
      userId: p.user_id,
      name: p.display_name,
      locale: p.locale,
      timezone: p.timezone,
      email: deliverable ? u.email : null,
      managed: p.managed,
      banned,
      digestTime: p.digest_time,
      quietFrom: p.quiet_from,
      quietTo: p.quiet_to,
    });
  }
  return out;
}

/**
 * The user's email channel row, made when missing (Q13), as kept_system: 0056's system_insert
 * lets it add exactly that (kind 'email', nothing sealed).
 */
export async function ensureEmailChannel(
  client: pg.ClientBase,
  userId: string,
): Promise<string | null> {
  await client.query(
    `INSERT INTO public.notification_channels (user_id, kind) VALUES ($1, 'email')
     ON CONFLICT (user_id) WHERE kind = 'email' DO NOTHING`,
    [userId],
  );
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM public.notification_channels WHERE user_id = $1 AND kind = 'email'`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

export type Recipient = {
  userId: string;
  role: Role;
  /** The channels beside the centre (never `inapp`: the centre isn't a channel, Q10). */
  channels: ChannelTarget[];
};

type Member = { userId: string; role: Role };
type UserChannels = {
  email: string | null;
  webpush: string | null;
  webhooks: string[];
  devices: number;
};

/**
 * Recipients for one scan pass: members, choices, hidden modules, users and channels are read
 * once per location (or user) and kept for the pass.
 */
export class RecipientBook {
  private readonly members = new Map<string, Member[]>();
  private readonly prefs = new Map<string, Map<string, boolean>>();
  private readonly hidden = new Map<string, Set<string>>();
  private readonly users = new Map<string, UserInfo>();
  private readonly userChannels = new Map<string, UserChannels>();

  constructor(private readonly deps: RecipientDeps) {}

  /** A user this pass has read (every recipient `of()` returned). */
  user(userId: string): UserInfo | undefined {
    return this.users.get(userId);
  }

  private async membersOf(client: pg.ClientBase, locationId: string): Promise<Member[]> {
    let m = this.members.get(locationId);
    if (!m) {
      const { rows } = await client.query<{ user_id: string; role: Role }>(
        `SELECT user_id, role FROM public.memberships
          WHERE location_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
        [locationId],
      );
      m = rows.map((r) => ({ userId: r.user_id, role: r.role }));
      this.members.set(locationId, m);
    }
    return m;
  }

  private async prefsOf(client: pg.ClientBase, locationId: string): Promise<Map<string, boolean>> {
    let p = this.prefs.get(locationId);
    if (!p) {
      const { rows } = await client.query<{
        user_id: string;
        kind: string;
        channel: string;
        enabled: boolean;
      }>(
        `SELECT user_id, kind, channel, enabled FROM public.notification_preferences
          WHERE location_id = $1`,
        [locationId],
      );
      p = new Map(rows.map((r) => [`${r.user_id}|${r.kind}|${r.channel}`, r.enabled]));
      this.prefs.set(locationId, p);
    }
    return p;
  }

  /** Who hid which module here (0056's system_select on user_hidden_modules). */
  private async hiddenOf(client: pg.ClientBase, locationId: string): Promise<Set<string>> {
    let h = this.hidden.get(locationId);
    if (!h) {
      const { rows } = await client.query<{ user_id: string; module: string }>(
        'SELECT user_id, module FROM public.user_hidden_modules WHERE location_id = $1',
        [locationId],
      );
      h = new Set(rows.map((r) => `${r.user_id}|${r.module}`));
      this.hidden.set(locationId, h);
    }
    return h;
  }

  private async loadUsersOnce(client: pg.ClientBase, ids: string[]): Promise<void> {
    const missing = ids.filter((id) => !this.users.has(id));
    if (missing.length === 0) return;
    for (const [id, info] of await loadUsers(this.deps, client, missing)) this.users.set(id, info);
    const { rows } = await client.query<{ id: string; user_id: string; kind: ChannelKind10 }>(
      `SELECT id, user_id, kind FROM public.notification_channels
        WHERE user_id = ANY($1::uuid[]) ORDER BY created_at, id`,
      [missing],
    );
    const { rows: devices } = await client.query<{ user_id: string; n: number }>(
      `SELECT user_id, count(*)::int AS n FROM public.push_subscriptions
        WHERE user_id = ANY($1::uuid[]) GROUP BY user_id`,
      [missing],
    );
    const deviceCount = new Map(devices.map((d) => [d.user_id, d.n]));
    for (const id of missing) {
      const mine = rows.filter((r) => r.user_id === id);
      this.userChannels.set(id, {
        email: mine.find((r) => r.kind === 'email')?.id ?? null,
        webpush: mine.find((r) => r.kind === 'webpush')?.id ?? null,
        webhooks: mine.filter((r) => r.kind === 'webhook').map((r) => r.id),
        devices: deviceCount.get(id) ?? 0,
      });
    }
  }

  /** For a loan: who recorded it, and the member its person is linked to (Q16). */
  private async loanPeople(
    client: pg.ClientBase,
    loanId: string,
  ): Promise<{ recordedBy: string | null; linked: string | null }> {
    const { rows } = await client.query<{ created_by: string; member_user_id: string | null }>(
      `SELECT l.created_by, p.member_user_id FROM public.loans l
         LEFT JOIN public.people p ON p.id = l.person_id
        WHERE l.id = $1`,
      [loanId],
    );
    return { recordedBy: rows[0]?.created_by ?? null, linked: rows[0]?.member_user_id ?? null };
  }

  /** Who hears of `occ`, and where. */
  async of(client: pg.ClientBase, occ: OccurrenceRow): Promise<Recipient[]> {
    const kind = occ.source_type as NotifyKind;
    const members = await this.membersOf(client, occ.location_id);
    const loan = occ.source_type === 'loan' ? await this.loanPeople(client, occ.source_id) : null;
    const linked = loan?.linked ? members.find((m) => m.userId === loan.linked) : undefined;
    const candidates = members.filter((m) => m.role !== 'viewer' || m.userId === linked?.userId);
    if (candidates.length === 0) return [];
    const prefs = await this.prefsOf(client, occ.location_id);
    const hidden = await this.hiddenOf(client, occ.location_id);
    await this.loadUsersOnce(
      client,
      candidates.map((m) => m.userId),
    );
    const module = SOURCE_MODULE[occ.source_type];
    const senders = this.deps.channels ?? {};
    const out: Recipient[] = [];
    for (const m of candidates) {
      const user = this.users.get(m.userId);
      if (!user || user.banned) continue;
      if (module && hidden.has(`${m.userId}|${module}`)) continue;
      const mine = loan?.recordedBy === m.userId || linked?.userId === m.userId;
      const fallback =
        linked?.userId === m.userId
          ? true
          : defaultPreference({ role: m.role, kind, recordedByMe: mine });
      const pref = (channel: PreferenceChannel) => prefs.get(`${m.userId}|${kind}|${channel}`);
      if (!(pref('inapp') ?? fallback)) continue;
      const ch = this.userChannels.get(m.userId);
      const channels: ChannelTarget[] = [];
      if (senders.email && user.email && (pref('email') ?? fallback)) {
        let id = ch?.email ?? null;
        if (!id) {
          id = await ensureEmailChannel(client, m.userId);
          if (ch) ch.email = id;
        }
        if (id) channels.push({ id, kind: 'email', userId: m.userId });
      }
      if (senders.webpush && ch?.webpush && ch.devices > 0 && (pref('webpush') ?? fallback)) {
        channels.push({ id: ch.webpush, kind: 'webpush', userId: m.userId });
      }
      if (senders.webhook && pref('webhook') === true) {
        for (const id of ch?.webhooks ?? [])
          channels.push({ id, kind: 'webhook', userId: m.userId });
      }
      out.push({ userId: m.userId, role: m.role, channels });
    }
    return out;
  }
}
