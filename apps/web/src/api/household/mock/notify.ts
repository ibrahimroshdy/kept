/**
 * Mock handlers for channels and preferences (T15) and the notification centre (T16).
 *
 * Settings: the digest time and quiet hours (both ends or neither), SMTP and push availability,
 * the channels (email, this and other devices' push, webhooks whose secret is shown once and URL
 * never again), and per location a kind × channel table where only chosen values are stored and
 * everything else is `defaultPreference()` (Q8, Q10). Viewers' locations list only Membership.
 * The AI monthly summary is account-level (Q35).
 *
 * The centre: the caller's notifications, newest first; a reminder's state and actions are read
 * from its source now (db.ts `notificationView`), so a returned loan reads `done` with no
 * actions. Marking read is the user's own bookkeeping (not audited).
 */
import {
  ACCOUNT_LEVEL_KINDS,
  defaultPreference,
  MAX_WEBHOOK_CHANNELS,
  NOTIFY_KINDS,
  type NotifyKind,
  PREFERENCE_CHANNELS,
  type PreferenceChannel,
  type Role,
} from '@kept/shared';
import { now, paginate } from '../../inventory/mock/db';
import type { MockState } from '../../mock/fixtures';
import { err, type MockRoute, notFound, reply, route } from '../../mock/kit';
import { householdPaths as p } from '../paths';
import type {
  Channel,
  CreateChannelBody,
  CreatePushSubscriptionBody,
  KindPreference,
  NotificationSettings,
  PutNotificationSettingsBody,
  PutPreferencesBody,
  ReadNotificationsBody,
} from '../types';
import { ensureSeeded, hh, newId, notificationView } from './db';
import type { StoredPreference } from './state';

const invalid = (hint: string) => err(400, 'validation', 'The request is not valid.', hint);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The default on one channel, as the server's notify/prefs.ts preferenceDefault(): the shared
 * default everywhere but webhooks, which are on only once chosen (plan T14, T15). */
const channelDefault = (role: Role, kind: NotifyKind, channel: PreferenceChannel) =>
  channel === 'webhook' ? false : defaultPreference({ role, kind });

/** The location kinds a table shows: every kind but the account-level ones. */
const LOCATION_KINDS = NOTIFY_KINDS.filter(
  (k) => !(ACCOUNT_LEVEL_KINDS as readonly string[]).includes(k),
);

