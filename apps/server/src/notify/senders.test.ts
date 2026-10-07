import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import https from 'node:https';
import { newId } from '@kept/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import webpush from 'web-push';
import { type TestDb, testDb } from '../../test/db.js';
import { MAILPIT_SMTP_URL, mailpitWait } from '../../test/mailpit.js';
import { type Receiver, startReceiver } from '../../test/receiver.js';
import { ownerTx, seedUser } from '../../test/tenancy.js';
import type { Keyring } from '../crypto/envelope.js';
import type { Mail } from '../mail/mailer.js';
import { MAIL_LOCALES } from '../mail/messages.js';
import { type SmtpMailer, smtpMailer } from '../mail/transport.js';
import type { ChannelTarget, ReminderItem, ReminderRecipient } from '../reminders/channel.js';
import type { WebhookJobData } from './jobs.js';
import { pushTopic } from './push.js';
import { createChannelSenders, factsOf, type SenderDeps } from './senders.js';
import { fixedPushSource } from './vapid.js';

// The channel senders the reminder engine calls (reminders/channel.ts; plan T15): one email, push
// or webhook per message in the recipient's language, and an outcome the engine records. Email
// goes to the dev Mailpit in all five languages; pushes to a local HTTPS receiver; webhooks are
// only queued here (their job is webhook.test.ts's).

let db: TestDb;
let service: Receiver;
let smtp: SmtpMailer;
const vapid = webpush.generateVAPIDKeys();
const PUBLIC_URL = 'https://kept.example.org';

function item(over: Partial<ReminderItem> = {}): ReminderItem {
  const occurrenceId = newId();
  const sourceId = newId();
  return {
    occurrenceId,
    key: `loan:${sourceId}:overdue:date:2026-10-17`,
    sourceType: 'loan',
    sourceId,
    kind: 'overdue',
    duePeriod: 'date:2026-10-17',
    dueOn: '2026-10-17',
    dueValue: null,
    unit: null,
    title: null,
    warrantyKind: null,
    documentKind: null,
    loanDirection: 'out',
    subject: { type: 'thing', id: newId(), name: 'Drill', path: ['Garage', 'Shelf'] },
    location: { id: newId(), name: 'Home', timezone: 'Africa/Cairo' },
    link: '/t/0192f0c3-7c55-7000-8000-000000000002?tab=loans',
    url: `${PUBLIC_URL}/t/0192f0c3-7c55-7000-8000-000000000002?tab=loans`,
    ...over,
  };
}

const recipient = (over: Partial<ReminderRecipient> = {}): ReminderRecipient => ({
  userId: newId(),
  name: 'Bruce',
  locale: 'en',
  timezone: 'Africa/Cairo',
  email: `bruce-${randomUUID()}@example.test`,
  ...over,
});

const target = (kind: ChannelTarget['kind'], userId: string): ChannelTarget => ({
  id: newId(),
  kind,
  userId,
});

function deps(over: Partial<SenderDeps> = {}): SenderDeps {
  return {
    pools: db.pools,
    mailer: null,
    push: fixedPushSource({
      available: true,
      publicKey: vapid.publicKey,
      details: { ...vapid, subject: 'mailto:kept@example.org' },
    }),
    keyring: () => new Map() as Keyring,
    publicUrl: PUBLIC_URL,
    enqueue: async () => {},
    transport: {
      push: {
        send: webpush.sendNotification,
        agent: new https.Agent({ ca: service.ca as Buffer }),
        refuseLiterals: false,
      },
    },
    ...over,
  };
}

beforeAll(async () => {
  db = await testDb();
  service = await startReceiver({ tls: true });
  smtp = smtpMailer({
    url: MAILPIT_SMTP_URL,
    from: 'Kept <kept@kept.test>',
    publicUrl: PUBLIC_URL,
  });
});

afterAll(async () => {
  smtp.close();
  await service.close();
});

beforeEach(async () => {
  await db.reset();
  service.received.length = 0;
  service.reply(201);
});

describe('factsOf', () => {
  it('writes the engine’s path as words, outermost first', () => {
    expect(factsOf(item()).subject).toEqual({
      type: 'thing',
      name: 'Drill',
      path: 'Garage › Shelf',
    });
    expect(
      factsOf(item({ subject: { type: 'location', id: newId(), name: 'Home', path: [] } })).subject
        .path,
    ).toBeNull();
  });
});

