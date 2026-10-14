import type { RelayChannelKind } from '@kept/shared';
import type pg from 'pg';
import { type Keyring, type MasterKey, open, type Sealed, seal } from '../crypto/envelope.js';
import { invalid } from '../http/errors.js';
import type { MailLocale } from '../mail/messages.js';
import { guardedFetch, PrivateAddressError } from '../net/ssrf.js';
import type { ChannelMessage } from '../reminders/channel.js';
import { type PushPayload, testPush } from './push.js';
import { webhookAad } from './webhook.js';

// ntfy and Telegram channels (1.3, D227; D30). Each is a person's own channel, like a webhook: its
// settings are sealed in `notification_channels.config_ciphertext` (§7.3, the same AAD as a
// webhook's: table, row id, 'config'), only the system side opens them, and a message goes out at
// once, in the person's language, with the words a push would have (notify/push.ts).
//
// - ntfy (docs.ntfy.sh/publish, read 2026-10-14): JSON POSTed to the server's root URL,
//   `{topic, title, message, priority 1–5, tags, click}`; an access token as
//   `Authorization: Bearer <token>`. The server is the person's (ntfy.sh or their own), so it goes
//   through guardedFetch(): private addresses only when the instance allows them (a LAN ntfy), and
//   no redirects. A topic is `^[-_A-Za-z0-9]{1,64}$` (ntfy's server.go, topicRegex).
// - Telegram (core.telegram.org/bots/api, read 2026-10-14): `sendMessage` with `chat_id` and
//   `text` (1–4096 characters) at https://api.telegram.org/bot<token>/sendMessage; the answer is
//   `{ok, description?}`. Plain text, no parse mode, so nothing in a thing's name is markup. The
//   host is fixed, still fetched through the guard (never private).
// - Apprise (1.5, D232; caronc/apprise-api's README and apprise_api/api/views.py, read
//   2026-10-14): JSON POSTed to the stateless `<KEPT_APPRISE_URL>/notify/` with `{urls, title,
//   body, type, format}`; `urls` is the person's Apprise URLs, comma-separated (Apprise's own
//   `add()` splits them). 200 is sent, 424 means a destination failed, 400 a bad request. The
//   Apprise API server is the operator's (KEPT_APPRISE_URL, usually a container beside Kept), so
//   it is reached on the private network on purpose, still with no redirects. Apprise itself
//   then reaches the services the URLs name; the generic ones (`json://`, `xml://`, `form://`
//   and their `s` forms) can point at any host, so they are refused unless the instance allows
//   private addresses, as for every other user-supplied target (D128).
// A failure returns a short code (`http_401`, `timeout`, `private_address`, `telegram_400`,
// `apprise_424`), never the token, the topic or a URL.

export type NtfyConfig = { server: string; topic: string; token: string | null };
export type TelegramConfig = { botToken: string; chatId: string };
export type AppriseConfig = { urls: string[] };
export type RelayConfig =
  | ({ kind: 'ntfy' } & NtfyConfig)
  | ({ kind: 'telegram' } & TelegramConfig)
  | ({ kind: 'apprise' } & AppriseConfig);

export const TELEGRAM_API = 'https://api.telegram.org';
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
/** A bot token as BotFather issues it: the bot's id, a colon, then the secret part. */
const BOT_TOKEN = /^\d{1,20}:[A-Za-z0-9_-]{20,100}$/;
/** A chat's numeric id (negative for groups and channels), or a public @username. */
const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/;
const NTFY_TOKEN = /^[\x21-\x7e]{1,200}$/;
const RELAY_TIMEOUT_MS = 10_000;
/** Apprise fans out to every URL before it answers: give it longer. */
const APPRISE_TIMEOUT_MS = 20_000;
export const MAX_APPRISE_URLS = 10;
/** An Apprise URL: a service scheme, `://`, then the service's own part. */
const APPRISE_URL = /^([a-z][a-z0-9+.-]{0,31}):\/\/\S{1,480}$/i;
/** Apprise's generic schemes, which reach any host (json://, xml://, form://, and https forms). */
const GENERIC_SCHEMES = new Set(['json', 'jsons', 'xml', 'xmls', 'form', 'forms']);

const schemeOf = (url: string) => (APPRISE_URL.exec(url)?.[1] ?? '').toLowerCase();
/** Whether these Apprise URLs need the instance to allow private addresses. */
export const appriseNeedsPrivate = (urls: readonly string[]) =>
  urls.some((u) => GENERIC_SCHEMES.has(schemeOf(u)));
