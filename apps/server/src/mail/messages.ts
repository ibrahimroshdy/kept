import type { SecurityEvent } from '../auth/security.js';
import type { AdminAction, AiCapFacts, MailBody } from './mailer.js';
import {
  aiPage,
  type Chrome,
  type CoreTable,
  capFactsOf,
  capitalise,
  day,
  diskFacts,
  type Message,
  type MessageContext,
  num,
  page,
  type Table,
  tokens,
} from './message-kit.js';
import { DE, DE_CHROME } from './messages-de.js';
import { FR, FR_CHROME } from './messages-fr.js';
import { IT, IT_CHROME } from './messages-it.js';
import { NOTIFY_MESSAGES } from './messages-notify.js';
import { TRANSPARENCY_MESSAGES } from './messages-transparency.js';

export type { Chrome, Message, MessageContext } from './message-kit.js';

// What each mail says, in each language Kept mails in (D81, D106). The web app's catalogues are
// Lingui's, on the web side; server mail has this small typed table instead, keyed by the
// recipient's profile locale (mail/transport.ts). A kind missing from a language is a type
// error, so a new mail kind can't ship untranslated. The test checks every kind renders in each.
// English and Arabic live here; French, German and Italian (D204) in messages-<locale>.ts.

export const MAIL_LOCALES = ['en', 'ar', 'fr', 'de', 'it'] as const;
export type MailLocale = (typeof MAIL_LOCALES)[number];

