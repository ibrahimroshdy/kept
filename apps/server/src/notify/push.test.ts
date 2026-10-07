import { createECDH, randomBytes } from 'node:crypto';
import https from 'node:https';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { type TestDb, testDb } from '../../test/db.js';
import { type Receiver, startReceiver } from '../../test/receiver.js';
import { ownerTx, seedUser } from '../../test/tenancy.js';
import { guardedLookup } from '../net/ssrf.js';
import {
  encodePayload,
  PUSH_MAX_BYTES,
  type PushTransport,
  publicPushTransport,
  pushTopic,
  pushToUser,
  sendPush,
} from './push.js';
import type { VapidDetails } from './vapid.js';

// Web push (plan T15; L112, Q12) against a local HTTPS receiver standing in for a push service:
// what web-push sends, the private-address refusal that ignores ssrf_allow_private, and what
// 404, 410 and 5xx do to a subscription. Nothing leaves the machine.

let db: TestDb;
let service: Receiver;
let transport: PushTransport;
const keys = webpush.generateVAPIDKeys();
const details: VapidDetails = { ...keys, subject: 'mailto:kept@example.org' };
const payload = { title: 'Service due · Kitchen', body: 'Boiler service', url: '/p/x', tag: 't' };

/** A browser's subscription keys: a P-256 public key and 16 bytes of auth. */
function browserKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
}

beforeAll(async () => {
  db = await testDb();
  service = await startReceiver({ tls: true });
  transport = {
    send: webpush.sendNotification,
    agent: new https.Agent({ ca: service.ca as Buffer }),
    refuseLiterals: false,
  };
});

afterAll(async () => {
  await service.close();
});

beforeEach(async () => {
  await db.reset();
  service.received.length = 0;
  service.reply(201);
});

describe('sendPush', () => {
  it('sends over TLS with the VAPID details, a day’s TTL, the urgency and the topic', async () => {
    const topic = pushTopic('schedule:abc:overdue:date:2026-10-17');
    const res = await sendPush(
      { endpoint: `${service.url}/push/one`, ...browserKeys() },
      payload,
      { urgency: 'high', topic },
      { details, transport },
    );
    expect(res).toEqual({ ok: true, status: 201 });
    const [got] = service.received;
    expect(got?.url).toBe('/push/one');
    expect(got?.headers.ttl).toBe('86400');
    expect(got?.headers.urgency).toBe('high');
    expect(got?.headers.topic).toBe(topic);
    expect(topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(got?.headers['content-encoding']).toBe('aes128gcm');
    expect(String(got?.headers.authorization)).toMatch(/^vapid t=[^,]+, k=/);
    // Encrypted: the payload's words never travel in the clear.
    expect(got?.body.includes(Buffer.from('Boiler service'))).toBe(false);
  });

  it('refuses a private address, a literal or a name that resolves to one (Q12)', async () => {
    const literal = await sendPush(
      { endpoint: 'https://10.0.0.5/push', ...browserKeys() },
      payload,
      { urgency: 'normal' },
      { details, transport: publicPushTransport() },
    );
    expect(literal).toMatchObject({ ok: false, error: 'private_address' });

    // A name whose DNS answer is 10.0.0.5: refused at connect time.
    const lan: PushTransport = {
      send: webpush.sendNotification,
      agent: new https.Agent({
        lookup: guardedLookup((_host, cb) => cb(null, [{ address: '10.0.0.5', family: 4 }])),
      }),
      refuseLiterals: true,
    };
    const named = await sendPush(
      { endpoint: 'https://push.example.test/abc', ...browserKeys() },
      payload,
      { urgency: 'normal' },
      { details, transport: lan },
    );
    expect(named).toMatchObject({ ok: false, error: 'private_address' });

    // The real transport: `localhost` resolves to loopback, and is refused before any request.
    const port = new URL(service.url).port;
    const real = await sendPush(
      { endpoint: `https://localhost:${port}/push`, ...browserKeys() },
      payload,
      { urgency: 'normal' },
      { details, transport: publicPushTransport() },
    );
    expect(real).toMatchObject({ ok: false, error: 'private_address' });
    expect(service.received).toHaveLength(0);
  });

  it('keeps a payload under 3 KB by shortening its body', () => {
    const json = encodePayload({ ...payload, body: 'ب'.repeat(5000) });
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(PUSH_MAX_BYTES);
    expect(JSON.parse(json).body).toMatch(/…$/);
  });
});

describe('pushToUser', () => {
  async function subscribe(userId: string, path: string): Promise<string> {
    return ownerTx(db, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [userId, `${service.url}${path}`, browserKeys().p256dh, browserKeys().auth],
      );
      return rows[0]?.id as string;
    });
  }
  const sub = (id: string) =>
    ownerTx(db, async (c) => {
      const { rows } = await c.query<{ failures: number; last_success_at: Date | null }>(
        'SELECT failures, last_success_at FROM public.push_subscriptions WHERE id = $1',
        [id],
      );
      return rows[0] ?? null;
    });

  it('records a success, counts a failure and drops a subscription the service says is gone', async () => {
    const bruce = await seedUser(db, 'bruce');
    // ssrf_allow_private is on: push ignores it (the receiver's own agent trusts 127.0.0.1).
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.instance_settings (key, value) VALUES ('ssrf_allow_private', 'true')`,
      ),
    );
    const phone = await subscribe(bruce, '/push/phone');
    expect(
      await pushToUser(
        db.pools.system,
        bruce,
        payload,
        { urgency: 'high' },
        { details, transport },
      ),
    ).toMatchObject({ status: 'sent', sent: 1 });
    expect((await sub(phone))?.last_success_at).toBeInstanceOf(Date);

    service.reply(500);
    const failed = await pushToUser(
      db.pools.system,
      bruce,
      payload,
      { urgency: 'high' },
      {
        details,
        transport,
      },
    );
    expect(failed).toMatchObject({ status: 'failed', error: 'http_500', httpStatus: 500 });
    expect((await sub(phone))?.failures).toBe(1);

    for (const status of [404, 410]) {
      const id = await subscribe(bruce, `/push/gone-${status}`);
      service.reply(status);
      const res = await pushToUser(
        db.pools.system,
        bruce,
        payload,
        { urgency: 'high' },
        {
          details,
          transport,
          only: id,
        },
      );
      expect(res).toMatchObject({ status: 'skipped', gone: 1 });
      expect(await sub(id)).toBeNull();
    }
  });

  it('is skipped for someone with no device', async () => {
    const louis = await seedUser(db, 'louis');
    expect(
      await pushToUser(
        db.pools.system,
        louis,
        payload,
        { urgency: 'normal' },
        { details, transport },
      ),
    ).toMatchObject({ status: 'skipped', sent: 0 });
  });
});