const TELEGRAM_MAX = 4096;
/** ntfy's message limit is 4,096 bytes before it turns the text into an attachment. */
const NTFY_MAX_BYTES = 4000;

/** The ntfy server a person typed, as the base its JSON is POSTed to (always ends in `/`). */
export function ntfyServer(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw invalid('server: an http or https address, like https://ntfy.sh.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw invalid('server: an http or https address, like https://ntfy.sh.');
  }
  if (url.username || url.password) throw invalid('server: no user name or password in it.');
  if (url.search || url.hash) throw invalid('server: no query or fragment.');
  if (raw.length > 500) throw invalid('server: at most 500 characters.');
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  return url;
}

/** The settings from a create body, checked. */
export function relayConfigFrom(
  body:
    | { kind: 'ntfy'; server: string; topic: string; token?: string | undefined }
    | { kind: 'telegram'; botToken: string; chatId: string }
    | { kind: 'apprise'; urls: string },
  opts: { allowPrivate: boolean } = { allowPrivate: false },
): RelayConfig {
  if (body.kind === 'apprise') {
    const urls = body.urls
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter(Boolean);
    if (urls.length === 0) throw invalid('urls: at least one Apprise URL, like discord://….');
    if (urls.length > MAX_APPRISE_URLS) {
      throw invalid(`urls: at most ${MAX_APPRISE_URLS} Apprise URLs.`);
    }
    for (const u of urls) {
      if (!APPRISE_URL.test(u)) {
        throw invalid('urls: each one a service URL, like discord://… or mailto://….');
      }
    }
    if (!opts.allowPrivate && appriseNeedsPrivate(urls)) {
      throw invalid(
        "urls: json://, xml:// and form:// URLs can reach this server's own network. An instance admin can allow private addresses in Admin → Settings.",
      );
    }
    return { kind: 'apprise', urls };
  }
  if (body.kind === 'ntfy') {
    const server = ntfyServer(body.server).toString();
    const topic = body.topic.trim();
    if (!TOPIC.test(topic)) {
      throw invalid('topic: letters, digits, - and _, at most 64 characters.');
    }
    const token = body.token?.trim() || null;
    if (token !== null && !NTFY_TOKEN.test(token)) throw invalid('token: no spaces.');
    return { kind: 'ntfy', server, topic, token };
  }
  const botToken = body.botToken.trim();
  const chatId = body.chatId.trim();
  if (!BOT_TOKEN.test(botToken)) {
    throw invalid('botToken: the token BotFather gave you, like 123456:ABC-DEF….');
  }
  if (!CHAT_ID.test(chatId)) throw invalid('chatId: a number, or a public @username.');
  return { kind: 'telegram', botToken, chatId };
}

/** What a channel shows instead of its secrets: the ntfy server's host, Telegram's API host, the
 * services an Apprise channel's URLs name. */
export function relayDisplayHost(config: RelayConfig): string {
  if (config.kind === 'apprise') {
    return [...new Set(config.urls.map(schemeOf))].join(', ').slice(0, 255);
  }
  return config.kind === 'ntfy' ? new URL(config.server).host : new URL(TELEGRAM_API).host;
}

export function sealRelayConfig(master: MasterKey, channelId: string, config: RelayConfig): Sealed {
  return seal(master, JSON.stringify(config), webhookAad(channelId));
}

export function openRelayConfig(
  keyring: Keyring,
  channelId: string,
  kind: RelayChannelKind,
  sealed: Sealed,
): RelayConfig {
  const p = JSON.parse(open(keyring, sealed, webhookAad(channelId)).toString('utf8'));
  if (kind === 'apprise') {
    return { kind, urls: Array.isArray(p.urls) ? p.urls.map(String) : [] };
  }
  return kind === 'ntfy'
    ? { kind, server: String(p.server), topic: String(p.topic), token: p.token ?? null }
    : { kind, botToken: String(p.botToken), chatId: String(p.chatId) };
}

/** A relay channel's sealed settings, read as kept_system; null when it isn't that user's. */
export async function relayChannel(
  client: pg.ClientBase,
  channelId: string,
  userId: string,
): Promise<{ id: string; kind: RelayChannelKind; sealed: Sealed } | null> {
  const { rows } = await client.query<{
    id: string;
    kind: RelayChannelKind;
    config_ciphertext: Sealed;
  }>(
    `SELECT id, kind, config_ciphertext FROM public.notification_channels
      WHERE id = $1 AND user_id = $2 AND kind IN ('ntfy', 'telegram', 'apprise')`,
    [channelId, userId],
  );
  const r = rows[0];
  return r ? { id: r.id, kind: r.kind, sealed: r.config_ciphertext } : null;
}