/** The mail language for a BCP 47 tag (`ar-EG` → `ar`, `fr-CA` → `fr`); English for anything else. */
export function mailLocale(tag: string | null | undefined): MailLocale {
  const language = (tag ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return (MAIL_LOCALES as readonly string[]).includes(language ?? '')
    ? (language as MailLocale)
    : 'en';
}

// ---------------------------------------------------------------------------------------------
// English
// ---------------------------------------------------------------------------------------------

const EN_ROLE = { admin: 'an admin', member: 'a member', viewer: 'a viewer' } as const;

const EN_NOT_YOU = 'If this wasn’t you, reset your password now from the sign-in page.';

const EN_SECURITY: Record<SecurityEvent, (ctx: MessageContext) => Message> = {
  'passkey-added': () => ({
    subject: 'A passkey was added to your Kept account',
    paragraphs: [
      'A new passkey was added to your Kept account, and every other device was signed out.',
    ],
    footnote:
      'If this wasn’t you, reset your password now and remove the passkey in your account settings.',
  }),
  'two-factor-disabled': () => ({
    subject: 'Two-factor sign-in was turned off',
    paragraphs: [
      'Two-factor authentication was turned off for your Kept account, and every other device was signed out.',
    ],
    footnote: 'If this wasn’t you, reset your password now and turn two-factor back on.',
  }),
  'password-changed': () => ({
    subject: 'Your Kept password was changed',
    paragraphs: [
      'The password for your Kept account was changed, and every other device was signed out.',
    ],
    footnote: EN_NOT_YOU,
  }),
  'unverified-account-reset': () => ({
    subject: 'Your email address is confirmed',
    paragraphs: [
      'Your Kept password was reset from this mailbox, which confirms that the account’s email address is yours.',
      'The address hadn’t been confirmed before, so in case someone else set the account up, every passkey, two-factor setting and signed-in device added before now has been removed.',
    ],
    footnote:
      'Sign in with your new password, and set up two-factor again if you use it. If you didn’t reset your password, reset it again now.',
  }),
  'unverified-account-link': () => ({
    subject: 'Your email address is confirmed',
    paragraphs: [
      'You signed in to Kept with a link sent to this mailbox, which confirms that the account’s email address is yours.',
      'The address hadn’t been confirmed before, so in case someone else set the account up, its password, passkeys, two-factor settings and every other signed-in device have been removed.',
    ],
    footnote:
      'Choose a new password, and set up two-factor again if you use it, in your account settings.',
  }),
};

const EN_ADMIN: Record<AdminAction, (locationName: string) => Message> = {
  disabled: () => ({
    subject: 'Your Kept account was disabled',
    paragraphs: [
      'An administrator of this Kept disabled your account. You can’t sign in until it is enabled again.',
    ],
  }),
  enabled: () => ({
    subject: 'Your Kept account was enabled again',
    paragraphs: ['An administrator enabled your account again. You can sign in as before.'],
  }),
  'two-factor-reset': () => ({
    subject: 'Two-factor sign-in was reset on your account',
    paragraphs: [
      'An administrator removed two-factor authentication from your account and signed it out everywhere, usually because you lost your authenticator.',
      'Set up two-factor again in your account settings.',
    ],
  }),
  'signed-out-everywhere': () => ({
    subject: 'You were signed out of Kept everywhere',
    paragraphs: [
      'An administrator signed your account out on every device. Sign in again to carry on.',
    ],
  }),
  'instance-admin-granted': () => ({
    subject: 'You are now an administrator of this Kept',
    paragraphs: [
      'You were made an instance administrator: you can now manage this Kept’s users and settings.',
    ],
  }),
  'instance-admin-revoked': () => ({
    subject: 'You are no longer an administrator of this Kept',
    paragraphs: [
      'Your instance administrator rights were removed. Your own locations and everything in them are unchanged.',
    ],
  }),
  'password-reset-issued': () => ({
    subject: 'A password reset was issued for your account',
    paragraphs: [
      'The person who runs this Kept issued a one-time password reset for your account and signed it out everywhere.',
      'They will give you the code to choose a new password with.',
    ],
  }),
  'location-ownership-received': (name) => ({
    subject: `You now own ${name}`,
    paragraphs: [`The person who runs this Kept made you the owner of ${name}.`],
  }),
  'location-ownership-moved': (name) => ({
    subject: `${name} has a new owner`,
    paragraphs: [
      `The person who runs this Kept moved ${name} to a new owner. You stay in it as an admin.`,
    ],
  }),
};

// AI caps (D206): the cap in words, and how much of it is used.
function enCapOf(c: AiCapFacts): string {
  switch (c.scope) {
    case 'location':
      return `${c.target}’s AI cap`;
    case 'member':
      return c.target ? `${c.target}’s AI cap` : 'a person’s AI cap';
    case 'account':
      return 'your account’s AI cap';
    case 'user':
      return 'your personal AI cap';
    case 'instance':
      return 'this server’s AI cap';
    case 'instance_account':
      return c.target
        ? `${c.target}’s allowance on this server’s AI key`
        : 'the allowance on this server’s AI key';
  }
}
const enUsed = (c: AiCapFacts) =>
  c.unit === 'money'
    ? `${c.currency} ${c.used} of ${c.currency} ${c.limit}`
    : `${tokens('en', c.used)} of ${tokens('en', c.limit)} tokens`;

function enCap(level: 80 | 100, c: AiCapFacts, ctx: MessageContext, footnote: string): Message {
  const cap = enCapOf(c);
  if (level === 80) {
    return {
      subject: `Kept: 80% of ${cap} used this month`,
      paragraphs: [
        `${capitalise(cap)} is at ${enUsed(c)} so far this month.`,
        'When it reaches the cap, AI pauses until the 1st of next month. Captures still save, and their photos are read once AI resumes.',
      ],
      action: { label: 'Open AI settings', url: aiPage(ctx, c.scope) },
      footnote,
    };
  }
  return {
    subject: `Kept: AI paused until ${day(c.pausedUntil)}`,
    paragraphs: [
      `${capitalise(cap)} is reached: ${enUsed(c)} this month.`,
      `AI is paused until ${day(c.pausedUntil)}. Captures still save, and their photos are read when it resumes. To resume sooner, raise or remove the cap.`,
    ],
    action: { label: 'Resume now', url: aiPage(ctx, c.scope) },
    footnote,
  };
}

const EN: CoreTable = {
  'magic-link': (m) => ({
    subject: 'Your Kept sign-in link',
    paragraphs: ['Use this link to sign in to Kept. It works once, within the next 15 minutes.'],
    action: { label: 'Sign in', url: m.url },
    footnote:
      'If you didn’t ask to sign in, ignore this email. Nobody can sign in without the link.',
  }),
  'password-reset': (m) => ({
    subject: 'Reset your Kept password',
    paragraphs: [
      'Someone asked to reset the password of this Kept account. Use this link to choose a new one. It works once, within the next hour.',
    ],
    action: { label: 'Choose a new password', url: m.url },
    footnote: 'If this wasn’t you, ignore this email: your password stays as it is.',
  }),
  'email-change-confirm': (m) => ({
    subject: 'Confirm your new email address',
    paragraphs: [
      `Someone signed in to your Kept account asked to move it to ${m.newEmail}. If that was you, confirm it with this link within the next hour.`,
    ],
    action: { label: 'Confirm the change', url: m.url },
    footnote:
      'If it wasn’t you, don’t use the link: your account stays on this address. You may want to change your password.',
  }),
  'email-change-verify': (m) => ({
    subject: 'Verify your email address for Kept',
    paragraphs: ['Use this link to finish moving your Kept account to this address.'],
    action: { label: 'Verify this address', url: m.url },
    footnote: 'If you didn’t expect this, ignore it: nothing changes until the link is used.',
  }),
  'email-changed': (m) => ({
    subject: 'Your Kept email address was changed',
    paragraphs: [
      `Your Kept account now uses ${m.newEmail}. This address no longer receives its mail.`,
    ],
    footnote: 'If you didn’t make this change, contact the person who runs your Kept.',
  }),
  invite: (m) => ({
    subject: m.inviterName
      ? `${m.inviterName} invited you to ${m.locationName} on Kept`
      : `You’re invited to ${m.locationName} on Kept`,
    paragraphs: [
      m.inviterName
        ? `${m.inviterName} invited you to join ${m.locationName} as ${EN_ROLE[m.role]}.`
        : `You’re invited to join ${m.locationName} as ${EN_ROLE[m.role]}.`,
      'Kept keeps track of the things you own, where they are, and what’s due for them.',
    ],
    action: { label: 'Accept the invitation', url: m.url },
    footnote: 'If you weren’t expecting this, ignore it: nothing happens unless you accept.',
  }),
  'sign-up-existing': (_m, ctx) => ({
    subject: 'Someone tried to sign up with your email address',
    paragraphs: [
      'Someone tried to create a Kept account with this address, which already has one. No new account was made.',
      'If it was you, sign in instead. If you’ve forgotten your password, you can reset it from the sign-in page.',
    ],
    action: { label: 'Sign in', url: page(ctx, '/signin') },
    footnote: 'If it wasn’t you, there’s nothing you need to do.',
  }),
  'security-notice': (m, ctx) => EN_SECURITY[m.event](ctx),
  'admin-action': (m) => ({
    ...EN_ADMIN[m.action](m.locationName ?? ''),
    footnote: 'This is an automatic notice about your account.',
  }),
  'owner-new-member': (m) => ({
    subject: `${m.memberName} joined ${m.locationName}`,
    paragraphs: [
      m.managed
        ? `${m.memberName} was added to ${m.locationName} as a managed account, with the role of ${EN_ROLE[m.role]}.`
        : `${m.memberName} now has access to ${m.locationName} as ${EN_ROLE[m.role]}.`,
    ],
    footnote:
      'You get this as the owner, for every new member. You can change or remove members in the location’s settings.',
  }),
  'ai-cap': (m, ctx) =>
    enCap(
      m.level,
      m.cap,
      ctx,
      'You get this because you set this cap or it covers your work. It is sent once a month.',
    ),
  'admin-alert': (m, ctx) => {
    const footnote =
      'You get this as an administrator of this Kept. It is sent at most once a day while the problem lasts.';
    if (m.alert === 'ai_instance_cap_warning' || m.alert === 'ai_instance_cap_reached') {
      const c = capFactsOf(m.details);
      if (c) return enCap(m.alert === 'ai_instance_cap_warning' ? 80 : 100, c, ctx, footnote);
    }
    if (m.alert === 'ai_instance_key_rejected') {
      return {
        subject: 'Kept: the server’s AI key was rejected',
        paragraphs: [
          `${String(m.details.provider ?? 'The provider')} rejected this server’s AI key, so the AI work it pays for is waiting.`,
          'Replace the key in the admin AI settings. Waiting work carries on once a new key is saved.',
        ],
        action: { label: 'Open AI settings', url: page(ctx, '/admin/ai') },
        footnote,
      };
    }
    if (m.alert === 'failed_jobs_rising') {
      return {
        subject: 'Kept: background jobs are failing',
        paragraphs: [
          `${num(m.details.failedLastHour)} background jobs failed in the last hour.`,
          'The failed jobs list shows what failed and why; from there you can retry or discard them.',
        ],
        action: { label: 'Open failed jobs', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'backup_failed') {
      return {
        subject: 'Kept: the nightly backup failed',
        paragraphs: [
          `The nightly backup didn’t finish: ${String(m.details.error ?? '')}`,
          m.details.lastOk
            ? `The last good backup finished on ${day(m.details.lastOk)}. Until one succeeds again, nothing written since then is in a backup.`
            : 'No backup has succeeded yet, so nothing in this Kept is backed up.',
        ],
        action: { label: 'Open the status page', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'backup_stale') {
      return {
        subject: 'Kept: no backup for more than 36 hours',
        paragraphs: [
          m.details.lastOkAt
            ? `The last good backup finished on ${day(m.details.lastOkAt)}. Kept backs up every night, so the nightly backup has stopped working.`
            : 'Backups are set up, but none has finished yet.',
          'The backups page lists each run and why it failed. If Kept’s background worker isn’t running, start it again.',
        ],
        action: { label: 'Open backups', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'disk_space_low') {
      const d = diskFacts(m.details);
      return {
        subject: d.backup
          ? 'Kept: the backup disk is nearly full'
          : 'Kept: the data disk is nearly full',
        paragraphs: [
          `It is ${d.percent}% full, with ${d.gb} GB left.`,
          d.backup
            ? 'When it fills, the nightly backup fails. Free some space, give it a bigger disk, or keep fewer backups in the backup settings.'
            : 'When it fills, Kept can’t save new photos or documents, and its database may stop. Free some space or give it a bigger disk.',
        ],
        action: { label: 'Open the status page', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'bucket_versioning_off') {
      return {
        subject: 'Kept: versioning is off on the file bucket',
        paragraphs: [
          'Kept keeps its files in an S3 bucket, and the nightly backup leaves them there. Versioning is off on that bucket, so a file deleted or overwritten by mistake, or by someone with its key, can’t be brought back.',
          'Turn versioning on for the bucket at your storage provider. This stops once the next backup finds it on.',
        ],
        action: { label: 'Open the status page', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'restore_drill_due') {
      return {
        subject: 'Kept: time for a restore drill',
        paragraphs: [
          m.details.lastDrillAt
            ? `The last restore drill was on ${day(m.details.lastDrillAt)}, more than 30 days ago.`
            : 'No restore drill has been done yet.',
          'A drill restores the latest backup into a scratch database and checks every table, so you know the backups can really be restored. Run `kept admin backup drill` as the restore runbook shows.',
        ],
        action: { label: 'Open backups', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'backup_suspicious_size') {
      return {
        subject: 'Kept: the latest backup looks too small',
        paragraphs: [
          'The latest backup came out much smaller than the last good one. Kept kept it, but removed no older backups, so the good ones stay.',
          'If a lot was deleted on purpose, nothing is wrong and the next backups clear this. If not, find out what changed before restoring anything.',
        ],
        action: { label: 'Open backups', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'webhook_failing') {
      return {
        subject: 'Kept: a location’s webhook keeps failing',
        paragraphs: [
          `A webhook set up in one of this Kept’s locations has failed every delivery since ${day(m.details.since)}, so Kept has marked it failing.`,
          'Kept keeps trying it with each new event. The location’s owners and admins see it, and can fix or remove it, under Location settings → Webhooks.',
        ],
        action: { label: 'Open the status page', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'reminders_not_scanned') {
      return {
        subject: 'Kept: reminders have stopped going out',
        paragraphs: [
          m.details.lastOkAt
            ? `Kept last checked for due reminders on ${day(m.details.lastOkAt)}, more than 2 hours ago. Until it checks again, nobody gets new reminders.`
            : 'Kept hasn’t finished a single check for due reminders yet, so nobody gets reminders.',
          'The check runs every 15 minutes in Kept’s background worker. The failed jobs list shows why it stopped; if the worker isn’t running, start it again.',
        ],
        action: { label: 'Open failed jobs', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'llm_default_partition') {
      return {
        subject: 'Kept: AI call records need attention',
        paragraphs: [
          `${num(m.details.rows)} AI call records (${day(m.details.oldest)} to ${day(m.details.newest)}) were stored outside their monthly partition.`,
          'Kept can’t create that month’s partition until they are moved into it, so the nightly AI maintenance job will keep failing. Moving them is a database task for the person who runs this Kept.',
        ],
        action: { label: 'Open the status page', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    return {
      subject: 'Kept: audit events need attention',
      paragraphs: [
        `${num(m.details.rows)} audit events (${day(m.details.oldest)} to ${day(m.details.newest)}) were stored outside their monthly partition.`,
        'Kept can’t create that month’s partition until they are moved into it, so the nightly maintenance job will keep failing. Moving them is a database task for the person who runs this Kept.',
      ],
      action: { label: 'Open the status page', url: page(ctx, '/admin/status') },
      footnote,
    };
  },
};

// ---------------------------------------------------------------------------------------------
// Arabic
// ---------------------------------------------------------------------------------------------

const AR_ROLE = { admin: 'مشرف', member: 'عضو', viewer: 'مشاهد' } as const;

const AR_NOT_YOU = 'إذا لم تكن أنت، فأعد تعيين كلمة المرور فورًا من صفحة تسجيل الدخول.';

const AR_SECURITY: Record<SecurityEvent, (ctx: MessageContext) => Message> = {
  'passkey-added': () => ({
    subject: 'أُضيف مفتاح مرور إلى حسابك على Kept',
    paragraphs: ['أُضيف مفتاح مرور جديد إلى حسابك على Kept، وسُجِّل الخروج من جميع الأجهزة الأخرى.'],
    footnote: 'إذا لم تكن أنت، فأعد تعيين كلمة المرور فورًا واحذف مفتاح المرور من إعدادات حسابك.',
  }),
  'two-factor-disabled': () => ({
    subject: 'أُوقف التحقق بخطوتين',
    paragraphs: ['أُوقف التحقق بخطوتين لحسابك على Kept، وسُجِّل الخروج من جميع الأجهزة الأخرى.'],
    footnote: 'إذا لم تكن أنت، فأعد تعيين كلمة المرور فورًا وأعد تفعيل التحقق بخطوتين.',
  }),
  'password-changed': () => ({
    subject: 'تغيّرت كلمة مرورك على Kept',
    paragraphs: ['تغيّرت كلمة المرور لحسابك على Kept، وسُجِّل الخروج من جميع الأجهزة الأخرى.'],
    footnote: AR_NOT_YOU,
  }),
  'unverified-account-reset': () => ({
    subject: 'تأكّد عنوان بريدك الإلكتروني',
    paragraphs: [
      'أُعيد تعيين كلمة مرورك على Kept من خلال هذا البريد، وهذا يؤكد أن عنوان البريد الإلكتروني للحساب يخصّك.',
      'لم يكن العنوان مؤكَّدًا من قبل، لذا حُذفت احتياطًا جميع مفاتيح المرور وإعدادات التحقق بخطوتين والأجهزة المسجَّلة التي أُضيفت قبل الآن، تحسّبًا لأن يكون شخص آخر قد أنشأ الحساب.',
    ],
    footnote:
      'سجّل الدخول بكلمة المرور الجديدة، وأعد إعداد التحقق بخطوتين إن كنت تستخدمه. وإذا لم تُعِد تعيين كلمة المرور بنفسك، فأعد تعيينها الآن.',
  }),
  'unverified-account-link': () => ({
    subject: 'تأكّد عنوان بريدك الإلكتروني',
    paragraphs: [
      'سجّلت الدخول إلى Kept برابط أُرسل إلى هذا البريد، وهذا يؤكد أن عنوان البريد الإلكتروني للحساب يخصّك.',
      'لم يكن العنوان مؤكَّدًا من قبل، لذا حُذفت احتياطًا كلمة مرور الحساب ومفاتيح المرور وإعدادات التحقق بخطوتين وجميع الأجهزة المسجَّلة الأخرى، تحسّبًا لأن يكون شخص آخر قد أنشأ الحساب.',
    ],
    footnote: 'اختر كلمة مرور جديدة من إعدادات حسابك، وأعد إعداد التحقق بخطوتين إن كنت تستخدمه.',
  }),
};

const AR_ADMIN: Record<AdminAction, (locationName: string) => Message> = {
  disabled: () => ({
    subject: 'عُطِّل حسابك على Kept',
    paragraphs: ['عطّل أحد مسؤولي Kept حسابك، ولن تتمكن من تسجيل الدخول حتى يُعاد تفعيله.'],
  }),
  enabled: () => ({
    subject: 'أُعيد تفعيل حسابك على Kept',
    paragraphs: ['أعاد أحد المسؤولين تفعيل حسابك، ويمكنك تسجيل الدخول كالمعتاد.'],
  }),
  'two-factor-reset': () => ({
    subject: 'أُعيد ضبط التحقق بخطوتين في حسابك',
    paragraphs: [
      'أزال أحد المسؤولين التحقق بخطوتين من حسابك وسجّل خروجه من جميع الأجهزة، وعادةً ما يحدث ذلك عند فقدان تطبيق المصادقة.',
      'أعد إعداد التحقق بخطوتين من إعدادات حسابك.',
    ],
  }),
  'signed-out-everywhere': () => ({
    subject: 'سُجِّل خروجك من Kept على جميع الأجهزة',
    paragraphs: ['سجّل أحد المسؤولين خروج حسابك من جميع الأجهزة. سجّل الدخول مجددًا للمتابعة.'],
  }),
  'instance-admin-granted': () => ({
    subject: 'أصبحت من مسؤولي Kept',
    paragraphs: ['أصبحت من مسؤولي هذه النسخة من Kept، ويمكنك الآن إدارة مستخدميها وإعداداتها.'],
  }),
  'instance-admin-revoked': () => ({
    subject: 'لم تعد من مسؤولي Kept',
    paragraphs: ['أُزيلت صلاحيات المسؤول من حسابك. لم يتغيّر شيء في أماكنك ولا في ما تحتويه.'],
  }),
  'password-reset-issued': () => ({
    subject: 'صدر رمز لإعادة تعيين كلمة مرورك',
    paragraphs: [
      'أصدر الشخص الذي يدير Kept رمزًا يُستخدم مرة واحدة لإعادة تعيين كلمة مرور حسابك، وسجّل خروجه من جميع الأجهزة.',
      'سيعطيك هذا الرمز لتختار به كلمة مرور جديدة.',
    ],
  }),
  'location-ownership-received': (name) => ({
    subject: `أصبحت مالك «${name}»`,
    paragraphs: [`جعلك الشخص الذي يدير Kept مالكًا لـ«${name}».`],
  }),
  'location-ownership-moved': (name) => ({
    subject: `انتقلت ملكية «${name}»`,
    paragraphs: [`نقل الشخص الذي يدير Kept ملكية «${name}» إلى مالك جديد، وتبقى فيه بصفة مشرف.`],
  }),
};

// سقوف الذكاء الاصطناعي (D206).
function arCapOf(c: AiCapFacts): string {
  switch (c.scope) {
    case 'location':
      return `سقف الذكاء الاصطناعي لـ«${c.target}»`;
    case 'member':
      return c.target ? `سقف الذكاء الاصطناعي لـ${c.target}` : 'سقف الذكاء الاصطناعي لأحد الأشخاص';
    case 'account':
      return 'سقف الذكاء الاصطناعي لحسابك';
    case 'user':
      return 'سقفك الشخصي للذكاء الاصطناعي';
    case 'instance':
      return 'سقف الذكاء الاصطناعي لهذا الخادم';
    case 'instance_account':
      return c.target
        ? `حصة ${c.target} من مفتاح الذكاء الاصطناعي لهذا الخادم`
        : 'الحصة من مفتاح الذكاء الاصطناعي لهذا الخادم';
  }
}
const arUsed = (c: AiCapFacts) =>
  c.unit === 'money'
    ? `${c.used} ${c.currency} من أصل ${c.limit} ${c.currency}`
    : `${tokens('ar', c.used)} من أصل ${tokens('ar', c.limit)} رمز`;

function arCap(level: 80 | 100, c: AiCapFacts, ctx: MessageContext, footnote: string): Message {
  const cap = arCapOf(c);
  if (level === 80) {
    return {
      subject: `Kept: استُخدم 80% من ${cap} هذا الشهر`,
      paragraphs: [
        `بلغ استخدام ${cap} ${arUsed(c)} حتى الآن هذا الشهر.`,
        'عند بلوغ السقف يتوقف الذكاء الاصطناعي حتى أول الشهر القادم. تُحفظ الالتقاطات كالمعتاد، وتُقرأ صورها عند استئنافه.',
      ],
      action: { label: 'فتح إعدادات الذكاء الاصطناعي', url: aiPage(ctx, c.scope) },
      footnote,
    };
  }
  return {
    subject: `Kept: الذكاء الاصطناعي متوقف حتى ${day(c.pausedUntil)}`,
    paragraphs: [
      `بلغ ${cap} حدّه: ${arUsed(c)} هذا الشهر.`,
      `توقف الذكاء الاصطناعي حتى ${day(c.pausedUntil)}. تُحفظ الالتقاطات كالمعتاد، وتُقرأ صورها عند استئنافه. لاستئنافه قبل ذلك، ارفع السقف أو أزله.`,
    ],
    action: { label: 'الاستئناف الآن', url: aiPage(ctx, c.scope) },
    footnote,
  };
}

const AR: CoreTable = {
  'magic-link': (m) => ({
    subject: 'رابط تسجيل الدخول إلى Kept',
    paragraphs: [
      'استخدم هذا الرابط لتسجيل الدخول إلى Kept. يعمل مرة واحدة خلال الدقائق الخمس عشرة القادمة.',
    ],
    action: { label: 'تسجيل الدخول', url: m.url },
    footnote: 'إذا لم تطلب تسجيل الدخول، فتجاهل هذه الرسالة. لا يستطيع أحد الدخول بدون هذا الرابط.',
  }),
  'password-reset': (m) => ({
    subject: 'إعادة تعيين كلمة مرورك على Kept',
    paragraphs: [
      'طلب أحدهم إعادة تعيين كلمة المرور لهذا الحساب على Kept. استخدم هذا الرابط لاختيار كلمة مرور جديدة، وهو يعمل مرة واحدة خلال الساعة القادمة.',
    ],
    action: { label: 'اختيار كلمة مرور جديدة', url: m.url },
    footnote: 'إذا لم تكن أنت، فتجاهل هذه الرسالة: ستبقى كلمة مرورك كما هي.',
  }),
  'email-change-confirm': (m) => ({
    subject: 'أكّد عنوان بريدك الإلكتروني الجديد',
    paragraphs: [
      `طلب شخص مسجَّل الدخول إلى حسابك على Kept نقل الحساب إلى العنوان ${m.newEmail}. إذا كنت أنت، فأكّد ذلك بهذا الرابط خلال الساعة القادمة.`,
    ],
    action: { label: 'تأكيد التغيير', url: m.url },
    footnote:
      'إذا لم تكن أنت، فلا تستخدم الرابط: سيبقى حسابك على هذا العنوان. وقد ترغب في تغيير كلمة مرورك.',
  }),
  'email-change-verify': (m) => ({
    subject: 'تحقّق من عنوان بريدك الإلكتروني على Kept',
    paragraphs: ['استخدم هذا الرابط لإتمام نقل حسابك على Kept إلى هذا العنوان.'],
    action: { label: 'تأكيد هذا العنوان', url: m.url },
    footnote: 'إذا لم تكن تتوقع هذه الرسالة، فتجاهلها: لن يتغيّر شيء ما لم يُستخدم الرابط.',
  }),
  'email-changed': (m) => ({
    subject: 'تغيّر عنوان بريدك الإلكتروني على Kept',
    paragraphs: [
      `أصبح حسابك على Kept يستخدم العنوان ${m.newEmail}، ولن تصل رسائله إلى هذا العنوان بعد الآن.`,
    ],
    footnote: 'إذا لم تُجرِ هذا التغيير، فتواصل مع الشخص الذي يدير Kept لديك.',
  }),
  invite: (m) => ({
    subject: m.inviterName
      ? `${m.inviterName} يدعوك إلى «${m.locationName}» على Kept`
      : `دعوة للانضمام إلى «${m.locationName}» على Kept`,
    paragraphs: [
      m.inviterName
        ? `دعاك ${m.inviterName} للانضمام إلى «${m.locationName}» بصفة ${AR_ROLE[m.role]}.`
        : `أنت مدعوّ للانضمام إلى «${m.locationName}» بصفة ${AR_ROLE[m.role]}.`,
      'يساعدك Kept على تتبّع أغراضك وأماكنها وما يستحقّ لها من مواعيد.',
    ],
    action: { label: 'قبول الدعوة', url: m.url },
    footnote: 'إذا لم تكن تتوقع هذه الدعوة، فتجاهلها: لن يحدث شيء ما لم تقبلها.',
  }),
  'sign-up-existing': (_m, ctx) => ({
    subject: 'محاولة إنشاء حساب بعنوان بريدك الإلكتروني',
    paragraphs: [
      'حاول أحدهم إنشاء حساب على Kept بهذا العنوان، وله حساب بالفعل. لم يُنشأ أي حساب جديد.',
      'إذا كنت أنت، فسجّل الدخول بدلًا من ذلك. وإن نسيت كلمة المرور، فيمكنك إعادة تعيينها من صفحة تسجيل الدخول.',
    ],
    action: { label: 'تسجيل الدخول', url: page(ctx, '/signin') },
    footnote: 'إذا لم تكن أنت، فلا داعي لفعل أي شيء.',
  }),
  'security-notice': (m, ctx) => AR_SECURITY[m.event](ctx),
  'admin-action': (m) => ({
    ...AR_ADMIN[m.action](m.locationName ?? ''),
    footnote: 'هذا إشعار تلقائي بشأن حسابك.',
  }),
  'owner-new-member': (m) => ({
    subject: `انضمّ ${m.memberName} إلى «${m.locationName}»`,
    paragraphs: [
      m.managed
        ? `أُضيف ${m.memberName} إلى «${m.locationName}» كحساب مُدار بصفة ${AR_ROLE[m.role]}.`
        : `أصبح بإمكان ${m.memberName} الوصول إلى «${m.locationName}» بصفة ${AR_ROLE[m.role]}.`,
    ],
    footnote:
      'يصلك هذا الإشعار بصفتك المالك عند انضمام أي عضو جديد. يمكنك تعديل الأعضاء أو إزالتهم من إعدادات المكان.',
  }),
  'ai-cap': (m, ctx) =>
    arCap(
      m.level,
      m.cap,
      ctx,
      'تصلك هذه الرسالة لأنك وضعت هذا السقف أو لأنه يشمل عملك. تُرسل مرة واحدة في الشهر.',
    ),
  'admin-alert': (m, ctx) => {
    const footnote =
      'يصلك هذا بصفتك من مسؤولي Kept، ويُرسَل مرة واحدة في اليوم على الأكثر ما دامت المشكلة قائمة.';
    if (m.alert === 'ai_instance_cap_warning' || m.alert === 'ai_instance_cap_reached') {
      const c = capFactsOf(m.details);
      if (c) return arCap(m.alert === 'ai_instance_cap_warning' ? 80 : 100, c, ctx, footnote);
    }
    if (m.alert === 'ai_instance_key_rejected') {
      return {
        subject: 'Kept: رُفض مفتاح الذكاء الاصطناعي لهذا الخادم',
        paragraphs: [
          `رفض ${String(m.details.provider ?? 'المزوّد')} مفتاح الذكاء الاصطناعي لهذا الخادم، لذا ينتظر عمل الذكاء الاصطناعي الذي يدفع المفتاح تكلفته.`,
          'استبدل المفتاح من إعدادات الذكاء الاصطناعي في لوحة الإدارة، وسيُستأنف العمل المنتظر بعد حفظ مفتاح جديد.',
        ],
        action: { label: 'فتح إعدادات الذكاء الاصطناعي', url: page(ctx, '/admin/ai') },
        footnote,
      };
    }
    if (m.alert === 'failed_jobs_rising') {
      return {
        subject: 'Kept: تتعثّر مهام في الخلفية',
        paragraphs: [
          `فشلت ${num(m.details.failedLastHour)} من المهام في الخلفية خلال الساعة الماضية.`,
          'تعرض قائمة المهام الفاشلة ما فشل وسببه، ويمكنك منها إعادة تشغيل المهام أو حذفها.',
        ],
        action: { label: 'فتح المهام الفاشلة', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'backup_failed') {
      return {
        subject: 'Kept: فشل النسخ الاحتياطي الليلي',
        paragraphs: [
          `لم يكتمل النسخ الاحتياطي الليلي: ${String(m.details.error ?? '')}`,
          m.details.lastOk
            ? `اكتملت آخر نسخة احتياطية ناجحة في ${day(m.details.lastOk)}. وإلى أن تنجح نسخة جديدة، لا يوجد في أي نسخة احتياطية شيء مما كُتب بعد ذلك.`
            : 'لم تنجح أي نسخة احتياطية حتى الآن، لذا لا شيء في Kept محفوظ في نسخة احتياطية.',
        ],
        action: { label: 'فتح صفحة الحالة', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'backup_stale') {
      return {
        subject: 'Kept: لا نسخة احتياطية منذ أكثر من 36 ساعة',
        paragraphs: [
          m.details.lastOkAt
            ? `اكتملت آخر نسخة احتياطية ناجحة في ${day(m.details.lastOkAt)}. يأخذ Kept نسخة احتياطية كل ليلة، لذا فالنسخ الاحتياطي الليلي متوقّف.`
            : 'النسخ الاحتياطي مُعدّ، لكن لم تكتمل أي نسخة بعد.',
          'تعرض صفحة النسخ الاحتياطية كل عملية وسبب فشلها. وإذا لم يكن عامل الخلفية لدى Kept يعمل فأعد تشغيله.',
        ],
        action: { label: 'فتح النسخ الاحتياطية', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'disk_space_low') {
      const d = diskFacts(m.details);
      return {
        subject: d.backup
          ? 'Kept: قرص النسخ الاحتياطية يكاد يمتلئ'
          : 'Kept: قرص البيانات يكاد يمتلئ',
        paragraphs: [
          `امتلأ بنسبة ${d.percent}%، وبقي فيه ${d.gb} غيغابايت.`,
          d.backup
            ? 'عندما يمتلئ يفشل النسخ الاحتياطي الليلي. أفرغ بعض المساحة، أو استخدم قرصًا أكبر، أو احتفظ بعدد أقل من النسخ في إعدادات النسخ الاحتياطي.'
            : 'عندما يمتلئ لن يستطيع Kept حفظ صور أو مستندات جديدة، وقد تتوقّف قاعدة بياناته. أفرغ بعض المساحة أو استخدم قرصًا أكبر.',
        ],
        action: { label: 'فتح صفحة الحالة', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'bucket_versioning_off') {
      return {
        subject: 'Kept: تعدّد الإصدارات متوقّف في حاوية الملفات',
        paragraphs: [
          'يحفظ Kept ملفاته في حاوية S3، ولا ينسخها النسخ الاحتياطي الليلي منها. وتعدّد الإصدارات متوقّف في تلك الحاوية، لذا لا يمكن استعادة ملف حُذف أو استُبدل خطأً، أو على يد من يملك مفتاحها.',
          'فعّل تعدّد الإصدارات للحاوية لدى مزوّد التخزين. تتوقّف هذه الرسالة حين تجده النسخة الاحتياطية التالية مفعّلًا.',
        ],
        action: { label: 'فتح صفحة الحالة', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'restore_drill_due') {
      return {
        subject: 'Kept: حان وقت تجربة الاستعادة',
        paragraphs: [
          m.details.lastDrillAt
            ? `كانت آخر تجربة استعادة في ${day(m.details.lastDrillAt)}، أي قبل أكثر من 30 يومًا.`
            : 'لم تُجرَ أي تجربة استعادة بعد.',
          'تستعيد التجربة آخر نسخة احتياطية إلى قاعدة بيانات مؤقتة وتفحص كل جدول، لتعرف أن النسخ الاحتياطية قابلة للاستعادة فعلًا. شغّل `kept admin backup drill` كما يبيّن دليل الاستعادة.',
        ],
        action: { label: 'فتح النسخ الاحتياطية', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'backup_suspicious_size') {
      return {
        subject: 'Kept: آخر نسخة احتياطية تبدو أصغر من المعتاد',
        paragraphs: [
          'جاءت آخر نسخة احتياطية أصغر بكثير من آخر نسخة ناجحة. احتفظ بها Kept، لكنه لم يحذف أي نسخة أقدم، فتبقى النسخ الجيدة.',
          'إن كان كثير من البيانات قد حُذف عمدًا فلا مشكلة، وستزيل النسخ التالية هذا التنبيه. وإلا فتحقّق مما تغيّر قبل أن تستعيد أي شيء.',
        ],
        action: { label: 'فتح النسخ الاحتياطية', url: page(ctx, '/admin/backups') },
        footnote,
      };
    }
    if (m.alert === 'webhook_failing') {
      return {
        subject: 'Kept: خطاف ويب في أحد المواقع يفشل باستمرار',
        paragraphs: [
          `فشلت كل عمليات الإرسال لخطاف ويب أُعدّ في أحد مواقع Kept منذ ${day(m.details.since)}، لذا وسمه Kept بأنه يفشل.`,
          'يواصل Kept المحاولة مع كل حدث جديد. يراه مالكو الموقع ومشرفوه في إعدادات الموقع ← خطافات الويب، ويمكنهم إصلاحه أو إزالته.',
        ],
        action: { label: 'فتح صفحة الحالة', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    if (m.alert === 'reminders_not_scanned') {
      return {
        subject: 'Kept: توقّف إرسال التذكيرات',
        paragraphs: [
          m.details.lastOkAt
            ? `آخر مرة تحقّق فيها Kept من التذكيرات المستحقة كانت في ${day(m.details.lastOkAt)}، أي قبل أكثر من ساعتين. ولن يتلقّى أحد تذكيرات جديدة حتى يتحقّق منها مجددًا.`
            : 'لم يُكمل Kept أي تحقّق من التذكيرات المستحقة حتى الآن، لذا لا يتلقّى أحد أي تذكيرات.',
          'يجري هذا التحقّق كل 15 دقيقة في عامل الخلفية لدى Kept. تعرض قائمة المهام الفاشلة سبب توقّفه، وإذا لم يكن عامل الخلفية يعمل فأعد تشغيله.',
        ],
        action: { label: 'فتح المهام الفاشلة', url: page(ctx, '/admin/jobs') },
        footnote,
      };
    }
    if (m.alert === 'llm_default_partition') {
      return {
        subject: 'Kept: سجلّات استدعاءات الذكاء الاصطناعي تحتاج إلى متابعة',
        paragraphs: [
          `حُفظ ${num(m.details.rows)} من سجلّات استدعاءات الذكاء الاصطناعي (من ${day(m.details.oldest)} إلى ${day(m.details.newest)}) خارج قسمها الشهري.`,
          'لا يستطيع Kept إنشاء قسم ذلك الشهر حتى تُنقل إليه، لذا ستستمر مهمة صيانة الذكاء الاصطناعي الليلية في الفشل. نقلها مهمة على مستوى قاعدة البيانات يتولاها الشخص الذي يدير Kept.',
        ],
        action: { label: 'فتح صفحة الحالة', url: page(ctx, '/admin/status') },
        footnote,
      };
    }
    return {
      subject: 'Kept: سجلّ التدقيق يحتاج إلى متابعة',
      paragraphs: [
        `حُفظ ${num(m.details.rows)} من أحداث سجلّ التدقيق (من ${day(m.details.oldest)} إلى ${day(m.details.newest)}) خارج قسمها الشهري.`,
        'لا يستطيع Kept إنشاء قسم ذلك الشهر حتى تُنقل إليه، لذا ستستمر مهمة الصيانة الليلية في الفشل. نقلها مهمة على مستوى قاعدة البيانات يتولاها الشخص الذي يدير Kept.',
      ],
      action: { label: 'فتح صفحة الحالة', url: page(ctx, '/admin/status') },
      footnote,
    };
  },
};

export const MESSAGES: Record<MailLocale, Table> = {
  en: { ...EN, ...NOTIFY_MESSAGES.en, ...TRANSPARENCY_MESSAGES.en },
  ar: { ...AR, ...NOTIFY_MESSAGES.ar, ...TRANSPARENCY_MESSAGES.ar },
  fr: { ...FR, ...NOTIFY_MESSAGES.fr, ...TRANSPARENCY_MESSAGES.fr },
  de: { ...DE, ...NOTIFY_MESSAGES.de, ...TRANSPARENCY_MESSAGES.de },
  it: { ...IT, ...NOTIFY_MESSAGES.it, ...TRANSPARENCY_MESSAGES.it },
};

export const CHROME: Record<MailLocale, Chrome> = {
  en: {
    dir: 'ltr',
    linkFallback: 'If the button doesn’t work, copy this address into your browser:',
    sentBy: (host) => `Sent by Kept at ${host}.`,
  },
  ar: {
    dir: 'rtl',
    linkFallback: 'إذا لم يعمل الزر، فانسخ هذا الرابط والصقه في المتصفح:',
    sentBy: (host) => `أُرسلت من Kept على ${host}.`,
  },
  fr: FR_CHROME,
  de: DE_CHROME,
  it: IT_CHROME,
};

/** What `mail` says in `locale`. */
export function messageFor(mail: MailBody, locale: MailLocale, ctx: MessageContext): Message {
  const render = MESSAGES[locale][mail.kind] as (m: MailBody, c: MessageContext) => Message;
  return render(mail, ctx);
}
