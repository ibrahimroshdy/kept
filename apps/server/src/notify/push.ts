import { createHash } from 'node:crypto';
import https from 'node:https';
import { isIP } from 'node:net';
import type pg from 'pg';
import webpush from 'web-push';
import { withSystem } from '../db/scope.js';
import type { MailLocale } from '../mail/messages.js';
import { guardedLookup, isPrivateAddress, PrivateAddressError } from '../net/ssrf.js';
import type { VapidDetails } from './vapid.js';
import { REMINDER_COUNT, REMINDER_WORDS, type ReminderFacts, shortTitle } from './words.js';

// Web push (D139, L112; step-4 plan T15, Q12), over web-push 3.6.7's sendNotification() with the
// VAPID details passed per call (no global setVapidDetails, so a key change needs no restart).
//
// - A subscription's endpoint is browser-supplied, so a crafted one could aim the server at the
//   LAN. Push services are public: every send goes through an `https.Agent` whose connect-time
//   lookup refuses private addresses (net/ssrf.ts guardedLookup), whatever the instance's
//   `ssrf_allow_private` says, and an IP-literal host is checked first (Node skips `lookup` for
//   one). web-push always speaks TLS (spike 2026-09-30-step4-push.md), and honours `agent` only
//   when it is an https.Agent.
// - 404 and 410 mean the subscription is gone: it is deleted (L112). 429 and 5xx are a failure to
//   retry; 413 is a payload bug.
// - The payload is text only, `{title, body, url, tag}`, under 3 KB: no money, no contact details.
// - `topic` (≤ 32 URL-safe base64 characters) makes a re-send replace the pending one instead of
//   stacking: the first 32 characters of the occurrence key's SHA-256.

/** The push payload the service worker shows (apps/web/src/sw.ts). */
export type PushPayload = { title: string; body: string; url: string; tag: string };

export type PushOptions = {
  /** `high` for an overdue reminder, `normal` for a digest or a test. */
  urgency: 'high' | 'normal';
  topic?: string | undefined;
  /** Seconds the push service keeps it for an offline device; a day by default. */
  ttl?: number;
};

export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** One send's outcome. `error` is a delivery error code (`^[a-z_0-9]{1,40}$`). */
export type PushResult =
  | { ok: true; status: number }
  | { ok: false; gone: boolean; status?: number; error: string };

/** How a push leaves the process; tests pass a local receiver's. */
export type PushTransport = {
  send: typeof webpush.sendNotification;
  agent: https.Agent;
  /** Refuse an IP-literal private host before sending (Node skips the agent's `lookup` for a
   * literal). Always true for the real transport; a test's receiver on 127.0.0.1 turns it off. */
  refuseLiterals: boolean;
};

export const PUSH_TTL_SECONDS = 86_400;
/** web-push's socket timeout for one send. */
const PUSH_TIMEOUT_MS = 10_000;
/** Payloads stay under this (the plan's 3 KB, well within every push service's 4 KB). */
export const PUSH_MAX_BYTES = 3072;

let defaultTransport: PushTransport | null = null;

/** The real transport: web-push over an agent that refuses private addresses (Q12). */
export function publicPushTransport(): PushTransport {
  defaultTransport ??= {
    send: webpush.sendNotification,
    agent: new https.Agent({ lookup: guardedLookup(), keepAlive: true }),
    refuseLiterals: true,
  };
  return defaultTransport;
}

/** A push topic for an occurrence key: base64url of its SHA-256, the first 32 characters. */
export function pushTopic(key: string): string {
  return createHash('sha256').update(key).digest('base64url').slice(0, 32);
}

/** The payload as sent: JSON under PUSH_MAX_BYTES, the body shortened when it must be. */
export function encodePayload(p: PushPayload): string {
  let body = p.body;
  let json = JSON.stringify({ ...p, body });
  while (Buffer.byteLength(json) > PUSH_MAX_BYTES && body.length > 0) {
    body = [...body].slice(0, -Math.max(1, Math.ceil(body.length / 10))).join('');
    json = JSON.stringify({ ...p, body: `${body}…` });
  }
  return json;
}

function errorCode(err: unknown): { gone: boolean; status?: number; error: string } {
  if (err instanceof webpush.WebPushError) {
    const status = err.statusCode;
    return { gone: status === 404 || status === 410, status, error: `http_${status}` };
  }
  for (let c: unknown = err, i = 0; c && i < 6; c = (c as { cause?: unknown }).cause, i++) {
    if (c instanceof PrivateAddressError) return { gone: false, error: 'private_address' };
  }
  const message = err instanceof Error ? err.message : '';
  if (/timeout/i.test(message)) return { gone: false, error: 'timeout' };
  return { gone: false, error: 'network' };
}

