import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { allowPrivateAddresses } from '../ai/runtime.js';
import {
  type Aad,
  type Keyring,
  type MasterKey,
  open,
  type Sealed,
  seal,
} from '../crypto/envelope.js';
import type { Pools } from '../db/pools.js';
import { guardedFetch, PrivateAddressError } from '../net/ssrf.js';

// The personal webhook channel (D30, D110, §2.6; step-4 plan T15, Q6).
//
// A person's own notification channel, not a location webhook (those are step 6 and reuse this
// file's signer): one POST of JSON per reminder, event `reminder.due`, carrying ids, the kind, the
// due date and a deep link only. No names, no values, no notes (D110): the receiver asks Kept for
// more with the person's own access, if it can.
//
// - The URL and the signing secret are sealed together (§7.3: `notification_channels|<id>|config`);
//   kept_app can't SELECT the ciphertext, only this file opens it, as kept_system.
// - Sent through guardedFetch(): private addresses refused unless the instance's
//   `ssrf_allow_private` allows them (a receiver on the LAN, e.g. Home Assistant), every redirect
//   refused.
// - Signed `Kept-Signature: t=<unix>,v1=<hex>`, HMAC-SHA256 over `<t>.<raw body>` with the
//   channel's secret. A receiver recomputes it and refuses a stale `t`.

export type WebhookConfig = { url: string; secret: string };

export const webhookAad = (channelId: string): Aad => ({
  table: 'notification_channels',
  rowId: channelId,
  fieldKey: 'config',
});

/** A new signing secret, shown once. */
export function newWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

export function sealWebhookConfig(
  master: MasterKey,
  channelId: string,
  config: WebhookConfig,
): Sealed {
  return seal(master, JSON.stringify(config), webhookAad(channelId));
}

export function openWebhookConfig(
  keyring: Keyring,
  channelId: string,
  sealed: Sealed,
): WebhookConfig {
  const parsed = JSON.parse(open(keyring, sealed, webhookAad(channelId)).toString('utf8'));
  return { url: String(parsed.url), secret: String(parsed.secret) };
}

/** `t=<unix>,v1=<hex>` for a body sent at `t`. */
export function signWebhook(secret: string, t: number, rawBody: string): string {
  const mac = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return `t=${t},v1=${mac}`;
}

/** Whether `header` is a valid signature of `rawBody` (the receiver's side; tests and docs). */
export function verifyWebhook(
  secret: string,
  header: string,
  rawBody: string,
  toleranceSeconds = 300,
  now = Date.now(),
): boolean {
  const parts = new Map(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const given = parts.get('v1') ?? '';
  if (!Number.isInteger(t) || Math.abs(now / 1000 - t) > toleranceSeconds) return false;
  const expected = signWebhook(secret, t, rawBody).split('v1=')[1] ?? '';
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/** The §2.6 envelope. */
export type WebhookEnvelope = {
  id: string;
  event: 'reminder.due' | 'channel.test';
  occurred_at: string;
  location_id?: string;
  occurrence?: { id: string; kind: string; source_type: string; due_on: string | null };
  entity?: { type: 'thing' | 'place' | 'location'; id: string };
  url: string;
};

/** A stable event id for one occurrence on one channel: a retry resends the same id. */
export function eventId(...parts: string[]): string {
  return `evt_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
}

export type OccurrenceForWebhook = {
  id: string;
  location_id: string;
  thing_id: string | null;
  place_id: string | null;
  kind: string;
  source_type: string;
  due_on: string | null;
  created_at: Date;
};

/** A reminder's envelope: ids, kind, due date and the deep link, nothing else (D110). */
export function reminderEnvelope(
  publicUrl: string,
  channelId: string,
  o: OccurrenceForWebhook,
): WebhookEnvelope {
  const entity = o.thing_id
    ? { type: 'thing' as const, id: o.thing_id }
    : o.place_id
      ? { type: 'place' as const, id: o.place_id }
      : { type: 'location' as const, id: o.location_id };
  const path = { thing: '/t/', place: '/p/', location: '/loc/' }[entity.type] + entity.id;
  return {
    id: eventId(o.id, channelId),
    event: 'reminder.due',
    occurred_at: o.created_at.toISOString(),
    location_id: o.location_id,
    occurrence: { id: o.id, kind: o.kind, source_type: o.source_type, due_on: o.due_on },
    entity,
    url: new URL(path, publicUrl).toString(),
  };
}

export function testEnvelope(publicUrl: string, channelId: string): WebhookEnvelope {
  return {
    id: eventId('test', channelId, String(Date.now())),
    event: 'channel.test',
    occurred_at: new Date().toISOString(),
    url: new URL('/settings/me/notifications', publicUrl).toString(),
  };
}

/** One send's outcome. `error` is a delivery error code (`^[a-z_0-9]{1,40}$`). */
export type WebhookResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string };

export type WebhookFetch = (allowPrivate: boolean) => typeof fetch;

const WEBHOOK_TIMEOUT_MS = 10_000;

/** POSTs one envelope, signed. Never throws. Step 6's location webhooks (webhooks/deliver.ts)
 * send their §2.6 payload through it too: anything with an `id` and an `event`. */
export async function postWebhook(
  config: WebhookConfig,
  envelope: Pick<WebhookEnvelope, 'id'> & { event: string },
  opts: { allowPrivate: boolean; fetchFor?: WebhookFetch; now?: () => number },
): Promise<WebhookResult> {
  const body = JSON.stringify(envelope);
  const t = Math.floor((opts.now?.() ?? Date.now()) / 1000);
  const fetcher = (opts.fetchFor ?? ((allow) => guardedFetch({ allowPrivate: allow })))(
    opts.allowPrivate,
  );
  try {
    const res = await fetcher(config.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Kept-Webhook/1',
        'kept-event': envelope.event,
        'kept-delivery': envelope.id,
        'kept-signature': signWebhook(config.secret, t, body),
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    // The body is never read beyond what it takes to free the connection.
    await res.body?.cancel().catch(() => {});
    return res.ok
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `http_${res.status}` };
  } catch (err) {
    for (let c: unknown = err, i = 0; c && i < 6; c = (c as { cause?: unknown }).cause, i++) {
      if (c instanceof PrivateAddressError) return { ok: false, error: 'private_address' };
    }
    const name = err instanceof Error ? err.name : '';
    const text =
      err instanceof Error
        ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`
        : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, error: 'timeout' };
    if (/redirect/i.test(text)) return { ok: false, error: 'redirect_refused' };
    return { ok: false, error: 'network' };
  }
}

/** A webhook channel's sealed config, read as kept_system; null when it isn't that user's webhook. */
export async function webhookChannel(
  client: pg.ClientBase,
  channelId: string,
  userId: string,
): Promise<{
  id: string;
  sealed: Sealed;
  label: string | null;
  displayHost: string | null;
} | null> {
  const { rows } = await client.query<{
    id: string;
    config_ciphertext: Sealed;
    label: string | null;
    display_host: string | null;
  }>(
    `SELECT id, config_ciphertext, label, display_host FROM public.notification_channels
      WHERE id = $1 AND user_id = $2 AND kind = 'webhook'`,
    [channelId, userId],
  );
  const r = rows[0];
  return r
    ? { id: r.id, sealed: r.config_ciphertext, label: r.label, displayHost: r.display_host }
    : null;
}

/** Whether the instance lets webhooks reach private addresses (`ssrf_allow_private`). */
export function webhookAllowsPrivate(pools: Pick<Pools, 'system'>): Promise<boolean> {
  return allowPrivateAddresses(pools);
}
