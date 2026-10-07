import type { ActiveSourceType, OccurrenceKind } from '@kept/shared';
import type { MailLocale } from '../mail/messages.js';

// How a reminder reads, in each language Kept mails in (D204; L113): the one wording the email
// (mail/messages-notify.ts), the push payload (notify/push.ts) and the calendar feed
// (calendar/feed.ts) share, so a reminder says the same thing wherever it lands.
//
// L113: every reminder names the thing (or place), its path, the location and the local date.
// `headline()` names the thing and the date; `where()` the path and the location. Money never
// appears in a reminder, and nor do people's contact details (D57, D110).

/** What a reminder is about, as the agenda gives it (agenda_items) with its subject's words. */
export type ReminderFacts = {
  sourceType: ActiveSourceType;
  kind: OccurrenceKind;
  /** The source's own words: a schedule's name, a warranty's provider, a document's title. */
  title: string | null;
  /** An expiring document's kind (`lease`, `insurance`, …), named when it has no title. */
  documentKind?: string | null;
  subject: { type: 'thing' | 'place' | 'location'; name: string; path: string | null };
  locationName: string;
  /** The due point in the location's time zone (L2, inclusive): a date, or a meter reading. */
  dueOn: string | null;
  dueValue: string | null;
  /** The meter's unit, for a reading. */
  unit: string | null;
  /** The item's page, a path under KEPT_PUBLIC_URL (`/t/<id>`, `/p/<id>`, `/loc/<id>`). */
  link: string;
  /** A stale-reading nudge's meter (step 5, D52): its kind, its own label, and the local day of
   * its latest accepted reading. */
  meter?: StaleMeter | null;
};

/** The meter a `reading_stale` reminder is about. */
export type StaleMeter = {
  kind: 'distance' | 'hours' | 'custom';
  label: string | null;
  /** `YYYY-MM-DD`, the location's own day; null when it can't be told (no reading now). */
  readOn: string | null;
};

export type ReminderWords = {
  /** The Intl tag dates and numbers are written in (Arabic keeps Western digits, as all mail). */
  tag: string;
  /** One sentence, no full stop: the thing, what is due and when. */
  headline: (f: ReminderFacts) => string;
  /** A short label: the calendar event's and a push notification's title, before the name. */
  label: (f: ReminderFacts) => string;
  /** The path and the location, for the line under the headline. */
  where: (f: ReminderFacts) => string;
};

/** A date (YYYY-MM-DD) written out in `tag`, as a calendar day (no time zone shift). */
export function longDay(tag: string, iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(tag, { dateStyle: 'long', timeZone: 'UTC' }).format(d);
}

/** A meter reading with its unit, grouped for `tag`. */
export function reading(tag: string, value: string | null, unit: string | null): string {
  const n = Number(value);
  const shown = Number.isFinite(n)
    ? new Intl.NumberFormat(tag, { maximumFractionDigits: 3 }).format(n)
    : (value ?? '');
  return unit ? `${shown} ${unit}` : shown;
}

const where = (f: ReminderFacts) =>
  f.subject.type === 'location'
    ? f.locationName
    : [f.subject.path, f.locationName].filter((p): p is string => !!p).join(' · ');

type Phrase = (name: string, when: string, f: ReminderFacts) => string;

/** Builds a language's words from its phrases: `when` is the date (or reading) already written. */
function words(
  tag: string,
  on: (f: ReminderFacts, day: string) => string,
  at: (value: string) => string,
  headlines: Record<ActiveSourceType, Partial<Record<OccurrenceKind, Phrase>> & { any: Phrase }>,
  labels: Record<ActiveSourceType, (f: ReminderFacts) => string>,
): ReminderWords {
  const when = (f: ReminderFacts) =>
    f.dueOn ? on(f, longDay(tag, f.dueOn)) : at(reading(tag, f.dueValue, f.unit));
  return {
    tag,
    headline: (f) => {
      const table = headlines[f.sourceType];
      return (table[f.kind] ?? table.any)(f.subject.name, when(f), f);
    },
    label: (f) => labels[f.sourceType](f),
    where,
  };
}

/** A document's title, else its kind in words, else `fallback`. */
const docTitle = (f: ReminderFacts, kinds: Record<string, string>, fallback: string) =>
  f.title ?? (f.documentKind ? kinds[f.documentKind] : undefined) ?? fallback;

const provider = (f: ReminderFacts, wrap: (p: string) => string) =>
  f.title && (f.sourceType === 'warranty' || f.sourceType === 'registration') ? wrap(f.title) : '';

/**
 * A stale-reading nudge (step 5, D52): the meter by its label, else its kind in words, then
 * `read(meter, day)` with the day of its latest reading, or `due(meter, when)` with the nudge's
 * own date when that day can't be told.
 */