/** One message's words: a push's title, body and link, and how urgent it is. */
export type RelayText = { title: string; body: string; url: string; urgent: boolean };

/** The words for a test, in the person's language. */
export function relayTest(locale: MailLocale, publicUrl: string): RelayText {
  return fromPush(testPush(locale), publicUrl, false);
}

export function fromPush(p: PushPayload, publicUrl: string, urgent: boolean): RelayText {
  return { title: p.title, body: p.body, url: new URL(p.url, publicUrl).toString(), urgent };
}

export type RelayResult =
  | { ok: true; status: number }
  | { ok: false; status?: number; error: string };
export type RelayFetch = (allowPrivate: boolean) => typeof fetch;

function truncateBytes(text: string, max: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= max) return text;
  // Cut on a character boundary, then mark the cut.
  let cut = buf.subarray(0, max - 3).toString('utf8');
  if (cut.endsWith('�')) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Sends one message. Never throws. */
export async function sendRelay(
  config: RelayConfig,
  text: RelayText,
  opts: {
    allowPrivate: boolean;
    fetchFor?: RelayFetch;
    /** KEPT_APPRISE_URL: the Apprise API server; null when the operator hasn't set one. */
    appriseUrl?: string | null;
  },
): Promise<RelayResult> {
  const fetchFor = opts.fetchFor ?? ((allow) => guardedFetch({ allowPrivate: allow }));
  if (config.kind === 'apprise') {
    if (!opts.appriseUrl) return { ok: false, error: 'apprise_not_set_up' };
    // Allowed when the channel was made, maybe not any more.
    if (!opts.allowPrivate && appriseNeedsPrivate(config.urls)) {
      return { ok: false, error: 'private_address' };
    }
  }
  // The operator's Apprise server is on the private network by design; the person's ntfy server
  // only when the instance allows it; Telegram never.
  const fetcher = fetchFor(
    config.kind === 'apprise' ? true : config.kind === 'ntfy' ? opts.allowPrivate : false,
  );
  try {
    if (config.kind === 'apprise') {
      const base = new URL(opts.appriseUrl as string);
      if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
      const res = await fetcher(new URL('notify/', base), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'Kept-Notify/1' },
        body: JSON.stringify({
          urls: config.urls.join(','),
          title: text.title,
          body: `${text.body}\n${text.url}`,
          type: text.urgent ? 'warning' : 'info',
          format: 'text',
        }),
        signal: AbortSignal.timeout(APPRISE_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      return res.ok
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, error: `apprise_${res.status}` };
    }
    if (config.kind === 'ntfy') {
      const res = await fetcher(config.server, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Kept-Notify/1',
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({
          topic: config.topic,
          title: text.title,
          message: truncateBytes(text.body, NTFY_MAX_BYTES),
          priority: text.urgent ? 4 : 3,
          click: text.url,
        }),
        signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      return res.ok
        ? { ok: true, status: res.status }
        : { ok: false, status: res.status, error: `http_${res.status}` };
    }
    const all = `${text.title}\n${text.body}\n${text.url}`;
    const res = await fetcher(`${TELEGRAM_API}/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Kept-Notify/1' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: all.length > TELEGRAM_MAX ? `${all.slice(0, TELEGRAM_MAX - 1)}…` : all,
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const answer = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return res.ok && answer?.ok === true
      ? { ok: true, status: res.status }
      : { ok: false, status: res.status, error: `telegram_${res.status}` };
  } catch (err) {
    for (let c: unknown = err, i = 0; c && i < 6; c = (c as { cause?: unknown }).cause, i++) {
      if (c instanceof PrivateAddressError) return { ok: false, error: 'private_address' };
    }
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') return { ok: false, error: 'timeout' };
    const text2 =
      err instanceof Error
        ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`
        : '';
    if (/redirect/i.test(text2)) return { ok: false, error: 'redirect_refused' };
    return { ok: false, error: 'network' };
  }
}

/** Whether a message can go to a relay channel: alerts go to admins' push and mail only. */
export const relayCarries = (message: ChannelMessage) => message.mode !== 'alert';
