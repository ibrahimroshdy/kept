import { randomBytes } from 'node:crypto';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { type Receiver, startReceiver } from '../../test/receiver.js';
import { ownerTx, seedTenant, userEmail } from '../../test/tenancy.js';
import type { Keyring, MasterKey } from '../crypto/envelope.js';
import type { Mail } from '../mail/mailer.js';
import { runChannelWebhook, type WebhookJobDeps } from './jobs.js';
import {
  postWebhook,
  sealWebhookConfig,
  signWebhook,
  testEnvelope,
  verifyWebhook,
  type WebhookEnvelope,
} from './webhook.js';

// The personal webhook channel (plan T15, Q6; D30, D110, §2.6): the signature verifies with the
// channel's secret, redirects and private addresses are refused, the envelope holds ids and no
// names, and the `channel-webhook` job's last failure marks the channel failing (once) without
// failing anything else. Every request goes to a local receiver.

let db: TestDb;
let hook: Receiver;
const master: MasterKey = { key: randomBytes(32), keyVersion: 1 };
const keyring = new Map([[1, master.key]]) as Keyring;
const PUBLIC_URL = 'https://kept.example.org';

beforeAll(async () => {
  db = await testDb();
  hook = await startReceiver({ tls: false });
});

afterAll(async () => {
  await hook.close();
});

beforeEach(async () => {
  await db.reset();
  hook.received.length = 0;
  hook.reply(200);
});

describe('signing and sending', () => {
  it('signs `<t>.<body>` with the secret, and a receiver can check it', () => {
    const body = '{"id":"evt_1"}';
    const now = Date.now();
    const header = signWebhook('whsec_a', Math.floor(now / 1000), body);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook('whsec_a', header, body, 300, now)).toBe(true);
    expect(verifyWebhook('whsec_b', header, body, 300, now)).toBe(false);
    expect(verifyWebhook('whsec_a', header, `${body} `, 300, now)).toBe(false);
    // A replay ten minutes later is stale.
    expect(verifyWebhook('whsec_a', header, body, 300, now + 600_000)).toBe(false);
  });

  it('posts the envelope signed, and the signature verifies with the channel’s secret', async () => {
    const config = { url: `${hook.url}/kept`, secret: 'whsec_test' };
    const res = await postWebhook(config, testEnvelope(PUBLIC_URL, newId()), {
      allowPrivate: true,
    });
    expect(res).toEqual({ ok: true, status: 200 });
    const [got] = hook.received;
    expect(got?.headers['content-type']).toBe('application/json');
    expect(got?.headers['kept-event']).toBe('channel.test');
    const raw = got?.body.toString() ?? '';
    expect(verifyWebhook('whsec_test', String(got?.headers['kept-signature']), raw)).toBe(true);
    expect((JSON.parse(raw) as WebhookEnvelope).id).toBe(got?.headers['kept-delivery']);
  });

  it('refuses a redirect, and a private address unless the instance allows them', async () => {
    const config = { url: `${hook.url}/kept`, secret: 'whsec_test' };
    hook.reply(302, { location: 'http://10.0.0.5/steal' });
    expect(
      await postWebhook(config, testEnvelope(PUBLIC_URL, newId()), { allowPrivate: true }),
    ).toMatchObject({ ok: false, error: 'redirect_refused' });
    hook.reply(200);
    const before = hook.received.length;
    expect(
      await postWebhook(config, testEnvelope(PUBLIC_URL, newId()), { allowPrivate: false }),
    ).toEqual({ ok: false, error: 'private_address' });
    expect(hook.received).toHaveLength(before);
  });
});