describe('the email sender', () => {
  it('mails an overdue reminder, the digest and a test; skips without an address', async () => {
    const sent: Mail[] = [];
    const senders = createChannelSenders(
      deps({ mailer: { send: async (m) => void sent.push(m) } }),
    );
    const email = senders.email;
    if (!email) throw new Error('an email sender when mail goes out');
    const to = recipient({ locale: 'ar-EG' });
    const tgt = target('email', to.userId);
    const one = item();
    expect(await email.send(tgt, to, { mode: 'immediate', item: one })).toEqual({ status: 'sent' });
    expect(
      await email.send(tgt, to, { mode: 'digest', digestOn: '2026-10-18', items: [one, item()] }),
    ).toEqual({
      status: 'sent',
    });
    expect(await email.send(tgt, to, { mode: 'test' })).toEqual({ status: 'sent' });
    expect(sent.map((m) => [m.kind, m.to, m.locale])).toEqual([
      ['reminder', to.email, 'ar-EG'],
      ['reminder-digest', to.email, 'ar-EG'],
      ['channel-test', to.email, 'ar-EG'],
    ]);
    expect(await email.send(tgt, { ...to, email: null }, { mode: 'test' })).toEqual({
      status: 'skipped',
      error: 'no_address',
    });
    const broken = createChannelSenders(
      deps({
        mailer: {
          send: async () => {
            throw new Error('421 try later');
          },
        },
      }),
    ).email;
    expect(await broken?.send(tgt, to, { mode: 'test' })).toEqual({
      status: 'failed',
      error: 'smtp_error',
    });
  });

  it('is off when mail doesn’t go out', () => {
    expect(createChannelSenders(deps()).email).toBeUndefined();
  });

  it.each(MAIL_LOCALES)(
    'reaches Mailpit in %s, naming the thing, path, place and date',
    async (locale) => {
      const email = createChannelSenders(deps({ mailer: smtp })).email;
      const to = recipient({ locale });
      const res = await email?.send(target('email', to.userId), to, {
        mode: 'immediate',
        item: item(),
      });
      expect(res).toEqual({ status: 'sent' });
      const [msg] = await mailpitWait(to.email as string);
      expect(msg?.Text).toContain('Drill');
      expect(msg?.Text).toContain('Garage › Shelf');
      expect(msg?.Text).toContain('Home');
      expect(msg?.Text).toContain('2026');
      expect(msg?.HTML).toContain(locale === 'ar' ? 'dir="rtl"' : 'dir="ltr"');
      expect(msg?.Text).toContain(`${PUBLIC_URL}/settings/me/notifications`);
    },
  );
});

describe('the push sender', () => {
  async function device(userId: string, path: string): Promise<void> {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.push_subscriptions (user_id, endpoint, p256dh, auth)
         VALUES ($1, $2, $3, $4)`,
        [
          userId,
          `${service.url}${path}`,
          ecdh.getPublicKey().toString('base64url'),
          randomBytes(16).toString('base64url'),
        ],
      ),
    );
  }

  it('pushes an overdue reminder at high urgency, replacing an earlier one by topic', async () => {
    const bruce = await seedUser(db, 'bruce');
    await device(bruce, '/push/bruce');
    const push = createChannelSenders(deps()).webpush;
    const one = item();
    expect(
      await push?.send(target('webpush', bruce), recipient({ userId: bruce }), {
        mode: 'immediate',
        item: one,
      }),
    ).toEqual({ status: 'sent' });
    expect(service.received[0]?.headers).toMatchObject({
      urgency: 'high',
      topic: pushTopic(one.key),
    });
  });

  it('pushes an admin alert, and says why when it can’t push', async () => {
    const ibrahim = await seedUser(db, 'ibrahim');
    const push = createChannelSenders(deps()).webpush;
    const alert = {
      mode: 'alert' as const,
      alert: 'failed_jobs_rising' as const,
      details: { failedLastHour: 7 },
    };
    const to = recipient({ userId: ibrahim });
    expect(await push?.send(target('webpush', ibrahim), to, alert)).toEqual({
      status: 'skipped',
      error: 'no_device',
    });
    await device(ibrahim, '/push/admin');
    expect(await push?.send(target('webpush', ibrahim), to, alert)).toEqual({ status: 'sent' });
    const off = createChannelSenders(
      deps({ push: fixedPushSource({ available: false, reason: 'no_https' }) }),
    ).webpush;
    expect(await off?.send(target('webpush', ibrahim), to, { mode: 'test' })).toEqual({
      status: 'skipped',
      error: 'push_unavailable',
    });
  });
});

describe('the webhook sender', () => {
  it('queues one channel-webhook job per reminder, and none for an alert', async () => {
    const queued: WebhookJobData[] = [];
    const hook = createChannelSenders(
      deps({ enqueue: async (_name, data) => void queued.push(data) }),
    ).webhook;
    const to = recipient();
    const tgt = target('webhook', to.userId);
    const [a, b] = [item(), item()];
    expect(await hook?.send(tgt, to, { mode: 'immediate', item: a })).toEqual({ status: 'sent' });
    expect(
      await hook?.send(tgt, to, { mode: 'digest', digestOn: '2026-10-18', items: [a, b] }),
    ).toEqual({
      status: 'sent',
    });
    expect(queued).toEqual([
      { occurrenceId: a.occurrenceId, userId: to.userId, channelId: tgt.id },
      { occurrenceId: a.occurrenceId, userId: to.userId, channelId: tgt.id },
      { occurrenceId: b.occurrenceId, userId: to.userId, channelId: tgt.id },
    ]);
    expect(
      await hook?.send(tgt, to, { mode: 'alert', alert: 'backup_failed', details: {} }),
    ).toMatchObject({ status: 'skipped' });
  });
});
