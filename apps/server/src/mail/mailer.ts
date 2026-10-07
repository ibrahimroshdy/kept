import type { ProviderKind } from '@kept/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { AuthMail } from '../auth/auth.js';
import type { SecurityEvent } from '../auth/security.js';
import type { AdminAlertKind } from '../db/schema/alerts.js';
import type { ReminderFacts } from '../notify/words.js';

// Outgoing mail, by kind. Every link carries its token in the #fragment of a web page that
// consumes it by POST (D176, D181), so neither a mail scanner nor a server log ever holds a
// usable token. Rendering (subject, body, language) belongs to the transport (mail/smtp.ts,
// mail/messages.ts); a mail says what happened, never how it reads.

/** Every kind of mail, without its language. */
export type MailBody =
  | { kind: 'magic-link'; to: string; url: string }
  | { kind: 'password-reset'; to: string; url: string }
  /** To the *old* address: confirm moving the account to `newEmail` (D176). */
  | { kind: 'email-change-confirm'; to: string; url: string; newEmail: string }
  /** To the *new* address, once the old one confirmed: prove you can receive mail here. */
  | { kind: 'email-change-verify'; to: string; url: string }
  /** To the old address, after the change: it happened, and to what. */
  | { kind: 'email-changed'; to: string; newEmail: string }
  /** An email invite (D33): the link, only ever mailed (task 20). */
  | {
      kind: 'invite';
      to: string;
      url: string;
      locationName: string;
      inviterName: string;
      role: 'admin' | 'member' | 'viewer';
    }
  /** Someone tried to sign up with an address that already has an account. The sign-up itself
   * answers as if it were new, so only the address's owner learns of it. */
  | { kind: 'sign-up-existing'; to: string }
  /** A credential changed on the account (security review I3): if it wasn't them, they know. */
  | { kind: 'security-notice'; to: string; event: SecurityEvent }
  /** An instance admin (or the operator's `kept admin` CLI) acted on this person's account
   * (D180: instance-admin transparency). `locationName` for an ownership transfer. */
  | { kind: 'admin-action'; to: string; action: AdminAction; locationName?: string }
  /** D180: the owner hears of every new member and managed account in their location. */
  | {
      kind: 'owner-new-member';
      to: string;
      locationName: string;
      memberName: string;
      role: 'admin' | 'member' | 'viewer';
      managed: boolean;
    }
  /** D206: a monthly AI cap reached 80% or 100% (once per cap, level and month), to whoever
   * set it and the people it governs (kept.ai_notice_recipients, 0043). */
  | { kind: 'ai-cap'; to: string; level: 80 | 100; cap: AiCapFacts }
  /** D166: an admin alert, to each instance admin, at most once a day per alert. */
  | {
      kind: 'admin-alert';
      to: string;
      alert: AdminAlertKind;
      /** The alert's latest figures (admin_alerts.payload). */
      details: Record<string, unknown>;
    }
  // Step 4 (plan T15; mail/messages-notify.ts). A reminder sent at once (an overdue item, D29),
  // naming the thing, its path, the location and the local date (L113).
  | { kind: 'reminder'; to: string; item: ReminderFacts }
  /** The day's digest (D122): every due and expiring item, all locations, each with its date.
   * `day` is the recipient's local date (YYYY-MM-DD). */
  | { kind: 'reminder-digest'; to: string; day: string; items: ReminderFacts[] }
  /** D46: a membership reached its end date; to the location's owner. `endedOn` YYYY-MM-DD. */
  | {
      kind: 'membership-ended';
      to: string;
      locationName: string;
      memberName: string;
      role: 'admin' | 'member' | 'viewer';
      endedOn: string;
    }
  /** Settings → Me → Notifications → Test, on the email channel. */
  | { kind: 'channel-test'; to: string }
  /** A webhook channel failed its last attempt (about a day of retries, §2.6). */
  | { kind: 'channel-failing'; to: string; label: string | null; host: string | null }
  /** Product design §8a: last month's AI for an account owner or a personal key's owner (the
   * `ai-summary` job, ai/summary.ts). `month` is YYYY-MM; `cost` per currency, decimal strings. */
  | {
      kind: 'ai-summary';
      to: string;
      month: string;
      calls: number;
      tokens: string;
      cost: { currency: string; amount: string }[];
      unknownCostCalls: number;
    }
  // Step 6 (T16, D180; mail/messages-transparency.ts): to every active user when the instance's
  // OIDC sign-in (`name`: its new name; null: turned off), its outgoing mail (`sender`, the new
  // From address) or its default AI provider changes.
  | { kind: 'oidc-changed'; to: string; name: string | null }
  | { kind: 'smtp-changed'; to: string; sender: string }
  | { kind: 'ai-provider-changed'; to: string; provider: ProviderKind };

/** What a cap notice (and the instance caps' admin alerts) says about the cap. */
export type AiCapFacts = {
  scope: 'instance' | 'instance_account' | 'account' | 'location' | 'member' | 'user';
  /** The location, person or account it is for, in words; '' when there is none to name. */
  target: string;
  unit: 'tokens' | 'money';
  /** Decimal strings: tokens, or money in `currency`. */
  used: string;
  limit: string;
  currency: string | null;
  /** When a 100% pause ends (the 1st of next month, UTC), ISO. */
  pausedUntil: string | null;
};

/** A mail, with the language it goes out in when the sender knows it (a BCP 47 tag such as
 * `ar-EG`). Without one the transport looks up the profile of the account at `to` (D81). */
export type Mail = MailBody & { locale?: string | null };

export type MailKind = Mail['kind'];

/** What an instance admin, or the `kept admin` CLI, did to someone's account (D165, D180). */
export type AdminAction =
  | 'disabled'
  | 'enabled'
  | 'two-factor-reset'
  | 'signed-out-everywhere'
  | 'instance-admin-granted'
  | 'instance-admin-revoked'
  | 'password-reset-issued'
  | 'location-ownership-received'
  | 'location-ownership-moved';

export type Mailer = { send: (mail: Mail) => Promise<void> };

/**
 * The mailer when KEPT_SMTP_URL is unset (mail/transport.ts): it records that a mail was due, by
 * kind only. Never the address, the URL or the token (D81, D181), so a log is never a way into
 * someone's account. The admin status page says mail isn't configured.
 */
export function logMailer(logger: Pick<FastifyBaseLogger, 'warn'>): Mailer {
  return {
    send: async (mail) => {
      logger.warn({ mail: mail.kind }, 'mail not sent: no mail transport is configured');
    },
  };
}

/** Better Auth's mail callbacks, on top of a Mailer. */
export function authMail(mailer: Mailer): AuthMail {
  return {
    sendMagicLink: ({ email, url }) => mailer.send({ kind: 'magic-link', to: email, url }),
    sendPasswordReset: ({ email, url }) => mailer.send({ kind: 'password-reset', to: email, url }),
    sendSecurityNotice: ({ email, event }) =>
      mailer.send({ kind: 'security-notice', to: email, event }),
  };
}
