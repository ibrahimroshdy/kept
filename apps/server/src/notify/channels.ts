import { MAX_WEBHOOK_CHANNELS, newId } from '@kept/shared';
import type pg from 'pg';
import type { Keyring, MasterKey } from '../crypto/envelope.js';
import type { Pools } from '../db/pools.js';
import type { Tx } from '../db/scope.js';
import { withSystem } from '../db/scope.js';
import { AppError, conflict, invalid, notFound } from '../http/errors.js';
import type { Mailer } from '../mail/mailer.js';
import { mailLocale } from '../mail/messages.js';
import { auditMine } from './prefs.js';
import { type PushTransport, pushToUser, testPush } from './push.js';
import type { PushSource } from './vapid.js';
import {
  newWebhookSecret,
  openWebhookConfig,
  postWebhook,
  sealWebhookConfig,
  testEnvelope,
  type WebhookFetch,
  webhookAllowsPrivate,
  webhookChannel,
} from './webhook.js';

// A person's channels (D30, D139; plan T7, T15, Q13): one email channel (made lazily; managed
// accounts never get one), one web-push channel whose devices are push_subscriptions, and up to
// five webhooks. kept_app reads every column but a webhook's sealed config; this file never
// selects `*` from notification_channels.

/** What routes and jobs need to reach people (http/routes.ts InventoryDeps.notify). */
export type NotifyDeps = {
  /** The instance's push setup (vapid.ts createPushSource); null: push isn't available. */
  push: PushSource | null;
  mailer: Mailer;
  /** KEPT_SMTP_URL is set: email reminders can go out. */
  mailConfigured: boolean;
  /** Tests: how a push or a webhook leaves the process. */
  transport?: { push?: PushTransport; webhookFetch?: WebhookFetch };
};

export type ChannelView = {
  id: string;
  kind: 'email' | 'webpush' | 'webhook';
  label: string | null;
  displayHost: string | null;
  verifiedAt: string | null;
  failingSince: string | null;
  subscriptions?: Array<{
    id: string;
    label: string | null;
    createdAt: string;
    lastSuccessAt: string | null;
  }>;
};

type ChannelRow = {
  id: string;
  kind: ChannelView['kind'];
  label: string | null;
  display_host: string | null;
  verified_at: Date | null;
  failing_since: Date | null;
};

const CHANNEL_COLUMNS = 'id, kind, label, display_host, verified_at, failing_since';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function channelOf(r: ChannelRow): ChannelView {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    displayHost: r.display_host,
    verifiedAt: iso(r.verified_at),
    failingSince: iso(r.failing_since),
  };
}

