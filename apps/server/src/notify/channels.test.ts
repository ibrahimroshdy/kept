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
import { LOCATION_KINDS } from './prefs.js';
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

type KindPref = {
  inapp: boolean;
  email: boolean;
  webpush: boolean;
  webhook: boolean;
  isDefault: boolean;
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
  channels: Channel[];
  locations: Array<{
    locationId: string;
    name: string;
    role: string;
    kinds: Record<string, KindPref>;
  }>;
  account: { aiSummary: { email: boolean } };
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
      transport: {
        push: {
          send: webpush.sendNotification,
          agent: new https.Agent({ ca: service.ca as Buffer }),
          refuseLiterals: false,
        },
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
      isDefault: true,
    });

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

  it('refuses an account-level kind with a location, and someone else’s location', async () => {
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
      (await put({ locationId: null, kind: 'loan', channel: 'email', enabled: false })).statusCode,
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