describe('the channel-webhook job', () => {
  type Setup = { data: { occurrenceId: string; userId: string; channelId: string }; email: string };

  /** Bruce's overdue loan reminder, delivered to his webhook at the local receiver. */
  async function reminder(): Promise<Setup> {
    const home = await seedTenant(db, 'bruce');
    const email = await userEmail(db, home.userId);
    const occurrenceId = newId();
    const channelId = newId();
    const thingId = newId();
    await ownerTx(db, async (c) => {
      await c.query(
        `INSERT INTO public.instance_settings (key, value) VALUES ('ssrf_allow_private', 'true')`,
      );
      await c.query(
        `INSERT INTO public.things (id, location_id, place_id, name) VALUES ($1, $2, $3, 'Drill')`,
        [thingId, home.locationId, home.unplacedId],
      );
      await c.query(
        `INSERT INTO public.reminder_occurrences
           (id, location_id, thing_id, source_type, source_id, kind, due_period, due_on)
         VALUES ($1, $2, $3, 'loan', $4, 'overdue', 'date:2026-10-17', '2026-10-17')`,
        [occurrenceId, home.locationId, thingId, newId()],
      );
      const sealed = sealWebhookConfig(master, channelId, {
        url: `${hook.url}/kept`,
        secret: 'whsec_bruce',
      });
      await c.query(
        `INSERT INTO public.notification_channels
           (id, user_id, kind, label, display_host, config_ciphertext, key_version)
         VALUES ($1, $2, 'webhook', 'Home Assistant', '127.0.0.1', $3::jsonb, 1)`,
        [channelId, home.userId, JSON.stringify(sealed)],
      );
      await c.query(
        `INSERT INTO public.reminder_deliveries (occurrence_id, user_id, channel_id, status)
         VALUES ($1, $2, $3, 'sent')`,
        [occurrenceId, home.userId, channelId],
      );
    });
    return { data: { occurrenceId, userId: home.userId, channelId }, email };
  }

  function jobDeps(mail: Mail[]): WebhookJobDeps {
    return {
      pools: db.pools,
      mailer: {
        send: async (m) => {
          mail.push(m);
        },
      },
      publicUrl: PUBLIC_URL,
      keyring: () => keyring,
    };
  }

  const state = (s: Setup) =>
    ownerTx(db, async (c) => {
      const d = await c.query<{ status: string; error: string | null; sent_at: Date | null }>(
        `SELECT status, error, sent_at FROM public.reminder_deliveries
          WHERE occurrence_id = $1 AND channel_id = $2`,
        [s.data.occurrenceId, s.data.channelId],
      );
      const ch = await c.query<{ verified_at: Date | null; failing_since: Date | null }>(
        'SELECT verified_at, failing_since FROM public.notification_channels WHERE id = $1',
        [s.data.channelId],
      );
      return { delivery: d.rows[0], channel: ch.rows[0] };
    });

  it('sends ids, the kind, the due date and a link, never a name (D110)', async () => {
    const s = await reminder();
    const mail: Mail[] = [];
    expect(
      await runChannelWebhook(jobDeps(mail), s.data, { id: 'j', retryCount: 0, retryLimit: 9 }),
    ).toBe('sent');
    const [got] = hook.received;
    const raw = got?.body.toString() ?? '';
    expect(verifyWebhook('whsec_bruce', String(got?.headers['kept-signature']), raw)).toBe(true);
    const env = JSON.parse(raw) as WebhookEnvelope;
    expect(env).toMatchObject({
      event: 'reminder.due',
      occurrence: {
        id: s.data.occurrenceId,
        kind: 'overdue',
        source_type: 'loan',
        due_on: '2026-10-17',
      },
      entity: { type: 'thing' },
    });
    expect(env.url).toBe(`${PUBLIC_URL}/t/${env.entity?.id}`);
    expect(raw).not.toContain('Drill');
    expect(raw).not.toContain('Home');
    const after = await state(s);
    expect(after.delivery).toMatchObject({ status: 'sent', error: null });
    expect(after.channel?.verified_at).toBeInstanceOf(Date);
  });

  it('retries a failure; the last one marks the channel failing and mails once', async () => {
    const s = await reminder();
    const mail: Mail[] = [];
    hook.reply(503);
    await expect(
      runChannelWebhook(jobDeps(mail), s.data, { id: 'j', retryCount: 3, retryLimit: 9 }),
    ).rejects.toThrow(/http_503/);
    let now = await state(s);
    expect(now.delivery).toMatchObject({ status: 'sent', error: 'http_503' });
    expect(now.channel?.failing_since).toBeNull();

    const last = { id: 'j', retryCount: 9, retryLimit: 9 };
    expect(await runChannelWebhook(jobDeps(mail), s.data, last)).toBe('failed');
    now = await state(s);
    expect(now.delivery).toMatchObject({ status: 'failed', error: 'http_503' });
    expect(now.channel?.failing_since).toBeInstanceOf(Date);
    expect(mail).toEqual([
      { kind: 'channel-failing', to: s.email, label: 'Home Assistant', host: '127.0.0.1' },
    ]);
    // Already failing: no second mail.
    await runChannelWebhook(jobDeps(mail), s.data, last);
    expect(mail).toHaveLength(1);

    // A later success clears it.
    hook.reply(200);
    await runChannelWebhook(jobDeps(mail), s.data, { id: 'k', retryCount: 0, retryLimit: 9 });
    expect((await state(s)).channel?.failing_since).toBeNull();
  });

  it('does nothing for a channel that isn’t that person’s, or an occurrence now closed', async () => {
    const s = await reminder();
    const other = await seedTenant(db, 'louis');
    const mail: Mail[] = [];
    expect(await runChannelWebhook(jobDeps(mail), { ...s.data, userId: other.userId })).toBe(
      'nothing',
    );
    await ownerTx(db, (c) =>
      c.query(
        `UPDATE public.reminder_occurrences SET state = 'done', closed_at = now() WHERE id = $1`,
        [s.data.occurrenceId],
      ),
    );
    expect(await runChannelWebhook(jobDeps(mail), s.data)).toBe('nothing');
    expect(await runChannelWebhook(jobDeps(mail), { nonsense: true })).toBe('nothing');
    expect(hook.received).toHaveLength(0);
  });
});
