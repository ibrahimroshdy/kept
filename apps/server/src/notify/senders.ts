import type { Keyring } from '../crypto/envelope.js';
import type { Pools } from '../db/pools.js';
import { withSystem } from '../db/scope.js';
import type { Mailer } from '../mail/mailer.js';
import { mailLocale, messageFor } from '../mail/messages.js';
import type {
  ChannelMessage,
  ChannelSender,
  ChannelSenders,
  ChannelTarget,
  ReminderItem,
  ReminderRecipient,
  SendOutcome,
} from '../reminders/channel.js';
import type { WebhookJobData } from './jobs.js';
import {
  digestPush,
  type PushPayload,
  type PushTransport,
  pushTopic,
  pushToUser,
  reminderPush,
  testPush,
} from './push.js';
import type { PushSource } from './vapid.js';
import {
  openWebhookConfig,
  postWebhook,
  testEnvelope,
  type WebhookFetch,
  webhookAllowsPrivate,
  webhookChannel,
} from './webhook.js';
import type { ReminderFacts } from './words.js';

// The channel senders the reminder engine delivers through (reminders/channel.ts, T14's
// contract; plan T15). Each turns one message into one email, push or webhook in the recipient's
// language and says how it went; none writes the ledger.
//
// - email: the reminder, digest and test mails (mail/messages-notify.ts). Present only when mail
//   goes out (KEPT_SMTP_URL). Admin alerts are mailed by alerts/alerts.ts, not here.
// - webpush: every device the person has (push.ts pushToUser), overdue at `high` urgency; admin
//   alerts reach the instance admins' devices too (step-1 carry-over, D166).
// - webhook: queues one `channel-webhook` job per reminder (jobs.ts), whose own ten attempts over
//   a day are the channel's; a test is sent at once.

export type SenderDeps = {
  pools: Pick<Pools, 'system'>;
  /** The mailer, when mail goes out; null: no email sender (the channel is off here). */
  mailer: Mailer | null;
  push: PushSource | null;
  keyring: () => Keyring;
  publicUrl: string;
  /** Queues a `channel-webhook` job (the worker's pg-boss). */
  enqueue: (name: 'channel-webhook', data: WebhookJobData) => Promise<void>;
  /** Tests: how a push or a webhook leaves the process. */
  transport?: { push?: PushTransport; webhookFetch?: WebhookFetch };
};

/** The words a template needs, from the engine's item (L113). */
export function factsOf(item: ReminderItem): ReminderFacts {
  return {
    sourceType: item.sourceType,
    kind: item.kind,
    title: item.title,
    documentKind: item.documentKind,
    subject: {
      type: item.subject.type,
      name: item.subject.name,
      path: item.subject.path.length > 0 ? item.subject.path.join(' › ') : null,
    },
    locationName: item.location.name,
    dueOn: item.dueOn,
    dueValue: item.dueValue,
    unit: item.unit,
    link: item.link,
    meter: item.meter ?? null,
  };
}

function emailSender(mailer: Mailer): ChannelSender {
  return {
    async send(_target, to, message): Promise<SendOutcome> {
      if (!to.email) return { status: 'skipped', error: 'no_address' };
      const base = { to: to.email, locale: to.locale };
      try {
        if (message.mode === 'immediate') {
          await mailer.send({ ...base, kind: 'reminder', item: factsOf(message.item) });
        } else if (message.mode === 'digest') {
          await mailer.send({
            ...base,
            kind: 'reminder-digest',
            day: message.digestOn,
            items: message.items.map(factsOf),
          });
        } else if (message.mode === 'test') {
          await mailer.send({ ...base, kind: 'channel-test' });
        } else {
          return { status: 'skipped', error: 'alerts_mail_themselves' };
        }
      } catch {
        return { status: 'failed', error: 'smtp_error' };
      }
      return { status: 'sent' };
    },
  };
}

/** An admin alert as a push: its mail's subject and first line, linking where the mail does. */
function alertPush(
  locale: ReturnType<typeof mailLocale>,
  publicUrl: string,
  message: Extract<ChannelMessage, { mode: 'alert' }>,
): PushPayload {
  const m = messageFor(
    { kind: 'admin-alert', to: '', alert: message.alert, details: message.details },
    locale,
    { publicUrl },
  );
  const url = m.action ? new URL(m.action.url).pathname : '/admin/status';
  return { title: m.subject, body: m.paragraphs[0] ?? '', url, tag: `alert-${message.alert}` };
}

function pushSender(deps: SenderDeps): ChannelSender {
  return {
    async send(target, to, message): Promise<SendOutcome> {
      const setup = deps.push ? await deps.push() : null;
      if (!setup?.available) return { status: 'skipped', error: 'push_unavailable' };
      const locale = mailLocale(to.locale);
      let payload: PushPayload;
      let urgency: 'high' | 'normal' = 'normal';
      let topic: string | undefined;
      if (message.mode === 'immediate') {
        topic = pushTopic(message.item.key);
        payload = reminderPush(locale, factsOf(message.item), topic);
        urgency = message.item.kind === 'overdue' ? 'high' : 'normal';
      } else if (message.mode === 'digest') {
        topic = pushTopic(`digest:${message.digestOn}`);
        payload = digestPush(locale, message.items.map(factsOf), message.digestOn);
      } else if (message.mode === 'alert') {
        payload = alertPush(locale, deps.publicUrl, message);
        urgency = 'high';
      } else {
        payload = testPush(locale);
      }
      const res = await pushToUser(
        deps.pools.system,
        target.userId,
        payload,
        { urgency, topic },
        {
          details: setup.details,
          ...(deps.transport?.push ? { transport: deps.transport.push } : {}),
        },
      );
      if (res.status === 'sent') return { status: 'sent' };
      if (res.status === 'skipped') {
        return { status: 'skipped', error: res.gone > 0 ? 'push_gone' : 'no_device' };
      }
      return { status: 'failed', error: res.error ?? 'push_failed' };
    },
  };
}

function webhookSender(deps: SenderDeps): ChannelSender {
  const queue = (target: ChannelTarget, item: ReminderItem) =>
    deps.enqueue('channel-webhook', {
      occurrenceId: item.occurrenceId,
      userId: target.userId,
      channelId: target.id,
    });
  return {
    async send(target, _to: ReminderRecipient, message): Promise<SendOutcome> {
      if (message.mode === 'immediate') {
        await queue(target, message.item);
        return { status: 'sent' };
      }
      if (message.mode === 'digest') {
        for (const item of message.items) await queue(target, item);
        return { status: 'sent' };
      }
      if (message.mode === 'alert') return { status: 'skipped', error: 'alerts_not_webhooked' };
      const channel = await withSystem(deps.pools.system, (_t, c) =>
        webhookChannel(c, target.id, target.userId),
      );
      if (!channel) return { status: 'skipped', error: 'channel_gone' };
      const res = await postWebhook(
        openWebhookConfig(deps.keyring(), channel.id, channel.sealed),
        testEnvelope(deps.publicUrl, channel.id),
        {
          allowPrivate: await webhookAllowsPrivate(deps.pools),
          ...(deps.transport?.webhookFetch ? { fetchFor: deps.transport.webhookFetch } : {}),
        },
      );
      return res.ok ? { status: 'sent' } : { status: 'failed', error: res.error };
    },
  };
}

/** Every sender this instance has: email only when mail goes out. */
export function createChannelSenders(deps: SenderDeps): ChannelSenders {
  return {
    ...(deps.mailer ? { email: emailSender(deps.mailer) } : {}),
    webpush: pushSender(deps),
    webhook: webhookSender(deps),
  };
}