/** The caller's channels, email first, then push (with its devices), then webhooks. */
export async function myChannels(client: pg.ClientBase): Promise<ChannelView[]> {
  const { rows } = await client.query<ChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM public.notification_channels
      WHERE user_id = kept.current_user_id()
      ORDER BY array_position(ARRAY['email', 'webpush', 'webhook'], kind), created_at, id`,
  );
  const subs = await client.query<{
    id: string;
    label: string | null;
    created_at: Date;
    last_success_at: Date | null;
  }>(
    `SELECT id, label, created_at, last_success_at FROM public.push_subscriptions
      WHERE user_id = kept.current_user_id() ORDER BY created_at, id`,
  );
  return rows.map((r) => {
    const view = channelOf(r);
    if (r.kind === 'webpush') {
      view.subscriptions = subs.rows.map((s) => ({
        id: s.id,
        label: s.label,
        createdAt: s.created_at.toISOString(),
        lastSuccessAt: iso(s.last_success_at),
      }));
    }
    return view;
  });
}

/** The caller's account as mail sees it (kept_auth: schema auth). */
export type MailIdentity = {
  email: string;
  emailVerified: boolean;
  locale: string | null;
  managed: boolean;
};

export async function mailIdentity(
  pools: Pick<Pools, 'auth'>,
  client: pg.ClientBase,
  userId: string,
): Promise<MailIdentity | null> {
  const { rows } = await pools.auth.query<{ email: string; email_verified: boolean }>(
    'SELECT email, email_verified FROM auth."user" WHERE id = $1',
    [userId],
  );
  const user = rows[0];
  if (!user) return null;
  const profile = await client.query<{ locale: string; managed: boolean }>(
    'SELECT locale, managed FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );
  return {
    email: user.email,
    emailVerified: user.email_verified === true,
    locale: profile.rows[0]?.locale ?? null,
    managed: profile.rows[0]?.managed === true,
  };
}

/**
 * The caller's email channel, made the first time it's needed (Q13). A managed account never
 * gets one: it has no mailbox (`…@managed.invalid`, D197). Verified once the address is.
 */
export async function ensureEmailChannel(client: pg.ClientBase, who: MailIdentity): Promise<void> {
  if (who.managed) return;
  await client.query(
    `INSERT INTO public.notification_channels (user_id, kind, verified_at)
     VALUES (kept.current_user_id(), 'email', CASE WHEN $1 THEN now() END)
     ON CONFLICT (user_id) WHERE kind = 'email' DO NOTHING`,
    [who.emailVerified],
  );
  if (who.emailVerified) {
    await client.query(
      `UPDATE public.notification_channels SET verified_at = now()
        WHERE user_id = kept.current_user_id() AND kind = 'email' AND verified_at IS NULL`,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

/** The URL a webhook may have: http(s), no credentials in it, at most 2,000 characters. */
export function webhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid('url: an http or https address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid('url: an http or https address.');
  }
  if (url.username || url.password) throw invalid('url: no user name or password in it.');
  if (raw.length > 2000) throw invalid('url: at most 2,000 characters.');
  return url;
}

/** POST /api/v1/me/channels: a webhook, its URL and secret sealed together; the secret once. */
export async function createWebhook(
  tx: Tx,
  client: pg.ClientBase,
  master: MasterKey,
  userId: string,
  body: { url: string; label?: string | undefined },
  requestId: string,
): Promise<{ channel: ChannelView; secret: string }> {
  const url = webhookUrl(body.url);
  const { rows: count } = await client.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.notification_channels
      WHERE user_id = kept.current_user_id() AND kind = 'webhook'`,
  );
  if ((count[0]?.n ?? 0) >= MAX_WEBHOOK_CHANNELS) {
    throw conflict(`You already have ${MAX_WEBHOOK_CHANNELS} webhooks; remove one first.`);
  }
  const id = newId();
  const secret = newWebhookSecret();
  const sealed = sealWebhookConfig(master, id, { url: url.toString(), secret });
  const label = body.label?.trim() || null;
  const { rows } = await client.query<ChannelRow>(
    `INSERT INTO public.notification_channels
       (id, user_id, kind, label, display_host, config_ciphertext, key_version)
     VALUES ($1, kept.current_user_id(), 'webhook', $2, $3, $4::jsonb, $5)
     RETURNING ${CHANNEL_COLUMNS}`,
    [id, label, url.host, JSON.stringify(sealed), master.keyVersion],
  );
  const channel = channelOf(rows[0] as ChannelRow);
  await auditMine(tx, userId, {
    action: 'channel.create',
    entity: { type: 'notification_channel', id },
    after: { kind: 'webhook', label, display_host: url.host },
    requestId,
  });
  return { channel, secret };
}

/**
 * DELETE /api/v1/me/channels/:id. The email channel stays (400: turn its kinds off instead).
 * Removing the push channel removes this person's devices with it.
 */
