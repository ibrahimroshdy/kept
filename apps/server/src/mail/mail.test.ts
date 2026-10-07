import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, testDb } from '../../test/db.js';
import { MAILPIT_SMTP_URL, mailpitWait } from '../../test/mailpit.js';
import { ownerTx, seedTenant, seedUser, userEmail } from '../../test/tenancy.js';
import type { SecurityEvent } from '../auth/security.js';
import { notifyOwnerNewMember } from '../locations/membership-jobs.js';
import type { ReminderFacts } from '../notify/words.js';
import type { AdminAction, Mail, MailBody } from './mailer.js';
import { MAIL_LOCALES, type MailLocale, mailLocale, messageFor } from './messages.js';
import { renderMail } from './render.js';
import {
  createMailer,
  defaultFrom,
  profileLocaleLookup,
  type SmtpMailer,
  smtpMailer,
} from './transport.js';

// The mail transport (D81, §7.11): every kind in both languages, rendered safely, and delivered
// over SMTP to Mailpit in the recipient's language.

const PUBLIC_URL = 'http://kept.test';
const ctx = { publicUrl: PUBLIC_URL };

const SECURITY: SecurityEvent[] = [
  'passkey-added',
  'two-factor-disabled',
  'password-changed',
  'unverified-account-reset',
  'unverified-account-link',
];
const ADMIN: AdminAction[] = [
  'disabled',
  'enabled',
  'two-factor-reset',
  'signed-out-everywhere',
  'instance-admin-granted',
  'instance-admin-revoked',
  'password-reset-issued',
  'location-ownership-received',
  'location-ownership-moved',
];

/** A reminder's facts (step 4, notify/words.ts), with Latin names so only Arabic mail has Arabic. */
const REMINDER: ReminderFacts = {
  sourceType: 'schedule',
  kind: 'overdue',
  title: 'Boiler service',
  subject: { type: 'place', name: 'Kitchen', path: 'Ground floor' },
  locationName: 'Home',
  dueOn: '2031-01-15',
  dueValue: null,
  unit: null,
  link: '/p/0192f0c3-7c55-7000-8000-000000000001',
};

