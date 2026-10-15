import { createECDH, randomBytes } from 'node:crypto';
import https from 'node:https';
import { MAX_WEBHOOK_CHANNELS, newId } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import type { TestApp } from '../../test/app.js';
import { type TestDb, testDb } from '../../test/db.js';
import { call, join, type Person, peopleApp, person } from '../../test/people.js';
import { type Receiver, startReceiver } from '../../test/receiver.js';
import { asOwner } from '../../test/tenancy.js';
import { createLocation, own } from '../../test/things.js';
import type { Keyring, MasterKey, Sealed } from '../crypto/envelope.js';
import { fixedSecretKeys } from '../crypto/keyring.js';
import { withScope } from '../db/scope.js';
import { guardedFetch } from '../net/ssrf.js';
import { LOCATION_KINDS } from './prefs.js';
import { openRelayConfig, TELEGRAM_API } from './relay.js';
import { fixedPushSource } from './vapid.js';
import { openWebhookConfig, verifyWebhook } from './webhook.js';

// Settings → Me → Notifications through the front door (plan T15): the settings and their
// defaults, preferences stored only where they differ from the default, webhook channels (the
// secret shown once, the URL never again, sealed at rest), push subscriptions, and test sends.
// Pushes and webhooks go to local receivers; mail is captured.

let db: TestDb;
let t: TestApp;
let bare: TestApp;
let hook: Receiver;
let service: Receiver;
const master: MasterKey = { key: randomBytes(32), keyVersion: 1 };
const keyring = new Map([[1, master.key]]) as Keyring;
const vapid = webpush.generateVAPIDKeys();
/** Telegram's API, stood in for (its host is fixed): every call, and what it answers. */
const telegram = {
  calls: [] as Array<{ url: string; body: unknown }>,
  answer: { ok: true } as object,
  status: 200,
};

type KindPref = {
  inapp: boolean;
  email: boolean;
  webpush: boolean;
  webhook: boolean;
  ntfy: boolean;
  telegram: boolean;
  apprise: boolean;
  isDefault: boolean;
  set: string[];
};
type Channel = {
  id: string;
  kind: string;
  label: string | null;
  displayHost: string | null;
  verifiedAt: string | null;
  failingSince: string | null;
  subscriptions?: Array<{ id: string; label: string | null }>;
};
type Settings = {
  timezone: string;
  digestTime: string;
  quietFrom: string | null;
  quietTo: string | null;
  smtpConfigured: boolean;
  push: { available: boolean; publicKey: string | null; reason?: string };
  apprise: { available: boolean };
  channels: Channel[];
  locations: Array<{
    locationId: string;
    name: string;
    role: string;
    kinds: Record<string, KindPref>;
  }>;
  account: { aiSummary: { email: boolean }; kinds: Record<string, KindPref> };
};

beforeAll(async () => {
  db = await testDb();
  hook = await startReceiver({ tls: false });
  service = await startReceiver({ tls: true });
  t = await peopleApp(db, {
    mailConfigured: true,
    secretKeys: fixedSecretKeys({ current: master, keyring }),
    notify: {
      push: fixedPushSource({
        available: true,
        publicKey: vapid.publicKey,
        details: { ...vapid, subject: 'mailto:kept@example.org' },
      }),
      // 1.5 (D232): the Apprise API server is the local receiver too.
      appriseUrl: `${hook.url}/apprise`,
      transport: {
        push: {
          send: webpush.sendNotification,
          agent: new https.Agent({ ca: service.ca as Buffer }),
          refuseLiterals: false,
        },
        // ntfy and Apprise go to the local receiver through the guard; Telegram to the stand-in.
        relayFetch: (allowPrivate) =>
          (async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (!url.startsWith(TELEGRAM_API)) return guardedFetch({ allowPrivate })(input, init);
            telegram.calls.push({ url, body: JSON.parse(String(init?.body)) });
            return Response.json(telegram.answer, { status: telegram.status });
          }) as typeof fetch,
      },
    },
  });
  // Kept's own mail from the routes (the channel test) lands in t.mail.
  bare = await peopleApp(db, {});
});

afterAll(async () => {
  await t.app.close();
  await bare.app.close();
  await hook.close();
  await service.close();
});

beforeEach(async () => {
  await db.reset();
  t.mail.length = 0;
  hook.received.length = 0;
  hook.reply(200);
  service.reply(201);
  // The webhook receiver is on 127.0.0.1: the instance allows private addresses.
  await own(
    db,
    `INSERT INTO public.instance_settings (key, value) VALUES ('ssrf_allow_private', 'true')
     ON CONFLICT (key) DO UPDATE SET value = 'true'`,
  );
});

