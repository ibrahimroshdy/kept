import { createTransport } from 'nodemailer';
import { logMailer, type Mail, type Mailer } from './mailer.js';
import { mailLocale, messageFor } from './messages.js';
import { renderMail } from './render.js';

// The SMTP transport (D81, §7.11 KEPT_SMTP_URL): nodemailer, a connection per mail (mail is
// rare; nodemailer's own URL options, such as `?pool=true` or `tls.*`, pass through). Every mail
// is rendered in the recipient's language (mail/messages.ts) as text and HTML (mail/render.tsx).
// Without KEPT_SMTP_URL, mail is only logged as due (logMailer) and the admin status page says so.

/** Anything with a pg `query`: a kept_system pool (the server) or the owner client (the CLI). */
type Queryable = {
  query: <R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<{
    rows: R[];
  }>;
};

export type LocaleLookup = (email: string) => Promise<string | null>;

/** The profile locale of the account at an address (kept.mail_locale(), migration 0011). */
export function profileLocaleLookup(db: Queryable): LocaleLookup {
  return async (email) => {
    const { rows } = await db.query<{ locale: string | null }>(
      'SELECT kept.mail_locale($1) AS locale',
      [email],
    );
    return rows[0]?.locale ?? null;
  };
}

/** `Kept <no-reply@host>` for the public URL's host, when KEPT_SMTP_FROM isn't set. */
export function defaultFrom(publicUrl: string): string {
  return `Kept <no-reply@${new URL(publicUrl).hostname}>`;
}

export type SmtpOptions = {
  /** KEPT_SMTP_URL: smtp:// or smtps://, with credentials if the server wants them. */
  url: string;
  /** KEPT_SMTP_FROM, or defaultFrom(). */
  from: string;
  /** KEPT_PUBLIC_URL: where the mails' links point and which Kept they say sent them. */
  publicUrl: string;
  /** The recipient's locale when the mail doesn't carry one. Failures count as "unknown". */
  localeOf?: LocaleLookup;
};

export type SmtpMailer = Mailer & { close: () => void };

/** The language a mail goes out in: its own, else the recipient's profile, else English. */
async function localeFor(mail: Mail, localeOf?: LocaleLookup) {
  if (mail.locale) return mailLocale(mail.locale);
  if (!localeOf) return mailLocale(null);
  return mailLocale(await localeOf(mail.to).catch(() => null));
}

export function smtpMailer(opts: SmtpOptions): SmtpMailer {
  const transport = createTransport(opts.url);
  return {
    send: async (mail) => {
      const locale = await localeFor(mail, opts.localeOf);
      const message = messageFor(mail, locale, { publicUrl: opts.publicUrl });
      const rendered = renderMail(message, locale, opts.publicUrl);
      await transport.sendMail({
        from: opts.from,
        to: mail.to,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        headers: { 'Content-Language': locale, 'X-Kept-Mail': mail.kind },
      });
    },
    close: () => transport.close(),
  };
}

export type MailSetup = {
  mailer: Mailer;
  /** False when mail is only logged: the admin status page shows "mail not configured". */
  configured: boolean;
  close: () => void;
};

export type MailEnv = {
  KEPT_SMTP_URL?: string | undefined;
  KEPT_SMTP_FROM?: string | undefined;
  KEPT_PUBLIC_URL: string;
};

/** The process's mailer: SMTP when KEPT_SMTP_URL is set, else the log. */
export function createMailer(
  env: MailEnv,
  opts: { localeOf?: LocaleLookup; logger: Parameters<typeof logMailer>[0] },
): MailSetup {
  if (!env.KEPT_SMTP_URL) {
    return { mailer: logMailer(opts.logger), configured: false, close: () => {} };
  }
  const smtp = smtpMailer({
    url: env.KEPT_SMTP_URL,
    from: env.KEPT_SMTP_FROM ?? defaultFrom(env.KEPT_PUBLIC_URL),
    publicUrl: env.KEPT_PUBLIC_URL,
    ...(opts.localeOf ? { localeOf: opts.localeOf } : {}),
  });
  return { mailer: smtp, configured: true, close: smtp.close };
}