export async function deleteChannel(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  id: string,
  requestId: string,
): Promise<void> {
  const { rows } = await client.query<ChannelRow>(
    `SELECT ${CHANNEL_COLUMNS} FROM public.notification_channels
      WHERE id = $1 AND user_id = kept.current_user_id()`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound();
  if (row.kind === 'email') {
    throw invalid('The email channel stays; turn its kinds off instead.');
  }
  await client.query('DELETE FROM public.notification_channels WHERE id = $1', [id]);
  if (row.kind === 'webpush') {
    await client.query(
      'DELETE FROM public.push_subscriptions WHERE user_id = kept.current_user_id()',
    );
  }
  await auditMine(tx, userId, {
    action: 'channel.delete',
    entity: { type: 'notification_channel', id },
    before: { kind: row.kind, label: row.label, display_host: row.display_host },
    after: null,
    requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// Push subscriptions
// ---------------------------------------------------------------------------------------------

export type SubscriptionBody = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label?: string | undefined;
};

/**
 * POST /api/v1/me/push-subscriptions: this device's subscription, made or updated (the same
 * endpoint again), and the person's push channel when it's their first device. An endpoint a
 * browser gives belongs to that browser: if another account had it (someone else signed in on
 * this device before), it moves here, removed there as kept_system first.
 */
export async function upsertSubscription(
  pools: Pick<Pools, 'system'>,
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  body: SubscriptionBody,
  requestId: string,
): Promise<{ id: string; created: boolean }> {
  const url = new URL(body.endpoint);
  if (url.protocol !== 'https:') throw invalid('endpoint: an https address.');
  await withSystem(pools.system, async (_t, sys) => {
    await sys.query('DELETE FROM public.push_subscriptions WHERE endpoint = $1 AND user_id <> $2', [
      body.endpoint,
      userId,
    ]);
  });
  const label = body.label?.trim() || null;
  // The same endpoint again keeps its row (only its label changes: kept_app may update nothing
  // else); new keys for it make a new row, as a new subscription would.
  const { rows: had } = await client.query<{ id: string; p256dh: string; auth: string }>(
    `SELECT id, p256dh, auth FROM public.push_subscriptions
      WHERE endpoint = $1 AND user_id = kept.current_user_id()`,
    [body.endpoint],
  );
  const same = had[0];
  let row: { id: string; created: boolean };
  if (same && same.p256dh === body.keys.p256dh && same.auth === body.keys.auth) {
    if (label !== null) {
      await client.query('UPDATE public.push_subscriptions SET label = $2 WHERE id = $1', [
        same.id,
        label,
      ]);
    }
    row = { id: same.id, created: false };
  } else {
    if (same) await client.query('DELETE FROM public.push_subscriptions WHERE id = $1', [same.id]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth, label)
       VALUES (kept.current_user_id(), $1, $2, $3, $4) RETURNING id`,
      [body.endpoint, body.keys.p256dh, body.keys.auth, label],
    );
    row = { id: (rows[0] as { id: string }).id, created: true };
  }
  await client.query(
    `INSERT INTO public.notification_channels (user_id, kind, verified_at)
     VALUES (kept.current_user_id(), 'webpush', now())
     ON CONFLICT (user_id) WHERE kind = 'webpush' DO NOTHING`,
  );
  await auditMine(tx, userId, {
    action: row.created ? 'push_subscription.create' : 'push_subscription.update',
    entity: { type: 'push_subscription', id: row.id },
    after: { label },
    requestId,
  });
  return row;
}

export async function deleteSubscription(
  tx: Tx,
  client: pg.ClientBase,
  userId: string,
  id: string,
  requestId: string,
): Promise<void> {
  const { rows } = await client.query<{ label: string | null }>(
    `DELETE FROM public.push_subscriptions WHERE id = $1 AND user_id = kept.current_user_id()
     RETURNING label`,
    [id],
  );
  if (!rows[0]) throw notFound();
  await auditMine(tx, userId, {
    action: 'push_subscription.delete',
    entity: { type: 'push_subscription', id },
    before: { label: rows[0].label },
    after: null,
    requestId,
  });
}

// ---------------------------------------------------------------------------------------------
// Test sends (Settings → Me → Notifications → Test; 5 an hour per person, routes.ts)
// ---------------------------------------------------------------------------------------------

export type TestResult = { ok: boolean; status?: number; error?: string };

/** A push to one device, or to all of the person's devices. */
export async function testPushSend(
  deps: NotifyDeps,
  pools: Pick<Pools, 'system'>,
  userId: string,
  locale: string | null,
  only?: string,
): Promise<TestResult> {
  const setup = deps.push ? await deps.push() : null;
  if (!setup?.available) {
    throw new AppError('push_unavailable', 409, "Push notifications aren't available here.");
  }
  const res = await pushToUser(
    pools.system,
    userId,
    testPush(mailLocale(locale)),
    { urgency: 'normal' },
    {
      details: setup.details,
      ...(deps.transport?.push ? { transport: deps.transport.push } : {}),
      ...(only ? { only } : {}),
    },
  );
  return {
    ok: res.status === 'sent',
    ...(res.httpStatus !== undefined ? { status: res.httpStatus } : {}),
    ...(res.status === 'sent' ? {} : { error: res.error ?? 'no_device' }),
  };
}

/** A signed `channel.test` event to one webhook, opened as kept_system. */
export async function testWebhookSend(
  deps: NotifyDeps,
  pools: Pick<Pools, 'system'>,
  keyring: Keyring,
  publicUrl: string,
  userId: string,
  channelId: string,
): Promise<TestResult> {
  const channel = await withSystem(pools.system, (_t, c) => webhookChannel(c, channelId, userId));
  if (!channel) throw notFound();
  const config = openWebhookConfig(keyring, channel.id, channel.sealed);
  const res = await postWebhook(config, testEnvelope(publicUrl, channel.id), {
    allowPrivate: await webhookAllowsPrivate(pools),
    ...(deps.transport?.webhookFetch ? { fetchFor: deps.transport.webhookFetch } : {}),
  });
  if (res.ok) {
    await withSystem(pools.system, (_t, c) =>
      c.query(
        `UPDATE public.notification_channels SET verified_at = now(), failing_since = NULL
          WHERE id = $1`,
        [channel.id],
      ),
    );
  }
  return res.ok
    ? { ok: true, status: res.status }
    : { ok: false, ...(res.status !== undefined ? { status: res.status } : {}), error: res.error };
}

/** A test mail to the person's own address. */
export async function testEmailSend(
  deps: NotifyDeps,
  who: MailIdentity | null,
): Promise<TestResult> {
  if (!who || who.managed) return { ok: false, error: 'no_address' };
  if (!deps.mailConfigured) return { ok: false, error: 'mail_not_configured' };
  try {
    await deps.mailer.send({ kind: 'channel-test', to: who.email, locale: who.locale });
    return { ok: true };
  } catch {
    return { ok: false, error: 'mail_failed' };
  }
}