const stale =
  (
    tag: string,
    kinds: Record<StaleMeter['kind'], string>,
    quote: (label: string) => string,
    read: (meter: string, n: string, day: string) => string,
    due: (meter: string, n: string, when: string) => string,
  ): Phrase =>
  (n, w, f) => {
    const meter = f.meter?.label ? quote(f.meter.label) : kinds[f.meter?.kind ?? 'custom'];
    return f.meter?.readOn ? read(meter, n, longDay(tag, f.meter.readOn)) : due(meter, n, w);
  };

// Expiring documents' kinds (@kept/shared DOCUMENT_KINDS), for a document without a title.
const EN_DOCS: Record<string, string> = {
  registration: 'The registration',
  insurance: 'The insurance',
  licence: 'The licence',
  inspection: 'The inspection',
  lease: 'The lease',
  contract: 'The contract',
};
const AR_DOCS: Record<string, string> = {
  registration: 'الترخيص',
  insurance: 'التأمين',
  licence: 'الرخصة',
  inspection: 'الفحص',
  lease: 'عقد الإيجار',
  contract: 'العقد',
};
const FR_DOCS: Record<string, string> = {
  registration: 'L’immatriculation',
  insurance: 'L’assurance',
  licence: 'La licence',
  inspection: 'Le contrôle',
  lease: 'Le bail',
  contract: 'Le contrat',
};
const DE_DOCS: Record<string, string> = {
  registration: 'Die Zulassung',
  insurance: 'Die Versicherung',
  licence: 'Die Lizenz',
  inspection: 'Die Prüfung',
  lease: 'Der Mietvertrag',
  contract: 'Der Vertrag',
};
const IT_DOCS: Record<string, string> = {
  registration: 'L’immatricolazione',
  insurance: 'L’assicurazione',
  licence: 'La licenza',
  inspection: 'La revisione',
  lease: 'Il contratto d’affitto',
  contract: 'Il contratto',
};

const EN = words(
  'en',
  (f, day) => (f.sourceType === 'registration' ? `by ${day}` : `on ${day}`),
  (v) => `at ${v}`,
  {
    schedule: {
      any: (n, w, f) => `${f.title ?? 'A service'} for ${n} is due ${w}`,
      overdue: (n, w, f) => `${f.title ?? 'A service'} for ${n} was due ${w}`,
    },
    warranty: {
      any: (n, w, f) => `The warranty on ${n}${provider(f, (p) => ` from ${p}`)} ends ${w}`,
    },
    registration: {
      any: (n, w, f) => `Register the warranty on ${n}${provider(f, (p) => ` from ${p}`)} ${w}`,
    },
    document: {
      any: (n, w, f) => `${docTitle(f, EN_DOCS, 'A document')} for ${n} expires ${w}`,
      overdue: (n, w, f) => `${docTitle(f, EN_DOCS, 'A document')} for ${n} expired ${w}`,
    },
    loan: { any: (n, w) => `${n} was due back ${w}` },
    thing_expiry: {
      any: (n, w) => `${n} expires ${w}`,
      overdue: (n, w) => `${n} expired ${w}`,
    },
    stock: { any: (n, w) => `${n} ran low ${w}` },
    reading_stale: {
      any: stale(
        'en',
        { distance: 'The odometer', hours: 'The hour meter', custom: 'The meter' },
        (l) => `“${l}”`,
        (m, n, day) => `${m} on ${n} was last read on ${day}`,
        (m, n, w) => `${m} on ${n} needs a reading ${w}`,
      ),
    },
  },
  {
    schedule: (f) => f.title ?? 'Service due',
    warranty: () => 'Warranty ends',
    registration: () => 'Register the warranty',
    document: (f) => docTitle(f, EN_DOCS, 'Document expires'),
    loan: () => 'Due back',
    thing_expiry: () => 'Expires',
    reading_stale: () => 'Reading needed',
    stock: () => 'Low stock',
  },
);