/** Sends one push. Never throws: the outcome says what happened. */
export async function sendPush(
  target: PushTarget,
  payload: PushPayload,
  opts: PushOptions,
  deps: { details: VapidDetails; transport?: PushTransport },
): Promise<PushResult> {
  let url: URL;
  try {
    url = new URL(target.endpoint);
  } catch {
    return { ok: false, gone: true, error: 'bad_endpoint' };
  }
  if (url.protocol !== 'https:') return { ok: false, gone: true, error: 'bad_endpoint' };
  const transport = deps.transport ?? publicPushTransport();
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (transport.refuseLiterals && isIP(host) !== 0 && isPrivateAddress(host)) {
    return { ok: false, gone: false, error: 'private_address' };
  }
  try {
    const res = await transport.send(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      encodePayload(payload),
      {
        vapidDetails: deps.details,
        TTL: opts.ttl ?? PUSH_TTL_SECONDS,
        urgency: opts.urgency,
        ...(opts.topic ? { topic: opts.topic } : {}),
        timeout: PUSH_TIMEOUT_MS,
        agent: transport.agent,
      },
    );
    return { ok: true, status: res.statusCode };
  } catch (err) {
    return { ok: false, ...errorCode(err) };
  }
}

/** What sending to every device of a person did. */
export type UserPushResult = {
  /** `sent` when a device took it; `skipped` when there was none left to send to (never
   * subscribed, or every subscription gone); `failed` otherwise. */
  status: 'sent' | 'skipped' | 'failed';
  sent: number;
  gone: number;
  failed: number;
  /** The last failure's code, when nothing was sent. */
  error?: string;
  /** The last HTTP status a push service answered. */
  httpStatus?: number;
};

/**
 * Sends `payload` to every push subscription `userId` has, as kept_system (the deliver jobs, and
 * a test send): records success, counts failures, and deletes a subscription whose push service
 * says it's gone (404, 410). `only` limits it to one subscription (its test).
 */
export async function pushToUser(
  systemPool: pg.Pool,
  userId: string,
  payload: PushPayload,
  opts: PushOptions,
  deps: { details: VapidDetails; transport?: PushTransport; only?: string },
): Promise<UserPushResult> {
  const subs = await withSystem(systemPool, async (_tx, client) => {
    const { rows } = await client.query<PushTarget & { id: string }>(
      `SELECT id, endpoint, p256dh, auth FROM public.push_subscriptions
        WHERE user_id = $1 AND ($2::uuid IS NULL OR id = $2::uuid) ORDER BY created_at, id`,
      [userId, deps.only ?? null],
    );
    return rows;
  });
  const out: UserPushResult = { status: 'skipped', sent: 0, gone: 0, failed: 0 };
  for (const sub of subs) {
    const res = await sendPush(sub, payload, opts, deps);
    await withSystem(systemPool, async (_tx, client) => {
      if (res.ok) {
        await client.query(
          'UPDATE public.push_subscriptions SET last_success_at = now(), failures = 0 WHERE id = $1',
          [sub.id],
        );
      } else if (res.gone) {
        await client.query('DELETE FROM public.push_subscriptions WHERE id = $1', [sub.id]);
      } else {
        await client.query(
          'UPDATE public.push_subscriptions SET failures = failures + 1 WHERE id = $1',
          [sub.id],
        );
      }
    });
    if (res.ok) {
      out.sent += 1;
      out.httpStatus = res.status;
    } else if (res.gone) {
      out.gone += 1;
      if (res.status !== undefined) out.httpStatus = res.status;
    } else {
      out.failed += 1;
      out.error = res.error;
      if (res.status !== undefined) out.httpStatus = res.status;
    }
  }
  if (out.sent > 0) {
    out.status = 'sent';
    delete out.error;
  } else if (out.failed > 0) out.status = 'failed';
  return out;
}

/** A reminder as a push (overdue ones go out at once, D29): the item's title and where it is. */
export function reminderPush(locale: MailLocale, facts: ReminderFacts, topic: string): PushPayload {
  const w = REMINDER_WORDS[locale];
  return {
    title: shortTitle(w, facts),
    body: `${w.headline(facts)}\n${w.where(facts)}`,
    url: facts.link,
    tag: topic,
  };
}

const DIGEST_LINES = 4;

/** A day's digest as one push: how many, and the first few headlines. */
export function digestPush(locale: MailLocale, items: ReminderFacts[], day: string): PushPayload {
  const w = REMINDER_WORDS[locale];
  const lines = items.slice(0, DIGEST_LINES).map((f) => w.headline(f));
  if (items.length > DIGEST_LINES) lines.push('…');
  return {
    title: `Kept · ${REMINDER_COUNT[locale](items.length)}`,
    body: lines.join('\n'),
    url: '/',
    tag: `digest-${day}`,
  };
}

const TEST_PUSH: Record<MailLocale, { title: string; body: string }> = {
  en: { title: 'Kept', body: 'Notifications reach this device.' },
  ar: { title: 'Kept', body: 'تصل الإشعارات إلى هذا الجهاز.' },
  fr: { title: 'Kept', body: 'Les notifications arrivent sur cet appareil.' },
  de: { title: 'Kept', body: 'Benachrichtigungen kommen auf diesem Gerät an.' },
  it: { title: 'Kept', body: 'Le notifiche arrivano su questo dispositivo.' },
};

/** The test send's payload (Settings → Me → Notifications → Test). */
export function testPush(locale: MailLocale): PushPayload {
  return { ...TEST_PUSH[locale], url: '/settings/me/notifications', tag: 'kept-test' };
}