/** One of every mail there is. */
const EVERY_MAIL: MailBody[] = [
  { kind: 'magic-link', to: 'a@x.test', url: `${PUBLIC_URL}/auth/confirm#token=t` },
  { kind: 'password-reset', to: 'a@x.test', url: `${PUBLIC_URL}/auth/reset#token=t` },
  { kind: 'email-change-confirm', to: 'a@x.test', url: `${PUBLIC_URL}/e#t`, newEmail: 'b@x.test' },
  { kind: 'email-change-verify', to: 'b@x.test', url: `${PUBLIC_URL}/e#t` },
  { kind: 'email-changed', to: 'a@x.test', newEmail: 'b@x.test' },
  ...(['admin', 'member', 'viewer'] as const).flatMap((role) =>
    ['Alfred', ''].map(
      (inviterName): MailBody => ({
        kind: 'invite',
        to: 'c@x.test',
        url: `${PUBLIC_URL}/invite#token=t`,
        locationName: 'Home',
        inviterName,
        role,
      }),
    ),
  ),
  { kind: 'sign-up-existing', to: 'a@x.test' },
  ...SECURITY.map((event): MailBody => ({ kind: 'security-notice', to: 'a@x.test', event })),
  ...ADMIN.map(
    (action): MailBody => ({ kind: 'admin-action', to: 'a@x.test', action, locationName: 'Home' }),
  ),
  ...[true, false].map(
    (managed): MailBody => ({
      kind: 'owner-new-member',
      to: 'o@x.test',
      locationName: 'Home',
      memberName: 'Bruce',
      role: 'viewer',
      managed,
    }),
  ),
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'failed_jobs_rising',
    details: { failedLastHour: 7 },
  },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'audit_default_partition',
    details: { rows: 3, oldest: '2031-01-02T00:00:00Z', newest: '2031-01-05T00:00:00Z' },
  },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'llm_default_partition',
    details: { rows: 2, oldest: '2031-01-02T00:00:00Z', newest: '2031-01-05T00:00:00Z' },
  },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'backup_failed',
    details: { error: 'pg_dump is version 9', lastOk: '2031-01-01T02:30:00Z' },
  },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'backup_failed',
    details: { error: 'the target is not writable', lastOk: null },
  },
  // Step 4 (T14): the reminder scan hasn't finished for 2 hours, or ever.
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'reminders_not_scanned',
    details: { lastOkAt: '2031-01-02T09:00:00.000Z', lastRunAt: '2031-01-02T11:45:00.000Z' },
  },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'reminders_not_scanned',
    details: { lastOkAt: null, lastRunAt: '2031-01-02T11:45:00.000Z' },
  },
  // Step 6 (T15): a location's webhook started failing.
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'webhook_failing',
    details: { webhookId: 'w', locationId: 'l', since: '2031-01-02T09:00:00.000Z' },
  },
  // Step 8 (T10): the operations watch's alerts and the backup's size check.
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'backup_stale',
    details: { lastOkAt: '2031-01-02T02:40:00.000Z', hours: 40 },
  },
  { kind: 'admin-alert', to: 'admin@x.test', alert: 'backup_stale', details: { lastOkAt: null } },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'disk_space_low',
    details: { volume: 'data', usedRatio: 0.912, freeBytes: 1_500_000_000 },
  },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'disk_space_low',
    details: { volume: 'backup', usedRatio: 0.86, freeBytes: 20_000_000_000 },
  },
  { kind: 'admin-alert', to: 'admin@x.test', alert: 'bucket_versioning_off', details: {} },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'restore_drill_due',
    details: { lastDrillAt: '2031-01-02T09:00:00.000Z' },
  },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'restore_drill_due',
    details: { lastDrillAt: null },
  },
  { kind: 'admin-alert', to: 'admin@x.test', alert: 'backup_suspicious_size', details: {} },
  // D206: the instance caps and a rejected instance key.
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'ai_instance_cap_warning',
    details: {
      scope: 'instance',
      target: '',
      unit: 'tokens',
      used: '2400000',
      limit: '3000000',
      currency: null,
      pausedUntil: null,
    },
  },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'ai_instance_cap_reached',
    details: {
      scope: 'instance_account',
      target: 'Alfred',
      unit: 'money',
      used: '5.01',
      limit: '5',
      currency: 'USD',
      pausedUntil: '2031-02-01T00:00:00.000Z',
    },
  },
  {
    kind: 'admin-alert',
    to: 'admin@x.test',
    alert: 'ai_instance_key_rejected',
    details: { provider: 'Groq' },
  },
  // D206: a location's money cap at 80%, a person's token cap at 100%.
  {
    kind: 'ai-cap',
    to: 'ibrahim@x.test',
    level: 80,
    cap: {
      scope: 'location',
      target: 'Home',
      unit: 'money',
      used: '4.0039',
      limit: '5',
      currency: 'USD',
      pausedUntil: null,
    },
  },
  {
    kind: 'ai-cap',
    to: 'louis@x.test',
    level: 100,
    cap: {
      scope: 'member',
      target: 'Louis',
      unit: 'tokens',
      used: '1000400',
      limit: '1000000',
      currency: null,
      pausedUntil: '2031-02-01T00:00:00.000Z',
    },
  },
  // Step 4 (T15): reminders, the digest, an ended membership, a channel's test and failure.
  { kind: 'reminder', to: 'bruce@x.test', item: REMINDER },
  {
    kind: 'reminder-digest',
    to: 'bruce@x.test',
    day: '2031-01-16',
    items: [
      REMINDER,
      {
        ...REMINDER,
        sourceType: 'loan',
        kind: 'overdue',
        title: null,
        subject: { type: 'thing', name: 'Drill', path: 'Garage › Shelf' },
        link: '/t/0192f0c3-7c55-7000-8000-000000000002',
      },
    ],
  },
  {
    kind: 'membership-ended',
    to: 'ibrahim@x.test',
    locationName: 'Home',
    memberName: 'Louis',
    role: 'member',
    endedOn: '2031-01-15',
  },
  { kind: 'channel-test', to: 'bruce@x.test' },
  { kind: 'channel-failing', to: 'bruce@x.test', label: 'Home Assistant', host: 'ha.example.org' },
  {
    kind: 'ai-summary',
    to: 'ibrahim@x.test',
    month: '2026-09',
    calls: 312,
    tokens: '812000',
    cost: [{ currency: 'USD', amount: '1.1234' }],
    unknownCostCalls: 2,
  },
  // Step 6 (T16, D180): the configuration notices.
  { kind: 'oidc-changed', to: 'louis@x.test', name: 'Home SSO' },
  { kind: 'oidc-changed', to: 'louis@x.test', name: null },
  { kind: 'smtp-changed', to: 'louis@x.test', sender: 'kept@example.org' },
  { kind: 'ai-provider-changed', to: 'louis@x.test', provider: 'groq' },
];