const AR = words(
  'ar-u-nu-latn',
  (f, day) => (f.sourceType === 'registration' ? `في موعد أقصاه ${day}` : `في ${day}`),
  (v) => `عند ${v}`,
  {
    schedule: {
      any: (n, w, f) => `يحين موعد «${f.title ?? 'صيانة'}» لـ«${n}» ${w}`,
      overdue: (n, w, f) => `تأخّر «${f.title ?? 'صيانة'}» لـ«${n}»، وكان موعده ${w}`,
    },
    warranty: {
      any: (n, w, f) => `ينتهي ضمان «${n}»${provider(f, (p) => ` من ${p}`)} ${w}`,
    },
    registration: {
      any: (n, w, f) => `سجّل ضمان «${n}»${provider(f, (p) => ` من ${p}`)} ${w}`,
    },
    document: {
      any: (n, w, f) => `تنتهي صلاحية «${docTitle(f, AR_DOCS, 'مستند')}» الخاص بـ«${n}» ${w}`,
      overdue: (n, w, f) => `انتهت صلاحية «${docTitle(f, AR_DOCS, 'مستند')}» الخاص بـ«${n}» ${w}`,
    },
    loan: { any: (n, w) => `كان موعد إعادة «${n}» ${w}` },
    thing_expiry: {
      any: (n, w) => `تنتهي صلاحية «${n}» ${w}`,
      overdue: (n, w) => `انتهت صلاحية «${n}» ${w}`,
    },
    stock: { any: (n, w) => `أوشك «${n}» على النفاد ${w}` },
    reading_stale: {
      any: stale(
        'ar-u-nu-latn',
        { distance: 'لعداد المسافة', hours: 'لعداد الساعات', custom: 'للعداد' },
        (l) => `لـ«${l}»`,
        (m, n, day) => `آخر قراءة ${m} في «${n}» كانت في ${day}`,
        (m, n, w) => `حان وقت قراءة جديدة ${m} في «${n}» ${w}`,
      ),
    },
  },
  {
    schedule: (f) => f.title ?? 'موعد صيانة',
    warranty: () => 'انتهاء الضمان',
    registration: () => 'تسجيل الضمان',
    document: (f) => docTitle(f, AR_DOCS, 'انتهاء مستند'),
    loan: () => 'موعد الإعادة',
    thing_expiry: () => 'انتهاء الصلاحية',
    reading_stale: () => 'قراءة مطلوبة',
    stock: () => 'مخزون منخفض',
  },
);

const FR = words(
  'fr',
  (f, day) => (f.sourceType === 'registration' ? `d’ici le ${day}` : `le ${day}`),
  (v) => `à ${v}`,
  {
    schedule: {
      any: (n, w, f) => `${f.title ?? 'Entretien'} pour ${n} : à faire ${w}`,
      overdue: (n, w, f) => `${f.title ?? 'Entretien'} pour ${n} : à faire ${w}, en retard`,
    },
    warranty: {
      any: (n, w, f) => `La garantie de ${n}${provider(f, (p) => ` (${p})`)} prend fin ${w}`,
    },
    registration: {
      any: (n, w, f) => `Enregistrez la garantie de ${n}${provider(f, (p) => ` (${p})`)} ${w}`,
    },
    document: {
      any: (n, w, f) => `${docTitle(f, FR_DOCS, 'Un document')} pour ${n} expire ${w}`,
      overdue: (n, w, f) => `${docTitle(f, FR_DOCS, 'Un document')} pour ${n} a expiré ${w}`,
    },
    loan: { any: (n, w) => `${n} : à rendre ${w}, en retard` },
    thing_expiry: {
      any: (n, w) => `${n} expire ${w}`,
      overdue: (n, w) => `${n} a expiré ${w}`,
    },
    stock: { any: (n, w) => `Stock bas pour ${n} ${w}` },
    reading_stale: {
      any: stale(
        'fr',
        {
          distance: 'Le compteur kilométrique',
          hours: 'Le compteur horaire',
          custom: 'Le compteur',
        },
        (l) => `« ${l} »`,
        (m, n, day) => `${m} de ${n} a été relevé pour la dernière fois le ${day}`,
        (m, n, w) => `${m} de ${n} est à relever ${w}`,
      ),
    },
  },
  {
    schedule: (f) => f.title ?? 'Entretien prévu',
    warranty: () => 'Fin de garantie',
    registration: () => 'Enregistrer la garantie',
    document: (f) => docTitle(f, FR_DOCS, 'Document à renouveler'),
    loan: () => 'À rendre',
    thing_expiry: () => 'Expiration',
    reading_stale: () => 'Relevé à faire',
    stock: () => 'Stock bas',
  },
);