/** The person's account-level audit events, oldest first (as kept_owner). */
const accountAudit = (userId: string) =>
  asOwner(db, async (c) => {
    const { rows } = await c.query<{ action: string; entity_id: string | null; diff: unknown }>(
      `SELECT e.action, e.entity_id, e.diff FROM public.audit_events e
         JOIN public.owner_accounts oa ON oa.id = e.owner_account_id
        WHERE oa.user_id = $1 AND e.location_id IS NULL ORDER BY e.at, e.id`,
      [userId],
    );
    return rows;
  });

async function settings(as: Person, app = t): Promise<Settings> {
  const res = await call(app, '/api/v1/me/notification-settings', { as });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Settings;
}

async function webhook(as: Person, label = 'Home Assistant') {
  const res = await call(t, '/api/v1/me/channels', {
    as,
    body: { kind: 'webhook', url: `${hook.url}/kept?room=1`, label },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { channel: Channel; secret: string };
}

function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

describe('GET /api/v1/me/notification-settings', () => {
  it('shows the defaults: owners every kind but webhooks, viewers only Membership (Q8, Q10)', async () => {
    const bruce = await person(t, db, 'bruce');
    const talia = await person(t, db, 'talia');
    const home = await createLocation(t, db, bruce, 'complete');
    await join(db, home.id, talia.userId, 'viewer');

    const mine = await settings(bruce);
    expect(mine).toMatchObject({
      timezone: expect.any(String),
      digestTime: '08:00',
      quietFrom: null,
      quietTo: null,
      smtpConfigured: true,
      push: { available: true, publicKey: vapid.publicKey },
      account: { aiSummary: { email: true } },
    });
    // The email channel is made lazily, once.
    expect(mine.channels.map((c) => c.kind)).toEqual(['email']);
    expect((await settings(bruce)).channels[0]?.id).toBe(mine.channels[0]?.id);
    const owned = mine.locations.find((l) => l.locationId === home.id);
    expect(owned?.role).toBe('owner');
    expect(Object.keys(owned?.kinds ?? {}).sort()).toEqual([...LOCATION_KINDS].sort());
    expect(owned?.kinds.warranty).toEqual({
      inapp: true,
      email: true,
      webpush: true,
      webhook: false,
      ntfy: true,
      telegram: true,
      apprise: true,
      isDefault: true,
      set: [],
    });
    // D239: the all-locations table holds every kind, the AI summary too.
    expect(Object.keys(mine.account.kinds).sort()).toEqual(
      [...LOCATION_KINDS, 'ai_summary'].sort(),
    );
    expect(mine.account.kinds.ai_summary).toMatchObject({ inapp: true, email: true, set: [] });

    const viewer = (await settings(talia)).locations.find((l) => l.locationId === home.id);
    expect(viewer?.role).toBe('viewer');
    expect(Object.keys(viewer?.kinds ?? {})).toEqual(['membership']);
  });

  it('says push is unavailable, and why, on an app without it', async () => {
    const louis = await person(bare, db, 'louis');
    expect((await settings(louis, bare)).push).toEqual({
      available: false,
      publicKey: null,
      reason: 'no_subject',
    });
  });
});

describe('PUT /api/v1/me/notification-settings', () => {
  // catalogue: PUT /api/v1/me/notification-settings
  it('sets the digest time and quiet hours (both ends or neither), audited', async () => {
    const bruce = await person(t, db, 'bruce');
    const url = '/api/v1/me/notification-settings';
    const res = await call(t, url, {
      as: bruce,
      method: 'PUT',
      body: { digestTime: '07:30', quietFrom: '22:00', quietTo: '07:00' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ digestTime: '07:30', quietFrom: '22:00', quietTo: '07:00' });
    const events = await accountAudit(bruce.userId);
    expect(events.map((e) => e.action)).toContain('me.notifications');
    expect(events.at(-1)?.diff).toMatchObject({
      digest_time: { before: '08:00', after: '07:30' },
      quiet_from: { before: null, after: '22:00' },
    });

    const half = await call(t, url, { as: bruce, method: 'PUT', body: { quietTo: null } });
    expect(half.statusCode).toBe(400);
    const cleared = await call(t, url, {
      as: bruce,
      method: 'PUT',
      body: { quietFrom: null, quietTo: null },
    });
    expect(cleared.json()).toMatchObject({ quietFrom: null, quietTo: null, digestTime: '07:30' });
    expect(
      (await call(t, url, { as: bruce, method: 'PUT', body: { digestTime: '25:00' } })).statusCode,
    ).toBe(400);
  });
});

describe('PUT /api/v1/me/notification-preferences', () => {
  // catalogue: PUT /api/v1/me/notification-preferences
  it('stores a choice only while it differs from the default, audited once', async () => {
    const bruce = await person(t, db, 'bruce');
    const home = await createLocation(t, db, bruce, 'complete');
    const url = '/api/v1/me/notification-preferences';
    const put = (items: object[]) => call(t, url, { as: bruce, method: 'PUT', body: { items } });
    const off = { locationId: home.id, kind: 'warranty', channel: 'email', enabled: false };
    const hookOn = { locationId: home.id, kind: 'loan', channel: 'webhook', enabled: true };
    const res = await put([
      off,
      hookOn,
      { locationId: null, kind: 'ai_summary', channel: 'email', enabled: false },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Settings;
    const kinds = body.locations.find((l) => l.locationId === home.id)?.kinds;
    expect(kinds?.warranty).toMatchObject({ email: false, inapp: true, isDefault: false });
    expect(kinds?.loan).toMatchObject({ webhook: true, isDefault: false });
    expect(body.account.aiSummary.email).toBe(false);
    const rows = () =>
      own<{ kind: string }>(
        db,
        'SELECT kind FROM public.notification_preferences WHERE user_id = $1 ORDER BY kind',
        [bruce.userId],
      );
    expect((await rows()).map((r) => r.kind)).toEqual(['ai_summary', 'loan', 'warranty']);
    const events = await accountAudit(bruce.userId);
    expect(events.filter((e) => e.action === 'me.notification_preferences')).toHaveLength(1);

    // Back to the default: the row goes, and the kind reads as default again.
    const back = await put([{ ...off, enabled: true }]);
    expect(back.statusCode).toBe(200);
    expect((await rows()).map((r) => r.kind)).toEqual(['ai_summary', 'loan']);
    const again = (back.json() as Settings).locations.find((l) => l.locationId === home.id);
    expect(again?.kinds.warranty?.isDefault).toBe(true);
  });

  it('refuses the AI summary with a location, and someone else’s location', async () => {
    const bruce = await person(t, db, 'bruce');
    const alfred = await person(t, db, 'alfred');
    const his = await createLocation(t, db, alfred, 'essentials', 'بيت العائلة');
    const mine = await createLocation(t, db, bruce, 'essentials');
    const url = '/api/v1/me/notification-preferences';
    const put = (item: object) =>
      call(t, url, { as: bruce, method: 'PUT', body: { items: [item] } });
    expect(
      (await put({ locationId: mine.id, kind: 'ai_summary', channel: 'email', enabled: false }))
        .statusCode,
    ).toBe(400);
    expect(
      (await put({ locationId: his.id, kind: 'loan', channel: 'email', enabled: false }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(t, url, {
          as: bruce,
          method: 'PUT',
          body: {
            items: Array.from({ length: 201 }, () => ({
              locationId: mine.id,
              kind: 'loan',
              channel: 'email',
              enabled: false,
            })),
          },
        })
      ).statusCode,
    ).toBe(400);
  });
});

describe('all locations, and overrides per location (D239)', () => {
  const url = '/api/v1/me/notification-preferences';
  const put = (as: Person, items: object[]) => call(t, url, { as, method: 'PUT', body: { items } });
  const rowsOf = (userId: string) =>
    own<{ location_id: string | null; kind: string; channel: string; enabled: boolean }>(
      db,
      `SELECT location_id, kind, channel, enabled FROM public.notification_preferences
        WHERE user_id = $1 ORDER BY location_id NULLS FIRST, kind, channel`,
      [userId],
    );
  const at = (s: Settings, locationId: string) =>
    s.locations.find((l) => l.locationId === locationId)?.kinds;

  it('a location reads its own choice, else all locations, else the default; each layer stores only what differs', async () => {
    const bruce = await person(t, db, 'bruce');
    const home = await createLocation(t, db, bruce, 'complete');
    // All locations: warranties by email off. Stored once, with no location.
    const res = await put(bruce, [
      { locationId: null, kind: 'warranty', channel: 'email', enabled: false },
      // Equal to the all-locations baseline (an owner's default): nothing stored.
      { locationId: null, kind: 'loan', channel: 'inapp', enabled: true },
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const s1 = res.json() as Settings;
    expect(s1.account.kinds.warranty).toMatchObject({ email: false, inapp: true, set: ['email'] });
    expect(at(s1, home.id)?.warranty).toMatchObject({
      email: false,
      inapp: true,
      set: [],
      isDefault: false,
    });
    expect(await rowsOf(bruce.userId)).toEqual([
      { location_id: null, kind: 'warranty', channel: 'email', enabled: false },
    ]);

    // Here only: back on. A location row, marked as set here.
    const s2 = (await put(bruce, [
      { locationId: home.id, kind: 'warranty', channel: 'email', enabled: true },
    ]).then((r) => r.json())) as Settings;
    expect(at(s2, home.id)?.warranty).toMatchObject({ email: true, set: ['email'] });
    // Choosing here what all locations already say stores nothing.
    await put(bruce, [{ locationId: home.id, kind: 'loan', channel: 'email', enabled: true }]);
    expect((await rowsOf(bruce.userId)).map((r) => [r.location_id, r.kind])).toEqual([
      [null, 'warranty'],
      [home.id, 'warranty'],
    ]);

    // All locations back on: the location's row now says the same, so it goes too.
    const s3 = (await put(bruce, [
      { locationId: null, kind: 'warranty', channel: 'email', enabled: true },
    ]).then((r) => r.json())) as Settings;
    expect(await rowsOf(bruce.userId)).toEqual([]);
    expect(at(s3, home.id)?.warranty).toMatchObject({ email: true, set: [], isDefault: true });
  });

  it('applies to a location made later, and still refuses the AI summary with a location', async () => {
    const bruce = await person(t, db, 'bruce');
    await put(bruce, [{ locationId: null, kind: 'schedule', channel: 'inapp', enabled: false }]);
    const later = await createLocation(t, db, bruce, 'complete', 'Shed');
    const s = await settings(bruce);
    expect(at(s, later.id)?.schedule).toMatchObject({ inapp: false, set: [] });
    const r = await put(bruce, [
      { locationId: later.id, kind: 'ai_summary', channel: 'inapp', enabled: false },
    ]);
    expect(r.statusCode).toBe(400);
  });

  it("a member's location starts from Kept's default for members, not from all locations' on", async () => {
    const bruce = await person(t, db, 'bruce');
    const louis = await person(t, db, 'louis');
    const home = await createLocation(t, db, bruce, 'complete');
    await join(db, home.id, louis.userId, 'member');
    const s = await settings(louis);
    expect(s.account.kinds.warranty?.inapp).toBe(true);
    expect(at(s, home.id)?.warranty).toMatchObject({ inapp: false, set: [] });
    // Turning it on there is a choice for that location.
    const on = (await put(louis, [
      { locationId: home.id, kind: 'warranty', channel: 'inapp', enabled: true },
    ]).then((r) => r.json())) as Settings;
    expect(at(on, home.id)?.warranty).toMatchObject({ inapp: true, set: ['inapp'] });
  });

  // catalogue: DELETE /api/v1/me/notification-preferences/:locationId
  it('resets a location to all locations, audited; never another person’s', async () => {
    const bruce = await person(t, db, 'bruce');
    const alfred = await person(t, db, 'alfred');
    const home = await createLocation(t, db, bruce, 'complete');
    const his = await createLocation(t, db, alfred, 'essentials');
    const reset = (as: Person, id: string) =>
      call(t, `/api/v1/me/notification-preferences/${id}`, { as, method: 'DELETE' });
    await put(bruce, [
      { locationId: null, kind: 'loan', channel: 'email', enabled: false },
      { locationId: home.id, kind: 'loan', channel: 'email', enabled: true },
      { locationId: home.id, kind: 'stock', channel: 'inapp', enabled: false },
    ]);
    const before = (await accountAudit(bruce.userId)).length;
    const res = await reset(bruce, home.id);
    expect(res.statusCode, res.body).toBe(200);
    const kinds = at(res.json() as Settings, home.id);
    expect(kinds?.loan).toMatchObject({ email: false, set: [] });
    expect(kinds?.stock).toMatchObject({ inapp: true, set: [] });
    // The all-locations choice stays.
    expect(await rowsOf(bruce.userId)).toEqual([
      { location_id: null, kind: 'loan', channel: 'email', enabled: false },
    ]);
    const events = await accountAudit(bruce.userId);
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)?.action).toBe('me.notification_preferences');
    // Nothing left to reset: no second event.
    expect((await reset(bruce, home.id)).statusCode).toBe(200);
    expect(await accountAudit(bruce.userId)).toHaveLength(before + 1);

    // Alfred can't reset Bruce's location, and his all-locations choices are his own.
    expect((await reset(alfred, home.id)).statusCode).toBe(404);
    expect(
      (await put(alfred, [{ locationId: home.id, kind: 'loan', channel: 'email', enabled: false }]))
        .statusCode,
    ).toBe(404);
    await put(alfred, [{ locationId: null, kind: 'warranty', channel: 'inapp', enabled: false }]);
    expect(await rowsOf(bruce.userId)).toEqual([
      { location_id: null, kind: 'loan', channel: 'email', enabled: false },
    ]);
    expect((await rowsOf(alfred.userId)).map((r) => [r.location_id, r.kind])).toEqual([
      [null, 'warranty'],
    ]);
    const mine = await settings(bruce);
    expect(mine.account.kinds.warranty?.inapp).toBe(true);
    expect(mine.locations.map((l) => l.locationId)).not.toContain(his.id);
  });
});

describe('webhook channels', () => {
  // catalogue: POST /api/v1/me/channels
  it('makes a webhook: its secret shown once, its URL sealed and never returned, audited', async () => {
    const bruce = await person(t, db, 'bruce');
    const made = await webhook(bruce);
    expect(made.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(made.channel).toMatchObject({
      kind: 'webhook',
      label: 'Home Assistant',
      displayHost: new URL(hook.url).host,
      verifiedAt: null,
    });
    const listed = await settings(bruce);
    expect(listed.channels.map((c) => c.kind)).toEqual(['email', 'webhook']);
    expect(JSON.stringify(listed)).not.toContain('/kept?room=1');
    expect(JSON.stringify(listed)).not.toContain(made.secret);

    const [row] = await own<{ config_ciphertext: Sealed; key_version: number }>(
      db,
      'SELECT config_ciphertext, key_version FROM public.notification_channels WHERE id = $1',
      [made.channel.id],
    );
    expect(JSON.stringify(row)).not.toContain(made.secret);
    expect(openWebhookConfig(keyring, made.channel.id, row?.config_ciphertext as Sealed)).toEqual({
      url: `${hook.url}/kept?room=1`,
      secret: made.secret,
    });
    // kept_app can't read the sealed config, even its own.
    await expect(
      withScope(db.pools.app, { userId: bruce.userId, mfa: false }, (_tx, c) =>
        c.query('SELECT config_ciphertext FROM public.notification_channels'),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const events = await accountAudit(bruce.userId);
    expect(events).toContainEqual(
      expect.objectContaining({ action: 'channel.create', entity_id: made.channel.id }),
    );
    expect(JSON.stringify(events)).not.toContain(made.secret);
  });

  it('allows five webhooks, and refuses a URL with credentials or another scheme', async () => {
    const bruce = await person(t, db, 'bruce');
    for (let i = 0; i < MAX_WEBHOOK_CHANNELS; i++) await webhook(bruce, `Hook ${i}`);
    const sixth = await call(t, '/api/v1/me/channels', {
      as: bruce,
      body: { kind: 'webhook', url: `${hook.url}/six` },
    });
    expect(sixth.statusCode).toBe(409);
    const louis = await person(t, db, 'louis');
    for (const url of ['ftp://example.org/x', 'https://user:pw@example.org/x', 'not a url']) {
      const res = await call(t, '/api/v1/me/channels', {
        as: louis,
        body: { kind: 'webhook', url },
      });
      expect(res.statusCode, url).toBe(400);
    }
  });

  // catalogue: DELETE /api/v1/me/channels/:id
  it('removes a webhook (audited), keeps the email channel, and hides others’ channels', async () => {
    const bruce = await person(t, db, 'bruce');
    const louis = await person(t, db, 'louis');
    const made = await webhook(bruce);
    const email = (await settings(bruce)).channels.find((c) => c.kind === 'email');
    const del = (id: string, as = bruce) =>
      call(t, `/api/v1/me/channels/${id}`, { as, method: 'DELETE' });
    expect((await del(made.channel.id, louis)).statusCode).toBe(404);
    expect((await del(email?.id as string)).statusCode).toBe(400);
    expect((await del(made.channel.id)).statusCode).toBe(204);
    expect((await settings(bruce)).channels.map((c) => c.kind)).toEqual(['email']);
    expect(await accountAudit(bruce.userId)).toContainEqual(
      expect.objectContaining({ action: 'channel.delete', entity_id: made.channel.id }),
    );
    expect((await del(newId())).statusCode).toBe(404);
  });

  it('sends a signed test to a webhook, and marks it verified', async () => {
    const bruce = await person(t, db, 'bruce');
    const made = await webhook(bruce);
    const res = await call(t, `/api/v1/me/channels/${made.channel.id}/test`, {
      as: bruce,
      method: 'POST',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 200 });
    const [got] = hook.received;
    expect(got?.url).toBe('/kept?room=1');
    expect(
      verifyWebhook(
        made.secret,
        String(got?.headers['kept-signature']),
        got?.body.toString() ?? '',
      ),
    ).toBe(true);
    const listed = (await settings(bruce)).channels.find((c) => c.id === made.channel.id);
    expect(listed?.verifiedAt).not.toBeNull();

    hook.reply(500);
    const failing = await call(t, `/api/v1/me/channels/${made.channel.id}/test`, {
      as: bruce,
      method: 'POST',
    });
    expect(failing.json()).toEqual({ ok: false, status: 500, error: 'http_500' });
  });

  it('mails a test to the person’s own address, and limits tests to five an hour', async () => {
    const bruce = await person(t, db, 'bruce');
    const email = (await settings(bruce)).channels.find((c) => c.kind === 'email');
    const test = () =>
      call(t, `/api/v1/me/channels/${email?.id}/test`, { as: bruce, method: 'POST' });
    const first = await test();
    expect(first.json()).toEqual({ ok: true });
    expect(t.mail).toContainEqual(
      expect.objectContaining({ kind: 'channel-test', to: bruce.email }),
    );
    for (let i = 0; i < 4; i++) expect((await test()).statusCode).toBe(200);
    const sixth = await test();
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });
});

describe('ntfy and Telegram channels (D227)', () => {
  beforeEach(() => {
    telegram.calls.length = 0;
    telegram.answer = { ok: true };
    telegram.status = 200;
  });

  // catalogue: POST /api/v1/me/channels
  it('makes an ntfy channel: settings sealed, never returned, audited; a test is JSON to the root', async () => {
    const bruce = await person(t, db, 'bruce');
    const res = await call(t, '/api/v1/me/channels', {
      as: bruce,
      body: {
        kind: 'ntfy',
        server: `${hook.url}/ntfy`,
        topic: 'kept_home-1',
        token: 'tk_secret123',
        label: 'Phone',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { channel, secret } = res.json() as { channel: Channel; secret: string };
    expect(secret).toBe('');
    expect(channel).toMatchObject({
      kind: 'ntfy',
      label: 'Phone',
      displayHost: new URL(hook.url).host,
    });
    expect(res.body).not.toContain('tk_secret123');
    expect(res.body).not.toContain('kept_home-1');
    const [row] = await own<{ config_ciphertext: Sealed; key_version: number }>(
      db,
      'SELECT config_ciphertext, key_version FROM public.notification_channels WHERE id = $1',
      [channel.id],
    );
    expect(JSON.stringify(row?.config_ciphertext)).not.toContain('tk_secret123');
    expect(openRelayConfig(keyring, channel.id, 'ntfy', row?.config_ciphertext as Sealed)).toEqual({
      kind: 'ntfy',
      server: `${hook.url}/ntfy/`,
      topic: 'kept_home-1',
      token: 'tk_secret123',
    });
    expect((await accountAudit(bruce.userId)).map((e) => e.action)).toContain('channel.create');

    const test = await call(t, `/api/v1/me/channels/${channel.id}/test`, {
      as: bruce,
      method: 'POST',
    });
    expect(test.json()).toEqual({ ok: true, status: 200 });
    const [got] = hook.received;
    expect(got?.url).toBe('/ntfy/');
    expect(got?.headers.authorization).toBe('Bearer tk_secret123');
    expect(JSON.parse(got?.body.toString() ?? '{}')).toMatchObject({
      topic: 'kept_home-1',
      title: expect.any(String),
      message: expect.any(String),
      priority: 3,
      click: expect.stringContaining('/settings/me/notifications'),
    });
    expect(
      (await settings(bruce)).channels.find((c) => c.id === channel.id)?.verifiedAt,
    ).not.toBeNull();

    hook.reply(403);
    const refused = await call(t, `/api/v1/me/channels/${channel.id}/test`, {
      as: bruce,
      method: 'POST',
    });
    expect(refused.json()).toEqual({ ok: false, status: 403, error: 'http_403' });
    expect(
      (await settings(bruce)).channels.find((c) => c.id === channel.id)?.failingSince,
    ).not.toBeNull();
  });

  it('refuses a bad topic, a server with credentials, and a fourth channel of a kind', async () => {
    const bruce = await person(t, db, 'bruce');
    const make = (body: object) =>
      call(t, '/api/v1/me/channels', { as: bruce, body: { kind: 'ntfy', ...body } });
    expect((await make({ server: 'https://ntfy.sh', topic: 'has space' })).statusCode).toBe(400);
    expect((await make({ server: 'https://u:p@ntfy.sh', topic: 'ok' })).statusCode).toBe(400);
    expect((await make({ server: 'ftp://ntfy.sh', topic: 'ok' })).statusCode).toBe(400);
    for (let i = 0; i < 3; i++) {
      expect((await make({ server: 'https://ntfy.sh', topic: `kept${i}` })).statusCode).toBe(201);
    }
    expect((await make({ server: 'https://ntfy.sh', topic: 'kept4' })).statusCode).toBe(409);
  });

  it('makes a Telegram channel and tests it with sendMessage, plain text, no preview', async () => {
    const bruce = await person(t, db, 'bruce');
    const bad = await call(t, '/api/v1/me/channels', {
      as: bruce,
      body: { kind: 'telegram', botToken: 'not-a-token', chatId: '42' },
    });
    expect(bad.statusCode).toBe(400);
    const token = `123456:${'A'.repeat(35)}`;
    const res = await call(t, '/api/v1/me/channels', {
      as: bruce,
      body: { kind: 'telegram', botToken: token, chatId: '-1001234567890' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { channel } = res.json() as { channel: Channel };
    expect(channel).toMatchObject({ kind: 'telegram', displayHost: 'api.telegram.org' });
    expect(res.body).not.toContain(token);

    const test = await call(t, `/api/v1/me/channels/${channel.id}/test`, {
      as: bruce,
      method: 'POST',
    });
    expect(test.json()).toEqual({ ok: true, status: 200 });
    expect(telegram.calls).toEqual([
      {
        url: `${TELEGRAM_API}/bot${token}/sendMessage`,
        body: {
          chat_id: '-1001234567890',
          text: expect.stringContaining('/settings/me/notifications'),
          link_preview_options: { is_disabled: true },
        },
      },
    ]);

    telegram.status = 400;
    telegram.answer = { ok: false, description: 'Bad Request: chat not found' };
    const refused = await call(t, `/api/v1/me/channels/${channel.id}/test`, {
      as: bruce,
      method: 'POST',
    });
    expect(refused.json()).toEqual({ ok: false, status: 400, error: 'telegram_400' });
    expect(refused.body).not.toContain(token);
  });
});

describe('push subscriptions', () => {
  const subscribe = (as: Person, endpoint: string, keys = browserKeys(), app = t) =>
    call(app, '/api/v1/me/push-subscriptions', {
      as,
      body: { endpoint, keys, label: 'iPhone' },
    });

  // catalogue: POST /api/v1/me/push-subscriptions
  it('adds this device (the same endpoint again keeps it) and the push channel, audited', async () => {
    const bruce = await person(t, db, 'bruce');
    const keys = browserKeys();
    const endpoint = `${service.url}/push/bruce`;
    const res = await subscribe(bruce, endpoint, keys);
    expect(res.statusCode, res.body).toBe(201);
    const { id } = res.json() as { id: string };
    expect(((await subscribe(bruce, endpoint, keys)).json() as { id: string }).id).toBe(id);
    const push = (await settings(bruce)).channels.find((c) => c.kind === 'webpush');
    expect(push?.subscriptions).toEqual([
      expect.objectContaining({ id, label: 'iPhone', lastSuccessAt: null }),
    ]);
    expect(await accountAudit(bruce.userId)).toContainEqual(
      expect.objectContaining({ action: 'push_subscription.create', entity_id: id }),
    );
    // Another account signing in on this device takes the endpoint over.
    const louis = await person(t, db, 'louis');
    expect((await subscribe(louis, endpoint, keys)).statusCode).toBe(201);
    expect(
      (await settings(bruce)).channels.find((c) => c.kind === 'webpush')?.subscriptions,
    ).toEqual([]);
    // An http endpoint is refused, and so is any subscription where push isn't available.
    expect((await subscribe(bruce, 'http://push.example.org/x')).statusCode).toBe(400);
    const plain = await person(bare, db, 'talia');
    const refused = await subscribe(plain, `${service.url}/push/talia`, browserKeys(), bare);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'push_unavailable' });
  });

  // catalogue: DELETE /api/v1/me/push-subscriptions/:id
  it('removes a device, audited; someone else’s is a 404', async () => {
    const bruce = await person(t, db, 'bruce');
    const louis = await person(t, db, 'louis');
    const { id } = (await subscribe(bruce, `${service.url}/push/b`)).json() as { id: string };
    const del = (as: Person) =>
      call(t, `/api/v1/me/push-subscriptions/${id}`, { as, method: 'DELETE' });
    expect((await del(louis)).statusCode).toBe(404);
    expect((await del(bruce)).statusCode).toBe(204);
    expect(await accountAudit(bruce.userId)).toContainEqual(
      expect.objectContaining({ action: 'push_subscription.delete', entity_id: id }),
    );
  });

  it('sends a test push to one device, and drops it when its service says it’s gone', async () => {
    const bruce = await person(t, db, 'bruce');
    const { id } = (await subscribe(bruce, `${service.url}/push/test`)).json() as { id: string };
    const test = () =>
      call(t, `/api/v1/me/push-subscriptions/${id}/test`, { as: bruce, method: 'POST' });
    const ok = await test();
    expect(ok.json()).toEqual({ ok: true, status: 201 });
    expect(service.received.at(-1)?.url).toBe('/push/test');
    service.reply(410);
    expect((await test()).json()).toEqual({ ok: false, status: 410, error: 'no_device' });
    expect((await test()).statusCode).toBe(404);
  });
});

describe('Apprise channels (D232)', () => {
  // catalogue: POST /api/v1/me/channels
  it('makes an Apprise channel: URLs sealed, never returned, audited; a test POSTs to /notify/', async () => {
    const bruce = await person(t, db, 'bruce');
    expect((await settings(bruce)).apprise).toEqual({ available: true });
    const urls = 'discord://webhook_id/webhook_token, mailto://user:pass@example.org';
    const res = await call(t, '/api/v1/me/channels', {
      as: bruce,
      body: { kind: 'apprise', urls, label: 'Family' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const { channel } = res.json() as { channel: Channel };
    expect(channel).toMatchObject({
      kind: 'apprise',
      label: 'Family',
      displayHost: 'discord, mailto',
    });
    expect(res.body).not.toContain('webhook_token');
    const [row] = await own<{ config_ciphertext: Sealed }>(
      db,
      'SELECT config_ciphertext FROM public.notification_channels WHERE id = $1',
      [channel.id],
    );
    expect(JSON.stringify(row?.config_ciphertext)).not.toContain('webhook_token');
    expect(
      openRelayConfig(keyring, channel.id, 'apprise', row?.config_ciphertext as Sealed),
    ).toEqual({
      kind: 'apprise',
      urls: ['discord://webhook_id/webhook_token', 'mailto://user:pass@example.org'],
    });
    expect((await accountAudit(bruce.userId)).map((e) => e.action)).toContain('channel.create');

    hook.received.length = 0;
    const test = await call(t, `/api/v1/me/channels/${channel.id}/test`, {
      as: bruce,
      method: 'POST',
    });
    expect(test.json()).toEqual({ ok: true, status: 200 });
    const [got] = hook.received;
    expect(got?.url).toBe('/apprise/notify/');
    expect(JSON.parse(got?.body.toString() ?? '{}')).toEqual({
      urls: 'discord://webhook_id/webhook_token,mailto://user:pass@example.org',
      title: expect.any(String),
      body: expect.stringContaining('/settings/me/notifications'),
      type: 'info',
      format: 'text',
    });

    hook.reply(424);
    const failed = await call(t, `/api/v1/me/channels/${channel.id}/test`, {
      as: bruce,
      method: 'POST',
    });
    expect(failed.json()).toEqual({ ok: false, status: 424, error: 'apprise_424' });
    expect(failed.body).not.toContain('webhook_token');
  });

  it('refuses generic json/xml/form URLs unless private addresses are allowed, and bad URLs', async () => {
    const bruce = await person(t, db, 'bruce');
    const make = (urls: string) =>
      call(t, '/api/v1/me/channels', { as: bruce, body: { kind: 'apprise', urls } });
    expect((await make('not a url')).statusCode).toBe(400);
    expect(
      (await make(Array.from({ length: 11 }, (_, i) => `ntfys://topic${i}`).join(' '))).statusCode,
    ).toBe(400);
    // This file allows private addresses for its local receivers; turned off, generic URLs go.
    await own(
      db,
      "UPDATE public.instance_settings SET value = 'false'::jsonb WHERE key = 'ssrf_allow_private'",
    );
    try {
      const generic = await make('json://192.168.1.10/hook');
      expect(generic.statusCode).toBe(400);
      expect(generic.json()).toMatchObject({ hint: expect.stringContaining('private addresses') });
    } finally {
      await own(
        db,
        "UPDATE public.instance_settings SET value = 'true'::jsonb WHERE key = 'ssrf_allow_private'",
      );
    }
    expect((await make('json://192.168.1.10/hook')).statusCode).toBe(201);
  });

  it('is not offered when the operator runs no Apprise server', async () => {
    const bruce = await person(bare, db, 'bruce');
    expect((await settings(bruce, bare)).apprise).toEqual({ available: false });
    const res = await call(bare, '/api/v1/me/channels', {
      as: bruce,
      body: { kind: 'apprise', urls: 'discord://a/b' },
    });
    expect(res.statusCode).toBe(400);
  });
});