const ARABIC = /[؀-ۿ]/;

describe('the message table', () => {
  it('maps profile locales to a mail language', () => {
    expect(mailLocale('ar-EG')).toBe('ar');
    expect(mailLocale('ar')).toBe('ar');
    expect(mailLocale('AR_sa')).toBe('ar');
    expect(mailLocale('en-GB')).toBe('en');
    // D204: French, German and Italian too, by their language subtag.
    expect(mailLocale('fr')).toBe('fr');
    expect(mailLocale('fr-CA')).toBe('fr');
    expect(mailLocale('de-AT')).toBe('de');
    expect(mailLocale('it_IT')).toBe('it');
    expect(mailLocale('es')).toBe('en');
    expect(mailLocale('')).toBe('en');
    expect(mailLocale(null)).toBe('en');
  });

  it('says every kind in every language, with nothing left blank', () => {
    const kinds = new Set(EVERY_MAIL.map((m) => m.kind));
    // Every kind the Mail type has is in the fixture (a new kind must be added here).
    expect([...kinds].sort()).toEqual(
      [
        'admin-action',
        'admin-alert',
        'ai-cap',
        'ai-summary',
        'channel-failing',
        'channel-test',
        'membership-ended',
        'oidc-changed',
        'smtp-changed',
        'ai-provider-changed',
        'reminder',
        'reminder-digest',
        'email-change-confirm',
        'email-change-verify',
        'email-changed',
        'invite',
        'magic-link',
        'owner-new-member',
        'password-reset',
        'security-notice',
        'sign-up-existing',
      ].sort(),
    );
    for (const locale of MAIL_LOCALES) {
      for (const mail of EVERY_MAIL) {
        const m = messageFor(mail, locale, ctx);
        const label = `${locale} ${mail.kind} ${JSON.stringify(mail)}`;
        expect(m.subject.trim(), label).not.toBe('');
        expect(m.paragraphs.length, label).toBeGreaterThan(0);
        for (const text of [m.subject, ...m.paragraphs, m.footnote ?? 'x']) {
          expect(text, label).not.toMatch(/undefined|NaN|\[object/);
        }
        if (locale === 'ar') expect(m.paragraphs.join(' '), label).toMatch(ARABIC);
        else expect(m.paragraphs.join(' '), label).not.toMatch(ARABIC);
        if ('url' in mail) expect(m.action?.url, label).toBe(mail.url);
      }
    }
  });

  it('writes French, German and Italian as their own text, never English left in (D204)', () => {
    for (const locale of ['fr', 'de', 'it'] as const) {
      for (const mail of EVERY_MAIL) {
        const en = messageFor(mail, 'en', ctx);
        const m = messageFor(mail, locale, ctx);
        const label = `${locale} ${mail.kind} ${JSON.stringify(mail)}`;
        expect(m.subject, label).not.toBe(en.subject);
        for (const [i, p] of m.paragraphs.entries()) expect(p, label).not.toBe(en.paragraphs[i]);
        if (en.action) expect(m.action?.label, label).not.toBe(en.action.label);
        // The product name is never translated.
        if (en.subject.includes('Kept')) expect(m.subject, label).toContain('Kept');
      }
    }
  });

  it('points alert and notice links at the web pages', () => {
    const [failing, audit] = EVERY_MAIL.filter((m) => m.kind === 'admin-alert');
    expect(messageFor(failing as MailBody, 'en', ctx).action?.url).toBe(`${PUBLIC_URL}/admin/jobs`);
    expect(messageFor(audit as MailBody, 'ar', ctx).action?.url).toBe(`${PUBLIC_URL}/admin/status`);
    expect(messageFor(audit as MailBody, 'en', ctx).paragraphs[0]).toContain(
      '2031-01-02 to 2031-01-05',
    );
    const scan = EVERY_MAIL.find(
      (m) => m.kind === 'admin-alert' && m.alert === 'reminders_not_scanned',
    ) as MailBody;
    expect(messageFor(scan, 'en', ctx).action?.url).toBe(`${PUBLIC_URL}/admin/jobs`);
    expect(messageFor(scan, 'en', ctx).paragraphs[0]).toContain('2031-01-02');
    expect(messageFor(scan, 'ar', ctx).subject).toBe('Kept: توقّف إرسال التذكيرات');
    expect(messageFor({ kind: 'sign-up-existing', to: 'a@x.test' }, 'en', ctx).action?.url).toBe(
      `${PUBLIC_URL}/signin`,
    );
  });
});

describe('the operations alerts (step 8)', () => {
  const STEP8 = [
    'backup_stale',
    'disk_space_low',
    'bucket_versioning_off',
    'restore_drill_due',
    'backup_suspicious_size',
    'webhook_failing',
  ];

  it('gives each its own text in every language, never the audit partition’s', () => {
    for (const locale of MAIL_LOCALES) {
      const audit = messageFor(
        EVERY_MAIL.find(
          (m) => m.kind === 'admin-alert' && m.alert === 'audit_default_partition',
        ) as MailBody,
        locale,
        ctx,
      ).subject;
      const subjects = new Set<string>();
      for (const kind of STEP8) {
        const mail = EVERY_MAIL.find((m) => m.kind === 'admin-alert' && m.alert === kind);
        expect(mail, kind).toBeDefined();
        const subject = messageFor(mail as MailBody, locale, ctx).subject;
        expect(subject, `${locale} ${kind}`).not.toBe(audit);
        subjects.add(subject);
      }
      expect(subjects.size, locale).toBe(STEP8.length);
    }
  });

  it('says how full a disk is and which one', () => {
    const [data, backup] = EVERY_MAIL.filter(
      (m) => m.kind === 'admin-alert' && m.alert === 'disk_space_low',
    ) as MailBody[];
    const en = messageFor(data as MailBody, 'en', ctx);
    expect(en.subject).toContain('data disk');
    expect(en.paragraphs[0]).toBe('It is 91% full, with 1.5 GB left.');
    expect(messageFor(backup as MailBody, 'en', ctx).subject).toContain('backup disk');
    expect(messageFor(data as MailBody, 'fr', ctx).paragraphs[0]).toContain('1,5 Go');
  });
});

describe('AI cap notices and alerts (D206)', () => {
  const alert = (kind: string) =>
    EVERY_MAIL.find((m) => m.kind === 'admin-alert' && m.alert === kind) as MailBody;
  const caps = EVERY_MAIL.filter((m) => m.kind === 'ai-cap');

  it('gives each AI alert its own text, never the audit partition’s', () => {
    const audit = messageFor(alert('audit_default_partition'), 'en', ctx).subject;
    for (const kind of [
      'ai_instance_cap_warning',
      'ai_instance_cap_reached',
      'ai_instance_key_rejected',
    ]) {
      for (const locale of MAIL_LOCALES) {
        const m = messageFor(alert(kind), locale, ctx);
        expect(m.subject, `${locale} ${kind}`).not.toBe(
          messageFor(alert('audit_default_partition'), locale, ctx).subject,
        );
        expect(m.action?.url).toBe(`${PUBLIC_URL}/admin/ai`);
      }
    }
    expect(messageFor(alert('ai_instance_key_rejected'), 'en', ctx).paragraphs[0]).toContain(
      'Groq rejected',
    );
    expect(audit).toContain('audit');
  });

  it('says how much of which cap, the pause date, and links to AI settings', () => {
    const [warning, reached] = caps as MailBody[];
    const w = messageFor(warning as MailBody, 'en', ctx);
    expect(w.subject).toBe('Kept: 80% of Home’s AI cap used this month');
    expect(w.paragraphs[0]).toContain('USD 4.0039 of USD 5');
    expect(w.action?.url).toBe(`${PUBLIC_URL}/settings/ai`);
    const r = messageFor(reached as MailBody, 'en', ctx);
    expect(r.subject).toBe('Kept: AI paused until 2031-02-01');
    expect(r.paragraphs[0]).toContain('1,000,400 of 1,000,000 tokens');
    expect(r.action?.label).toBe('Resume now');
    expect(messageFor(reached as MailBody, 'ar', ctx).paragraphs[0]).toContain('1,000,400');
  });
});

describe('renderMail', () => {
  const hostile: MailBody = {
    kind: 'invite',
    to: 'c@x.test',
    url: `${PUBLIC_URL}/invite#token=t`,
    locationName: '<img src=x onerror=alert(1)>',
    inviterName: '"Alfred" & co',
    role: 'member',
  };

  it('escapes every name a person chose in the HTML', () => {
    for (const locale of MAIL_LOCALES) {
      const { html, text } = renderMail(messageFor(hostile, locale, ctx), locale, PUBLIC_URL);
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
      expect(html).toContain('&quot;Alfred&quot; &amp; co');
      // The text part is plain: the name as typed.
      expect(text).toContain('<img src=x onerror=alert(1)>');
    }
  });

  it('sets the language and direction, and spells the link out in the text', () => {
    const cases: [MailLocale, string][] = [
      ['en', 'dir="ltr"'],
      ['ar', 'dir="rtl"'],
      ['fr', 'dir="ltr"'],
      ['de', 'dir="ltr"'],
      ['it', 'dir="ltr"'],
    ];
    for (const [locale, dir] of cases) {
      const mail = EVERY_MAIL[0] as MailBody & { url: string };
      const { html, text, subject } = renderMail(messageFor(mail, locale, ctx), locale, PUBLIC_URL);
      expect(html.startsWith('<!doctype html>')).toBe(true);
      expect(html).toContain(`<html lang="${locale}" ${dir}>`);
      expect(text).toContain(mail.url);
      expect(text).toContain('kept.test');
      expect(subject).toBe(messageFor(mail, locale, ctx).subject);
    }
  });
});

describe('createMailer', () => {
  it('logs mail as due, by kind only, when KEPT_SMTP_URL is unset', async () => {
    const logged: object[] = [];
    const setup = createMailer(
      { KEPT_PUBLIC_URL: PUBLIC_URL },
      { logger: { warn: (obj: object) => logged.push(obj) } as never },
    );
    expect(setup.configured).toBe(false);
    await setup.mailer.send({ kind: 'magic-link', to: 'secret@x.test', url: 'http://t#token=s' });
    expect(logged).toEqual([{ mail: 'magic-link' }]);
    expect(JSON.stringify(logged)).not.toContain('secret');
  });

  it('defaults the From to no-reply at the public host', () => {
    expect(defaultFrom('https://kept.example.org/')).toBe('Kept <no-reply@kept.example.org>');
  });
});

describe('over SMTP, to Mailpit', () => {
  let db: TestDb;
  let smtp: SmtpMailer;
  const address = (label: string) => `${label}-${randomUUID()}@example.test`;

  beforeAll(async () => {
    db = await testDb();
    await db.reset();
    smtp = smtpMailer({
      url: MAILPIT_SMTP_URL,
      from: 'Kept <kept@kept.test>',
      publicUrl: PUBLIC_URL,
      localeOf: profileLocaleLookup(db.pools.system),
    });
  });

  afterAll(() => smtp.close());

  it('delivers a mail with both parts', async () => {
    const to = address('smtp');
    const url = `${PUBLIC_URL}/auth/confirm#token=abc`;
    await smtp.send({ kind: 'magic-link', to, url });
    const [msg] = await mailpitWait(to);
    expect(msg?.Subject).toBe('Your Kept sign-in link');
    expect(msg?.From).toEqual({ Name: 'Kept', Address: 'kept@kept.test' });
    expect(msg?.Text).toContain(url);
    expect(msg?.HTML).toContain(`href="${url}"`);
  });

  it("writes in the recipient's profile language, unless the mail names one", async () => {
    const user = await seedUser(db, 'arabic-reader');
    const to = await userEmail(db, user);
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.user_profiles (user_id, display_name, locale)
         VALUES ($1, 'Peter', 'ar-EG')
         ON CONFLICT (user_id) DO UPDATE SET locale = 'ar-EG'`,
        [user],
      ),
    );
    await smtp.send({ kind: 'security-notice', to, event: 'password-changed' });
    await smtp.send({ kind: 'security-notice', to, event: 'password-changed', locale: 'en' });
    const [ar, en] = await mailpitWait(to, 2);
    expect(ar?.Subject).toBe('تغيّرت كلمة مرورك على Kept');
    expect(ar?.HTML).toContain('dir="rtl"');
    expect(en?.Subject).toBe('Your Kept password was changed');
  });

  it("mails the owner of a location about a new member (D180), in the owner's language", async () => {
    const home = await seedTenant(db, 'owner-notice');
    const owner = await userEmail(db, home.userId);
    const joiner = await seedUser(db, 'joiner');
    await ownerTx(db, async (c) => {
      await c.query(`UPDATE public.user_profiles SET locale = 'ar-EG' WHERE user_id = $1`, [
        home.userId,
      ]);
      await c.query(
        `INSERT INTO public.user_profiles (user_id, display_name) VALUES ($1, 'Louis')
         ON CONFLICT (user_id) DO UPDATE SET display_name = 'Louis'`,
        [joiner],
      );
      await c.query(
        `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'member')`,
        [home.locationId, joiner],
      );
      await c.query(`UPDATE public.locations SET name = 'بيت العائلة' WHERE id = $1`, [
        home.locationId,
      ]);
    });
    const sent: Mail[] = [];
    const ok = await notifyOwnerNewMember(
      db.pools,
      { locationId: home.locationId, userId: joiner },
      undefined,
      {
        send: async (m) => {
          sent.push(m);
          await smtp.send(m);
        },
      },
    );
    expect(ok).toBe(true);
    expect(sent).toEqual([
      expect.objectContaining({
        kind: 'owner-new-member',
        to: owner,
        locale: 'ar-EG',
        locationName: 'بيت العائلة',
        memberName: 'Louis',
        role: 'member',
        managed: false,
      }),
    ]);
    const [msg] = await mailpitWait(owner);
    expect(msg?.Subject).toBe('انضمّ Louis إلى «بيت العائلة»');
  });

  it('rolls the notice back when the mail fails, so the retry starts clean', async () => {
    const home = await seedTenant(db, 'owner-notice-fail');
    const joiner = await seedUser(db, 'joiner-fail');
    await ownerTx(db, (c) =>
      c.query(
        `INSERT INTO public.memberships (location_id, user_id, role) VALUES ($1, $2, 'viewer')`,
        [home.locationId, joiner],
      ),
    );
    await expect(
      notifyOwnerNewMember(db.pools, { locationId: home.locationId, userId: joiner }, undefined, {
        send: async () => {
          throw new Error('smtp down');
        },
      }),
    ).rejects.toThrow('smtp down');
    const { rows } = await db.pools.system.query(
      `SELECT count(*)::int AS n FROM public.audit_events
        WHERE location_id = $1 AND action = 'member.owner_notified'`,
      [home.locationId],
    );
    expect(rows[0].n).toBe(0);
  });
});