const DE = words(
  'de',
  (f, day) => (f.sourceType === 'registration' ? `bis zum ${day}` : `am ${day}`),
  (v) => `bei ${v}`,
  {
    schedule: {
      any: (n, w, f) => `${f.title ?? 'Eine Wartung'} für ${n} ist ${w} fällig`,
      overdue: (n, w, f) => `${f.title ?? 'Eine Wartung'} für ${n} war ${w} fällig`,
    },
    warranty: {
      any: (n, w, f) => `Die Garantie für ${n}${provider(f, (p) => ` (${p})`)} endet ${w}`,
    },
    registration: {
      any: (n, w, f) => `Registriere die Garantie für ${n}${provider(f, (p) => ` (${p})`)} ${w}`,
    },
    document: {
      any: (n, w, f) => `${docTitle(f, DE_DOCS, 'Ein Dokument')} für ${n} läuft ${w} ab`,
      overdue: (n, w, f) => `${docTitle(f, DE_DOCS, 'Ein Dokument')} für ${n} ist ${w} abgelaufen`,
    },
    loan: { any: (n, w) => `${n} sollte ${w} zurückgegeben werden` },
    thing_expiry: {
      any: (n, w) => `${n} läuft ${w} ab`,
      overdue: (n, w) => `${n} ist ${w} abgelaufen`,
    },
    stock: { any: (n, w) => `${n} wurde ${w} knapp` },
    reading_stale: {
      any: stale(
        'de',
        {
          distance: 'Der Kilometerzähler',
          hours: 'Der Betriebsstundenzähler',
          custom: 'Der Zähler',
        },
        (l) => `„${l}“`,
        (m, n, day) => `${m} von ${n} wurde zuletzt am ${day} abgelesen`,
        (m, n, w) => `${m} von ${n} sollte ${w} abgelesen werden`,
      ),
    },
  },
  {
    schedule: (f) => f.title ?? 'Wartung fällig',
    warranty: () => 'Garantie endet',
    registration: () => 'Garantie registrieren',
    document: (f) => docTitle(f, DE_DOCS, 'Dokument läuft ab'),
    loan: () => 'Rückgabe fällig',
    thing_expiry: () => 'Läuft ab',
    reading_stale: () => 'Ablesung fällig',
    stock: () => 'Vorrat knapp',
  },
);

const IT = words(
  'it',
  (f, day) => (f.sourceType === 'registration' ? `entro il ${day}` : `il ${day}`),
  (v) => `a ${v}`,
  {
    schedule: {
      any: (n, w, f) => `${f.title ?? 'Manutenzione'} per ${n}: scadenza ${w}`,
      overdue: (n, w, f) => `${f.title ?? 'Manutenzione'} per ${n}: scadenza ${w}, già passata`,
    },
    warranty: {
      any: (n, w, f) => `La garanzia di ${n}${provider(f, (p) => ` (${p})`)} scade ${w}`,
    },
    registration: {
      any: (n, w, f) => `Registra la garanzia di ${n}${provider(f, (p) => ` (${p})`)} ${w}`,
    },
    document: {
      any: (n, w, f) => `${docTitle(f, IT_DOCS, 'Un documento')} per ${n} scade ${w}`,
      overdue: (n, w, f) =>
        `${docTitle(f, IT_DOCS, 'Un documento')} per ${n}: scadenza ${w}, già passata`,
    },
    loan: { any: (n, w) => `${n}: la restituzione era prevista ${w}` },
    thing_expiry: {
      any: (n, w) => `${n} scade ${w}`,
      overdue: (n, w) => `${n}: scadenza ${w}, già passata`,
    },
    stock: { any: (n, w) => `Scorte di ${n} basse ${w}` },
    reading_stale: {
      any: stale(
        'it',
        { distance: 'Il contachilometri', hours: 'Il contaore', custom: 'Il contatore' },
        (l) => `«${l}»`,
        (m, n, day) => `${m} di ${n} è stato letto l’ultima volta il ${day}`,
        (m, n, w) => `${m} di ${n} va letto ${w}`,
      ),
    },
  },
  {
    schedule: (f) => f.title ?? 'Manutenzione prevista',
    warranty: () => 'Fine garanzia',
    registration: () => 'Registra la garanzia',
    document: (f) => docTitle(f, IT_DOCS, 'Documento in scadenza'),
    loan: () => 'Da restituire',
    thing_expiry: () => 'Scadenza',
    reading_stale: () => 'Lettura da fare',
    stock: () => 'Scorte basse',
  },
);

export const REMINDER_WORDS: Record<MailLocale, ReminderWords> = {
  en: EN,
  ar: AR,
  fr: FR,
  de: DE,
  it: IT,
};

/** The calendar event's title and a push notification's: "Boiler service · Kitchen". */
export function shortTitle(w: ReminderWords, f: ReminderFacts): string {
  return `${w.label(f)} · ${f.subject.name}`;
}

/** "3 reminders", in each language (Arabic with its plural forms, Western digits). */
export const REMINDER_COUNT: Record<MailLocale, (n: number) => string> = {
  en: (n) => (n === 1 ? '1 reminder' : `${n} reminders`),
  ar: (n) => {
    switch (new Intl.PluralRules('ar').select(n)) {
      case 'zero':
        return 'لا تذكيرات';
      case 'one':
        return 'تذكير واحد';
      case 'two':
        return 'تذكيران';
      case 'few':
        return `${n} تذكيرات`;
      case 'many':
        return `${n} تذكيرًا`;
      default:
        return `${n} تذكير`;
    }
  },
  fr: (n) => (n === 1 ? '1 rappel' : `${n} rappels`),
  de: (n) => (n === 1 ? '1 Erinnerung' : `${n} Erinnerungen`),
  it: (n) => `${n} promemoria`,
};
