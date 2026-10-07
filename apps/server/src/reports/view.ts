import { type Digits, formatMoney, printedCode } from '@kept/shared';
import type { Gathered, GatheredThing, ReportOptions } from './gather.js';
import { type ReportLabels, type ReportLocale, templateLabels, wordsFor } from './labels.js';

// The report's data as the Typst template reads it (template/report.typ, `/data.json`). Every
// string is final here: numbers, money and dates are formatted with Intl in the report's
// language and digits (D143), so the template only lays them out. Money is formatted by
// @kept/shared's formatMoney(), the web's own, rounded to the currency's minor units only here
// at the output edge (Q2); sums are exact decimal arithmetic on the database's numeric strings.
// Short IDs and serials are never localised: they stay in Western digits (D120, D143), and a
// short ID is printed as the app's chip shows it, 3 + 3 around a non-breaking hyphen (D134).

export type ViewThing = {
  id: string;
  name: string;
  type: string;
  brandModel: string;
  serial: string;
  purchased: string;
  condition: string;
  status: string;
  /** "7KQ‑4MZ" (printedCode(), U+2011), or '' before a code is allocated. */
  shortId: string;
  /** `/thumbs/<id>.jpg` when the thing has a photo in the report, else null. */
  photo: string | null;
  /** `/qr/<id>.svg` when QR codes are on and it has a short ID, else null. */
  qr: string | null;
  qty: string;
  value: string;
};

export type ViewPlace = {
  key: string;
  /** The place path's steps, outermost first; the template joins them with `pathSeparator`,
   * each step isolated so mixed-script names keep their order. */
  path: string[];
  /** The steps joined with `pathSeparator`, for sorting and plain-text use. */
  pathText: string;
  count: string;
  subtotals: string[];
  things: ViewThing[];
};

export type ReportView = {
  lang: ReportLocale;
  dir: 'ltr' | 'rtl';
  /**
   * Between a path's steps: "›" left to right, "‹" right to left, pointing from the outer place
   * to the inner one as the web's breadcrumbs do. Typst doesn't mirror it by itself.
   */
  pathSeparator: '›' | '‹';
  digits: 'latn' | 'arab';
  labels: ReportLabels;
  scopeName: string;
  scopeDetail: string;
  generatedBy: string;
  generatedLine: string;
  footer: string;
  counts: { things: string; places: string; photos: string };
  totals: string[];
  moneyNote: string;
  filters: string[];
  photos: boolean;
  qr: boolean;
  showMoney: boolean;
  places: ViewPlace[];
};

export type ViewContext = {
  /** KEPT_PUBLIC_URL's host, for the footer. */
  instance: string;
  now: Date;
  /** Which things have a thumbnail in the job directory. */
  withPhoto: ReadonlySet<string>;
  /** Which things have a QR code in the job directory. */
  withQr: ReadonlySet<string>;
};

// --- exact decimal sums ----------------------------------------------------------------------

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** a + b for non-negative decimal strings, exactly. */
export function addDecimal(a: string, b: string): string {
  const ma = DECIMAL.exec(a);
  const mb = DECIMAL.exec(b);
  if (!ma || !mb) throw new Error('not a decimal');
  const scale = Math.max(ma[2]?.length ?? 0, mb[2]?.length ?? 0);
  const big = (m: RegExpExecArray) => BigInt((m[1] ?? '0') + (m[2] ?? '').padEnd(scale, '0'));
  const sum = (big(ma) + big(mb)).toString().padStart(scale + 1, '0');
  return scale === 0 ? sum : `${sum.slice(0, -scale)}.${sum.slice(-scale)}`;
}

/** Sums by currency, in currency-code order. */
function sums(things: readonly GatheredThing[]): [string, string][] {
  const by = new Map<string, string>();
  for (const t of things) {
    const m = t.money;
    if (!m?.value || !m.currency) continue;
    by.set(m.currency, addDecimal(by.get(m.currency) ?? '0', m.value));
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// --- formatting ------------------------------------------------------------------------------

const intlLocale = (locale: ReportLocale) => (locale === 'ar' ? 'ar-EG' : 'en-GB');
const numbering = (locale: ReportLocale, digits: Digits) =>
  locale === 'ar' && digits === 'eastern' ? 'arab' : 'latn';

function formatters(options: ReportOptions, timeZone: string) {
  const locale = intlLocale(options.locale);
  const numberingSystem = numbering(options.locale, options.digits);
  const nf = new Intl.NumberFormat(locale, { numberingSystem, maximumFractionDigits: 3 });
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
    numberingSystem,
  });
  const dateTime = new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone,
    numberingSystem,
  });
  return {
    int: (n: number) => nf.format(n),
    qty: (q: string) => nf.format(Number(q)),
    /** A calendar date (`YYYY-MM-DD`), shown as that day wherever the reader is. */
    day: (d: string) => date.format(new Date(`${d}T00:00:00Z`)),
    dateTime: (d: Date) => dateTime.format(d),
    /** formatMoney()'s own output, left-to-right isolated in Arabic (D136): Typst honours the
     * isolates (U+2066…U+2069), so "٣٩٩٫٩٨ US$" keeps its order inside a right-to-left line. */
    money: (amount: string, currency: string) =>
      formatMoney(amount, currency, { locale: options.locale, digits: options.digits }),
  };
}

function safeTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** Builds the template's data from what gather() read. */
export function buildView(g: Gathered, options: ReportOptions, ctx: ViewContext): ReportView {
  const w = wordsFor(options.locale);
  const f = formatters(options, safeTimeZone(g.requesterTimezone));
  const collate = new Intl.Collator(options.locale, { numeric: true }).compare;
  const account = g.accountOwnerName !== null;
  const locationName = new Map(g.locations.map((l) => [l.id, l.name]));
  const showMoney = options.include.money && g.moneyShown;
  const pathSeparator = options.locale === 'ar' ? '‹' : '›';

  const groups = new Map<string, { path: string[]; pathText: string; things: GatheredThing[] }>();
  for (const t of g.things) {
    const steps = t.path.map((s) => (s.isUnplaced ? w.unplaced : (s.name ?? '')));
    if (account) steps.unshift(locationName.get(t.locationId) ?? '');
    const last = t.path.at(-1);
    const key = `${t.locationId}/${last?.id ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      const path = steps.filter((s) => s !== '');
      group = { path, pathText: path.join(` ${pathSeparator} `), things: [] };
      groups.set(key, group);
    }
    group.things.push(t);
  }

  const places: ViewPlace[] = [...groups.entries()]
    .sort(([, a], [, b]) => collate(a.pathText, b.pathText))
    .map(([key, group]) => {
      const things = [...group.things].sort(
        (a, b) => collate(a.name, b.name) || (a.id < b.id ? -1 : 1),
      );
      return {
        key,
        path: group.path,
        pathText: group.pathText,
        count: w.thingCount(things.length, f.int(things.length)),
        subtotals: showMoney ? sums(things).map(([c, v]) => f.money(v, c)) : [],
        things: things.map((t): ViewThing => {
          const m = showMoney ? t.money : null;
          const status = t.trashed
            ? w.trashed
            : t.lifecycle !== 'in_use'
              ? (w.lifecycle[t.lifecycle as keyof typeof w.lifecycle] ?? '')
              : '';
          return {
            id: t.id,
            name: t.name,
            type: t.typeName ?? '',
            brandModel: [t.brand, t.model].filter((x) => x && x !== '').join(' '),
            serial: t.serial ?? '',
            purchased: m?.purchasedOn ? f.day(m.purchasedOn) : '',
            condition: t.condition
              ? (w.condition[t.condition as keyof typeof w.condition] ?? '')
              : '',
            status,
            shortId: t.shortCode ? printedCode(t.shortCode) : '',
            photo: ctx.withPhoto.has(t.id) ? `/thumbs/${t.id}.jpg` : null,
            qr: ctx.withQr.has(t.id) ? `/qr/${t.id}.svg` : null,
            qty: f.qty(t.quantity),
            value: m?.value && m.currency ? f.money(m.value, m.currency) : '',
          };
        }),
      };
    });

  const when = f.dateTime(ctx.now);
  const filters: string[] = [];
  const list = (names: string[]) => names.join(options.locale === 'ar' ? '، ' : ', ');
  if (g.filterNames.places.length > 0)
    filters.push(`${w.filterPlaces}: ${list(g.filterNames.places)}`);
  if (g.filterNames.types.length > 0)
    filters.push(`${w.filterTypes}: ${list(g.filterNames.types)}`);
  if (g.filterNames.tags.length > 0) filters.push(`${w.filterTags}: ${list(g.filterNames.tags)}`);
  if (options.filters.includeEnded) filters.push(w.withEnded);
  if (options.filters.includeTrashed) filters.push(w.withTrashed);

  return {
    lang: options.locale,
    dir: options.locale === 'ar' ? 'rtl' : 'ltr',
    pathSeparator,
    digits: numbering(options.locale, options.digits),
    labels: templateLabels(options.locale),
    scopeName: account ? w.allLocations : (g.locations[0]?.name ?? ''),
    scopeDetail: account
      ? [g.accountOwnerName, w.locationsList(list(g.locations.map((l) => l.name)))]
          .filter((x) => !!x)
          .join(' · ')
      : '',
    generatedBy: g.requesterName,
    generatedLine: w.generated(g.requesterName, when),
    footer: ['Kept', ctx.instance, when].filter((x) => x !== '').join(' · '),
    counts: {
      things: f.int(g.things.length),
      places: f.int(places.length),
      photos: f.int(ctx.withPhoto.size),
    },
    totals: showMoney ? sums(g.things).map(([c, v]) => f.money(v, c)) : [],
    moneyNote: showMoney && g.moneyHidden ? w.moneyPartial : '',
    filters,
    photos: options.include.photos,
    qr: options.include.qr,
    showMoney,
    places,
  };
}