export function notifyRoutes(state: MockState): MockRoute[] {
  const h = () => hh(state);
  const mine = () => h().notifications.filter((n) => n.userId === state.me.user.id);
  const visible = (locationId: string | null) =>
    locationId === null || state.locations.some((l) => l.id === locationId);

  const chosen = (locationId: string | null, kind: NotifyKind, channel: PreferenceChannel) =>
    h().preferences.find(
      (x) => x.locationId === locationId && x.kind === kind && x.channel === channel,
    )?.enabled;

  const settings = (): NotificationSettings => {
    const s = h().settings;
    return {
      timezone: state.me.profile.timezone,
      digestTime: s.digestTime,
      quietFrom: s.quietFrom,
      quietTo: s.quietTo,
      smtpConfigured: s.smtpConfigured,
      push: s.push,
      channels: h().channels,
      locations: state.locations.map((l) => {
        const kinds: Partial<Record<NotifyKind, KindPreference>> = {};
        const shown = l.role === 'viewer' ? (['membership'] as NotifyKind[]) : LOCATION_KINDS;
        for (const kind of shown) {
          const pref = {} as Record<PreferenceChannel, boolean>;
          let isDefault = true;
          for (const channel of PREFERENCE_CHANNELS) {
            const fallback = channelDefault(l.role, kind, channel);
            const value = chosen(l.id, kind, channel);
            if (value !== undefined && value !== fallback) isDefault = false;
            pref[channel] = value ?? fallback;
          }
          kinds[kind] = { ...pref, isDefault };
        }
        return { locationId: l.id, name: l.name, role: l.role, kinds };
      }),
      account: { aiSummary: { email: chosen(null, 'ai_summary', 'email') ?? s.aiSummaryEmail } },
    };
  };

  const pushChannel = (): Channel => {
    let ch = h().channels.find((c) => c.kind === 'webpush');
    if (!ch) {
      ch = {
        id: newId(),
        kind: 'webpush',
        label: null,
        displayHost: null,
        verifiedAt: now(),
        failingSince: null,
        subscriptions: [],
      };
      h().channels.push(ch);
    }
    return ch;
  };

  return [
    // ----- settings, preferences, channels (T15) -----
    route('GET', p.notificationSettings, () => {
      ensureSeeded(state);
      return settings();
    }),
    route('PUT', p.notificationSettings, ({ body }) => {
      const b = body as PutNotificationSettingsBody;
      const s = h().settings;
      if (b.digestTime !== undefined && !TIME.test(b.digestTime))
        return invalid('digestTime: HH:MM');
      const from = b.quietFrom === undefined ? s.quietFrom : b.quietFrom;
      const to = b.quietTo === undefined ? s.quietTo : b.quietTo;
      if ((from === null) !== (to === null)) return invalid('quietFrom, quietTo: both or neither');
      if ((from && !TIME.test(from)) || (to && !TIME.test(to)))
        return invalid('quiet hours: HH:MM');
      if (b.digestTime !== undefined) s.digestTime = b.digestTime;
      s.quietFrom = from;
      s.quietTo = to;
      return settings();
    }),
    route('PUT', p.notificationPreferences, ({ body }) => {
      const b = body as PutPreferencesBody;
      if (!Array.isArray(b.items) || b.items.length > 200) return invalid('items: at most 200');
      for (const item of b.items) {
        const account = (ACCOUNT_LEVEL_KINDS as readonly string[]).includes(item.kind);
        if (account !== (item.locationId === null))
          return invalid('locationId: null only for account-level kinds');
        const loc = item.locationId
          ? state.locations.find((l) => l.id === item.locationId)
          : undefined;
        if (item.locationId && !loc) return notFound();
        const fallback = loc
          ? channelDefault(loc.role, item.kind, item.channel)
          : h().settings.aiSummaryEmail;
        const same = (x: StoredPreference) =>
          x.locationId === item.locationId && x.kind === item.kind && x.channel === item.channel;
        h().preferences = h().preferences.filter((x) => !same(x));
        // A value equal to the default deletes the row.
        if (item.enabled !== fallback) h().preferences.push({ ...item });
      }
      return settings();
    }),
    route('POST', p.channels, ({ body }) => {
      const b = body as CreateChannelBody;
      if (b.kind !== 'webhook') return invalid('kind: webhook');
      let url: URL;
      try {
        url = new URL(b.url);
      } catch {
        return invalid('url: an https URL');
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:')
        return invalid('url: an https URL');
      if (h().channels.filter((c) => c.kind === 'webhook').length >= MAX_WEBHOOK_CHANNELS)
        return err(409, 'conflict', `At most ${MAX_WEBHOOK_CHANNELS} webhooks.`);
      const channel: Channel = {
        id: newId(),
        kind: 'webhook',
        label: b.label ?? null,
        displayHost: url.host,
        verifiedAt: null,
        failingSince: null,
      };
      h().channels.push(channel);
      // The signing secret, shown once (never returned again).
      return reply(201, { channel, secret: 'whsec_mock_2HX9RB5MT0QD7KQ4MZ' });
    }),
    route('DELETE', p.channel(':id'), ({ params }) => {
      const ch = h().channels.find((c) => c.id === params.id);
      if (!ch) return notFound();
      if (ch.kind === 'email')
        return invalid('The email channel stays; turn its preferences off instead.');
      h().channels = h().channels.filter((c) => c !== ch);
      return reply(204);
    }),
    route('POST', p.channelTest(':id'), ({ params }) => {
      const ch = h().channels.find((c) => c.id === params.id);
      if (!ch) return notFound();
      return { ok: true, ...(ch.kind === 'webhook' ? { status: 200 } : {}) };
    }),
    route('POST', p.pushSubscriptions, ({ body }) => {
      const b = body as CreatePushSubscriptionBody;
      if (!b.endpoint?.startsWith('https://')) return invalid('endpoint: an https URL');
      const ch = pushChannel();
      ch.subscriptions ??= [];
      const id = newId();
      ch.subscriptions.push({ id, label: b.label ?? null, createdAt: now(), lastSuccessAt: null });
      return reply(201, { id });
    }),
    route('DELETE', p.pushSubscription(':id'), ({ params }) => {
      for (const ch of h().channels) {
        const before = ch.subscriptions?.length ?? 0;
        ch.subscriptions = ch.subscriptions?.filter((s) => s.id !== params.id);
        if ((ch.subscriptions?.length ?? 0) < before) return reply(204);
      }
      return notFound();
    }),
    route('POST', p.pushSubscriptionTest(':id'), ({ params }) => {
      const found = h().channels.some((c) => c.subscriptions?.some((s) => s.id === params.id));
      return found ? { ok: true, status: 201 } : notFound();
    }),

    // ----- the notification centre (T16) -----
    route('GET', p.notifications, ({ query }) => {
      ensureSeeded(state);
      const unreadOnly = query.get('unread') === '1';
      const kind = query.get('kind');
      const loc = query.get('locationId');
      const rows = mine()
        .filter((n) => visible(n.locationId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const items = rows
        .filter(
          (n) =>
            (!unreadOnly || !n.readAt) &&
            (!kind || n.kind === kind) &&
            (!loc || n.locationId === loc),
        )
        .map((n) => notificationView(state, n));
      return {
        ...paginate(items, query, 20),
        unread: rows.filter((n) => !n.readAt).length,
      };
    }),
    route('GET', p.notificationsCount, () => ({
      unread: mine().filter((n) => visible(n.locationId) && !n.readAt).length,
    })),
    route('POST', p.notificationsRead, ({ body }) => {
      const b = body as ReadNotificationsBody;
      const at = now();
      if ('all' in b && b.all) {
        for (const n of mine()) n.readAt ??= at;
      } else if ('ids' in b && Array.isArray(b.ids)) {
        if (b.ids.length > 200) return invalid('ids: at most 200');
        for (const n of mine()) if (b.ids.includes(n.id)) n.readAt ??= at;
      } else return invalid('ids or all');
      return { unread: mine().filter((n) => visible(n.locationId) && !n.readAt).length };
    }),
  ];
}
