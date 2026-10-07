import { ACTIVE_SOURCE_TYPES, SOURCE_KINDS } from '@kept/shared';
import { describe, expect, it } from 'vitest';
import { MAIL_LOCALES, type MailLocale, messageFor } from '../mail/messages.js';
import { renderMail } from '../mail/render.js';
import { digestPush, reminderPush } from './push.js';
import {
  longDay,
  REMINDER_COUNT,
  REMINDER_WORDS,
  type ReminderFacts,
  shortTitle,
} from './words.js';

// L113: every reminder text names the thing (or place), its path, the location and the local
// date, in every language (D204): the immediate mail, the digest, and the push payload, for each
// source and each kind it produces (plan Q7). Money never appears (no field could carry it).

const PUBLIC_URL = 'https://kept.example.org';
const ctx = { publicUrl: PUBLIC_URL };

const NAMES: Record<MailLocale, { thing: string; path: string; location: string }> = {
  en: { thing: 'Drill', path: 'Garage › Shelf', location: 'Home' },
  ar: { thing: 'مثقاب', path: 'المرآب › الرف', location: 'بيت العائلة' },
  fr: { thing: 'Perceuse', path: 'Garage › Étagère', location: 'Maison' },
  de: { thing: 'Bohrmaschine', path: 'Garage › Regal', location: 'Zuhause' },
  it: { thing: 'Trapano', path: 'Garage › Scaffale', location: 'Casa' },
};

function facts(locale: MailLocale, f: Partial<ReminderFacts>): ReminderFacts {
  const n = NAMES[locale];
  return {
    sourceType: 'schedule',
    kind: 'due',
    title: 'Service',
    subject: { type: 'thing', name: n.thing, path: n.path },
    locationName: n.location,
    dueOn: '2026-10-17',
    dueValue: null,
    unit: null,
    link: '/t/0192f0c3-7c55-7000-8000-000000000002',
    ...f,
  };
}

/** Every source with every kind it produces (Q7). */
const CASES = ACTIVE_SOURCE_TYPES.flatMap((sourceType) =>
  SOURCE_KINDS[sourceType].map((kind) => ({ sourceType, kind })),
);

describe('reminder wording (L113)', () => {
  it.each(MAIL_LOCALES)('names the thing, its path, the location and the date in %s', (locale) => {
    const n = NAMES[locale];
    const day = longDay(REMINDER_WORDS[locale].tag, '2026-10-17');
    for (const c of CASES) {
      const f = facts(locale, c);
      const label = `${locale} ${c.sourceType} ${c.kind}`;

      const mail = messageFor({ kind: 'reminder', to: 'bruce@x.test', item: f }, locale, ctx);
      const text = renderMail(mail, locale, PUBLIC_URL).text;
      for (const part of [n.thing, n.path, n.location, day]) expect(text, label).toContain(part);
      expect(mail.action?.url, label).toBe(`${PUBLIC_URL}${f.link}`);
      expect(mail.footnote, label).toContain(`${PUBLIC_URL}/settings/me/notifications`);

      const push = reminderPush(locale, f, 'topic');
      const shown = `${push.title}\n${push.body}`;
      for (const part of [n.thing, n.path, n.location, day]) expect(shown, label).toContain(part);
      expect(push.url, label).toBe(f.link);
    }
  });

  it.each(MAIL_LOCALES)('lists every item of a digest with its own date in %s', (locale) => {
    const n = NAMES[locale];
    const items = [
      facts(locale, { sourceType: 'warranty', kind: 'expiring', dueOn: '2026-11-01' }),
      facts(locale, {
        sourceType: 'document',
        kind: 'expiring',
        title: 'Lease',
        subject: { type: 'location', name: n.location, path: null },
        dueOn: '2026-11-20',
      }),
    ];
    const mail = messageFor(
      { kind: 'reminder-digest', to: 'bruce@x.test', day: '2026-10-17', items },
      locale,
      ctx,
    );
    const text = renderMail(mail, locale, PUBLIC_URL).text;
    const tag = REMINDER_WORDS[locale].tag;
    for (const part of [
      n.thing,
      n.path,
      n.location,
      longDay(tag, '2026-11-01'),
      longDay(tag, '2026-11-20'),
    ]) {
      expect(text, locale).toContain(part);
    }
    expect(mail.subject).toContain(REMINDER_COUNT[locale](2));
    const push = digestPush(locale, items, '2026-10-17');
    expect(push.body.split('\n')).toHaveLength(2);
  });

  it('writes a reading for a unit schedule, and a short title for the calendar and push', () => {
    const f = facts('en', { dueOn: null, dueValue: '60000', unit: 'km', title: 'Oil change' });
    expect(REMINDER_WORDS.en.headline(f)).toBe('Oil change for Drill is due at 60,000 km');
    expect(shortTitle(REMINDER_WORDS.en, f)).toBe('Oil change · Drill');
    expect(REMINDER_WORDS.en.headline(facts('en', { sourceType: 'loan', kind: 'overdue' }))).toBe(
      'Drill was due back on October 17, 2026',
    );
    // Arabic keeps Western digits, as all Kept mail does.
    expect(REMINDER_WORDS.ar.headline(facts('ar', { kind: 'overdue' }))).toMatch(/17/);
  });

  it('says when a stale meter was last read, by its label or its kind (step 5, D52)', () => {
    const f = (locale: MailLocale, meter: ReminderFacts['meter']) =>
      facts(locale, { sourceType: 'reading_stale', title: null, dueOn: '2026-10-17', meter });
    const odo = { kind: 'distance' as const, label: null, readOn: '2026-09-17' };
    expect(REMINDER_WORDS.en.headline(f('en', odo))).toBe(
      'The odometer on Drill was last read on September 17, 2026',
    );
    expect(REMINDER_WORDS.en.label(f('en', odo))).toBe('Reading needed');
    expect(
      REMINDER_WORDS.en.headline(f('en', { kind: 'hours', label: 'Engine', readOn: null })),
    ).toBe('“Engine” on Drill needs a reading on October 17, 2026');
    expect(REMINDER_WORDS.de.headline(f('de', { ...odo, kind: 'hours' }))).toBe(
      'Der Betriebsstundenzähler von Bohrmaschine wurde zuletzt am 17. September 2026 abgelesen',
    );
    for (const locale of MAIL_LOCALES) {
      expect(REMINDER_WORDS[locale].headline(f(locale, odo)), locale).toContain('17');
      expect(REMINDER_WORDS[locale].headline(f(locale, odo)), locale).toContain(
        NAMES[locale].thing,
      );
    }
  });

  it('counts in each language, Arabic with its plural forms', () => {
    expect(REMINDER_COUNT.en(1)).toBe('1 reminder');
    expect(REMINDER_COUNT.en(3)).toBe('3 reminders');
    expect(REMINDER_COUNT.ar(1)).toBe('تذكير واحد');
    expect(REMINDER_COUNT.ar(2)).toBe('تذكيران');
    expect(REMINDER_COUNT.ar(3)).toBe('3 تذكيرات');
    expect(REMINDER_COUNT.ar(11)).toBe('11 تذكيرًا');
    expect(REMINDER_COUNT.de(2)).toBe('2 Erinnerungen');
  });
});
