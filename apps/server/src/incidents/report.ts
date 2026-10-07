import {
  canonicalAmount,
  convert,
  type Digits,
  type FxRate,
  formatMoney,
  type IncidentKind,
  safeCsvCell,
} from '@kept/shared';
import type pg from 'pg';
import type { Scope, Tx } from '../db/scope.js';
import { MAX_THINGS, type PathStep, TooManyThingsError } from '../reports/gather.js';
import { type ReportLocale, wordsFor } from '../reports/labels.js';
import { addDecimal } from '../reports/view.js';
import { gateFor } from '../serialize/gates.js';

// The insurance report (D158, D201; engineering spec §2.8; step-4 plan T18, Q20, Q21): what an
// insurer asks for on the day it matters, as a PDF (template/insurance.typ, through the D201
// engine) and as CSV (D169). Read in the requester's scope, under row-level security, like the
// inventory report (reports/gather.ts):
//
// - Scope: a location (its things in use, drafts and the trash left out), or one incident (its
//   things, whatever their lifecycle now: a stolen television is the point of the report).
// - As of (Q20): the report lists things as they are now; `asOf` picks each thing's current value
//   (its latest valuation on or before that day) and labels the report. The past is not replayed.
// - Per thing: thumbnail, name, brand, model, serial, purchase date and price, current value with
//   its date, and the receipt count (the purchase's receipts and invoices plus any on the thing).
//   Receipts are linked into Kept (the thing's page), not embedded: a PDF can't open a signed URL
//   later.
// - Totals per place and per location, per currency, of each thing's insured value: its current
//   value, or its purchase price when it has no valuation (said under the totals). With a report
//   currency, one converted total beside them, only when every currency has a rate on or before
//   `asOf` (direct or inverse, never chained, never estimated: @kept/shared convert(), Q21), and
//   labelled with the rates' dates.
// - Money: the report is mostly money, so it is refused outright to a reader who can't see money
//   (the route, 403), rather than rendered as blanks. The gather re-checks the gate when the job
//   runs; a reader who lost it since gets no amounts.
// - Secrets: never read. Only built-in columns, never `custom`.

export type InsuranceOptions = {
  kind: 'insurance';
  locationId: string;
  incidentId: string | null;
  /** `YYYY-MM-DD`. */
  asOf: string;
  reportCurrency: string | null;
  include: { photos: boolean };
  locale: ReportLocale;
  digits: Digits;
};

export type InsuranceThing = {
  id: string;
  name: string;
  brand: string | null;
  model: string | null;
  serial: string | null;
  lifecycle: string;
  trashed: boolean;
  quantity: string;
  shortCode: string | null;
  thumbKey: string | null;
  path: PathStep[];
  purchasedOn: string | null;
  /** Unit price × quantity, exact. */
  price: string | null;
  priceCurrency: string | null;
  value: string | null;
  valueCurrency: string | null;
  valuedOn: string | null;
  receipts: number;
};

export type InsuranceIncident = {
  id: string;
  kind: IncidentKind;
  occurredOn: string;
  policeReference: string | null;
  insurerReference: string | null;
};

export type InsuranceGathered = {
  location: { id: string; name: string; ownerAccountId: string };
  ownerName: string | null;
  requesterName: string;
  requesterTimezone: string;
  incident: InsuranceIncident | null;
  /** False when the requester's gate hides money now: no amount was read. */
  moneyShown: boolean;
  things: InsuranceThing[];
  rates: FxRate[];
};

type Row = {
  id: string;
  name: string | null;
  brand: string | null;
  model: string | null;
  serial: string | null;
  lifecycle: string;
  trashed: boolean;
  quantity: string;
  short_code: string | null;
  thumb_key: string | null;
  path: PathStep[] | null;
  purchased_on: string | null;
  price: string | null;
  price_currency: string | null;
  value: string | null;
  value_currency: string | null;
  valued_on: string | null;
  receipts: number;
};

/** The incident, as the caller sees it (null: invisible). */
export async function readIncident(
  client: pg.ClientBase,
  id: string,
): Promise<(InsuranceIncident & { locationId: string }) | null> {
  const { rows } = await client.query<{
    id: string;
    location_id: string;
    kind: IncidentKind;
    occurred_on: string;
    police_reference: string | null;
    insurer_reference: string | null;
  }>(
    `SELECT id, location_id, kind, occurred_on::text AS occurred_on, police_reference,
            insurer_reference
       FROM public.incidents WHERE id = $1`,
    [id.toLowerCase()],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    locationId: r.location_id,
    kind: r.kind,
    occurredOn: r.occurred_on,
    policeReference: r.police_reference,
    insurerReference: r.insurer_reference,
  };
}

/** The account's exchange rates, as the caller sees them (fx_rates' policies). */
export async function accountRates(client: pg.ClientBase, accountId: string): Promise<FxRate[]> {
  const { rows } = await client.query<FxRate>(
    `SELECT from_ccy AS "fromCcy", to_ccy AS "toCcy", rate::text AS rate,
            valid_from::text AS "validFrom"
       FROM public.fx_rates WHERE owner_account_id = $1`,
    [accountId],
  );
  return rows;
}

/**
 * Reads an insurance report's contents in the requester's scoped transaction. Throws
 * TooManyThingsError past MAX_THINGS, and a 404 (gateFor) when the location is invisible.
 */
export async function gatherInsurance(
  tx: Tx,
  client: pg.ClientBase,
  scope: Scope,
  options: Pick<InsuranceOptions, 'locationId' | 'incidentId' | 'asOf' | 'include'> & {
    /** A claim pack of chosen things (D158): these, whatever their lifecycle. */
    thingIds?: readonly string[] | null;
  },
): Promise<InsuranceGathered> {
  const gate = await gateFor(tx, options.locationId, scope);
  const { rows: locs } = await client.query<{
    id: string;
    name: string;
    owner_account_id: string;
  }>(
    'SELECT id, name, owner_account_id FROM public.locations WHERE id = $1 AND deleted_at IS NULL',
    [options.locationId],
  );
  const loc = locs[0];
  if (!loc) throw new Error('insurance report: the location is gone');
  const incident = options.incidentId ? await readIncident(client, options.incidentId) : null;
  if (options.incidentId && (!incident || incident.locationId !== loc.id)) {
    throw new Error('insurance report: the incident is gone');
  }

  const { rows: owner } = await client.query<{ display_name: string }>(
    `SELECT p.display_name FROM public.memberships m
       JOIN public.user_profiles p ON p.user_id = m.user_id
      WHERE m.location_id = $1 AND m.role = 'owner' LIMIT 1`,
    [loc.id],
  );
  const { rows: me } = await client.query<{ display_name: string; timezone: string }>(
    'SELECT display_name, timezone FROM public.user_profiles WHERE user_id = kept.current_user_id()',
  );

  const money = gate.showMoney;
  const thumb = options.include.photos
    ? `(SELECT d.storage_key FROM public.attachments a
          JOIN public.file_derivatives d ON d.file_id = a.file_id AND d.variant = 'thumb'
         WHERE a.thing_id = t.id AND a.role = 'photo'
         ORDER BY a.sort, a.created_at, a.id LIMIT 1)`
    : 'NULL::text';
  // Money columns only where the gate shows it: otherwise kept.thing_purchase() is never called
  // and no valuation is read, so no amount is in memory to leak (as reports/gather.ts).
  const moneyCols = money
    ? `tp.purchased_on::text AS purchased_on, (tp.unit_price * t.quantity)::text AS price,
       tp.currency AS price_currency, cv.value::text AS value, cv.currency AS value_currency,
       cv.valued_on::text AS valued_on,
       ((SELECT count(*) FROM kept.thing_receipts(t.id))
        + (SELECT count(*) FROM public.attachments a
            WHERE a.thing_id = t.id AND a.role IN ('receipt', 'invoice')))::int AS receipts`
    : `NULL::text AS purchased_on, NULL::text AS price, NULL::text AS price_currency,
       NULL::text AS value, NULL::text AS value_currency, NULL::text AS valued_on,
       0 AS receipts`;
  const moneyJoins = money
    ? `LEFT JOIN LATERAL (SELECT x.purchased_on, x.unit_price, x.currency
                            FROM kept.thing_purchase(t.id) x) tp ON true
       LEFT JOIN LATERAL (SELECT v.value, v.currency, v.valued_on FROM public.valuations v
                           WHERE v.thing_id = t.id AND v.valued_on <= $2::date
                           ORDER BY v.valued_on DESC, v.created_at DESC, v.id DESC
                           LIMIT 1) cv ON true`
    : '';
  // $1 the location, $2 the as-of day (money only), then the incident when there is one.
  const params: unknown[] = [loc.id, ...(money ? [options.asOf] : [])];
  let where = `t.deleted_at IS NULL AND t.lifecycle = 'in_use'`;
  if (options.incidentId) {
    params.push(options.incidentId.toLowerCase());
    where = `t.id IN (SELECT it.thing_id FROM public.incident_things it
                       WHERE it.incident_id = $${params.length})`;
  } else if (options.thingIds) {
    params.push(options.thingIds);
    where = `t.id = ANY ($${params.length}::uuid[])`;
  }
  const { rows } = await client.query<Row>(
    `SELECT t.id, t.name, b.name AS brand, t.model, t.serial, t.lifecycle,
            t.deleted_at IS NOT NULL AS trashed, t.quantity::text AS quantity,
            (SELECT s.code FROM public.short_ids s
              WHERE s.thing_id = t.id AND s.is_primary AND s.state = 'assigned' LIMIT 1)
              AS short_code,
            ${thumb} AS thumb_key,
            (SELECT coalesce(jsonb_agg(e || jsonb_build_object('isUnplaced',
                      coalesce((SELECT pl.is_unplaced FROM public.places pl
                                 WHERE e->>'kind' = 'place' AND pl.id = (e->>'id')::uuid), false))
                    ORDER BY n), '[]'::jsonb)
               FROM jsonb_array_elements(kept.path_of(t.place_id, t.container_id))
                    WITH ORDINALITY AS x(e, n)) AS path,
            ${moneyCols}
       FROM public.things t
       LEFT JOIN public.brands b ON b.id = t.brand_id
       ${moneyJoins}
      WHERE t.location_id = $1 AND t.review_state <> 'draft' AND ${where}
      ORDER BY t.id
      LIMIT ${MAX_THINGS + 1}`,
    params,
  );
  if (rows.length > MAX_THINGS) throw new TooManyThingsError();

  return {
    location: { id: loc.id, name: loc.name, ownerAccountId: loc.owner_account_id },
    ownerName: owner[0]?.display_name ?? null,
    requesterName: me[0]?.display_name ?? '',
    requesterTimezone: me[0]?.timezone ?? 'UTC',
    incident,
    moneyShown: money,
    rates: money ? await accountRates(client, loc.owner_account_id) : [],
    things: rows.map((r) => ({
      id: r.id,
      name: r.name ?? '',
      brand: r.brand,
      model: r.model,
      serial: r.serial,
      lifecycle: r.lifecycle,
      trashed: r.trashed,
      quantity: canonicalAmount(r.quantity) ?? r.quantity,
      shortCode: r.short_code,
      thumbKey: r.thumb_key,
      path: r.path ?? [],
      purchasedOn: r.purchased_on,
      // Canonical decimals (§7.7): unit price × quantity carries both scales.
      price: canonicalAmount(r.price),
      priceCurrency: r.price_currency,
      value: canonicalAmount(r.value),
      valueCurrency: r.value_currency,
      valuedOn: r.valued_on,
      receipts: Number(r.receipts ?? 0),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Totals and conversion
// ---------------------------------------------------------------------------------------------

/** A thing's insured value: its current value, else its purchase price (null: neither). */
export function insuredValue(t: InsuranceThing): { amount: string; currency: string } | null {
  if (t.value !== null && t.valueCurrency) return { amount: t.value, currency: t.valueCurrency };
  if (t.price !== null && t.priceCurrency) return { amount: t.price, currency: t.priceCurrency };
  return null;
}

/** Sums of insured values by currency, in currency-code order. */
export function totalsOf(things: readonly InsuranceThing[]): [string, string][] {
  const by = new Map<string, string>();
  for (const t of things) {
    const v = insuredValue(t);
    if (!v) continue;
    by.set(v.currency, addDecimal(by.get(v.currency) ?? '0', v.amount));
  }
  return [...by.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The pairs without a rate on or before `asOf` (direct or inverse) to `to` (Q21). */
export function missingRates(
  totals: readonly [string, string][],
  to: string,
  asOf: string,
  rates: readonly FxRate[],
): { from: string; to: string }[] {
  return totals
    .map(([ccy, amount]) => convert(amount, ccy, to, asOf, rates))
    .flatMap((c) => ('missing' in c ? [c.missing] : []));
}

/** The date of the rate convert() uses for a pair (the pair's newest, else its inverse's). */
function rateDate(rates: readonly FxRate[], from: string, to: string, on: string): string | null {
  const newest = (a: string, b: string) =>
    rates
      .filter((r) => r.fromCcy === a && r.toCcy === b && r.validFrom <= on)
      .map((r) => r.validFrom)
      .sort()
      .at(-1) ?? null;
  return newest(from, to) ?? newest(to, from);
}

/** The converted total, and the dates of the rates it used; null when a rate is missing. */
export function convertedTotal(
  totals: readonly [string, string][],
  to: string,
  asOf: string,
  rates: readonly FxRate[],
): { amount: string; rateDates: string[] } | null {
  let sum = '0';
  const dates = new Set<string>();
  for (const [ccy, amount] of totals) {
    const c = convert(amount, ccy, to, asOf, rates);
    if ('missing' in c) return null;
    sum = addDecimal(sum, c.amount);
    if (ccy !== to) {
      const d = rateDate(rates, ccy, to, asOf);
      if (d) dates.add(d);
    }
  }
  return { amount: sum, rateDates: [...dates].sort() };
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

type InsuranceWords = {
  title: string;
  totals: string;
  converted: (ccy: string) => string;
  subtotal: string;
  thing: string;
  purchase: string;
  value: string;
  receipts: string;
  serial: string;
  page: string;
  of: string;
  empty: string;
  asOf: (day: string) => string;
  owner: (name: string) => string;
  generated: (who: string, when: string) => string;
  ratesOf: (days: string) => string;
  purchaseFallback: string;
  noMoney: string;
  incident: Record<IncidentKind, string>;
  police: (ref: string) => string;
  insurer: (ref: string) => string;
  occurred: (day: string) => string;
};

const EN: InsuranceWords = {
  title: 'Insurance report',
  totals: 'Totals by currency',
  converted: (ccy) => `In ${ccy}:`,
  subtotal: 'Subtotal',
  thing: 'Thing',
  purchase: 'Bought',
  value: 'Value now',
  receipts: 'Receipts',
  serial: 'Serial number',
  page: 'Page',
  of: 'of',
  empty: 'Nothing to list.',
  asOf: (day) => `As of ${day}`,
  owner: (name) => `Owner: ${name}`,
  generated: (who, when) => `Generated by ${who} · ${when}`,
  ratesOf: (days) => `at the rates of ${days}`,
  purchaseFallback: 'Things without a valuation count at their purchase price.',
  noMoney: 'Amounts are hidden for you in this location.',
  incident: {
    burglary: 'Burglary',
    fire: 'Fire',
    flood: 'Flood',
    loss: 'Loss',
    other: 'Incident',
  },
  police: (ref) => `Police reference: ${ref}`,
  insurer: (ref) => `Insurer reference: ${ref}`,
  occurred: (day) => `On ${day}`,
};

const AR: InsuranceWords = {
  title: 'تقرير التأمين',
  totals: 'الإجمالي حسب العملة',
  converted: (ccy) => `بعملة ${ccy}:`,
  subtotal: 'الإجمالي الفرعي',
  thing: 'الشيء',
  purchase: 'الشراء',
  value: 'القيمة الآن',
  receipts: 'الإيصالات',
  serial: 'الرقم التسلسلي',
  page: 'صفحة',
  of: 'من',
  empty: 'لا شيء لعرضه.',
  asOf: (day) => `حتى ${day}`,
  owner: (name) => `المالك: ${name}`,
  generated: (who, when) => `أنشأه ${who} · ${when}`,
  ratesOf: (days) => `بأسعار صرف ${days}`,
  purchaseFallback: 'الأشياء التي لا تقييم لها تُحسب بسعر شرائها.',
  noMoney: 'المبالغ مخفية عنك في هذا الموقع.',
  incident: {
    burglary: 'سطو',
    fire: 'حريق',
    flood: 'فيضان',
    loss: 'فقدان',
    other: 'حادث',
  },
  police: (ref) => `رقم محضر الشرطة: ${ref}`,
  insurer: (ref) => `رقم مطالبة التأمين: ${ref}`,
  occurred: (day) => `بتاريخ ${day}`,
};

export const insuranceWords = (locale: ReportLocale): InsuranceWords => (locale === 'ar' ? AR : EN);

// ---------------------------------------------------------------------------------------------
// The template's data
// ---------------------------------------------------------------------------------------------

export type InsuranceViewThing = {
  id: string;
  photo: string | null;
  name: string;
  brand: string;
  model: string;
  serial: string;
  status: string;
  purchasedOn: string;
  price: string;
  value: string;
  valuedOn: string;
  receipts: string;
  /** The thing's page in Kept, where its receipts are. */
  link: string;
};

export type InsuranceView = {
  lang: ReportLocale;
  dir: 'ltr' | 'rtl';
  pathSeparator: '›' | '‹';
  digits: 'latn' | 'arab';
  labels: Record<
    | 'title'
    | 'totals'
    | 'subtotal'
    | 'thing'
    | 'purchase'
    | 'value'
    | 'receipts'
    | 'serial'
    | 'page'
    | 'of'
    | 'empty',
    string
  >;
  scopeName: string;
  asOfLine: string;
  ownerLine: string;
  generatedBy: string;
  generatedLine: string;
  footer: string;
  incident: { title: string; lines: string[] } | null;
  totals: string[];
  convertedLabel: string;
  converted: string;
  moneyNote: string;
  places: { key: string; path: string[]; totals: string[]; things: InsuranceViewThing[] }[];
};

const intlLocale = (locale: ReportLocale) => (locale === 'ar' ? 'ar-EG' : 'en-GB');
const numbering = (locale: ReportLocale, digits: Digits) =>
  locale === 'ar' && digits === 'eastern' ? 'arab' : 'latn';

function safeTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

export type InsuranceViewContext = {
  /** KEPT_PUBLIC_URL without a trailing slash: the footer's host and the links into Kept. */
  publicUrl: string;
  now: Date;
  withPhoto: ReadonlySet<string>;
};

/** Builds insurance.typ's data: every string final, in the report's language and digits. */
export function buildInsuranceView(
  g: InsuranceGathered,
  options: Pick<InsuranceOptions, 'asOf' | 'reportCurrency' | 'locale' | 'digits'>,
  ctx: InsuranceViewContext,
): InsuranceView {
  const locale = options.locale;
  const w = insuranceWords(locale);
  const base = wordsFor(locale);
  const numberingSystem = numbering(locale, options.digits);
  const nf = new Intl.NumberFormat(intlLocale(locale), { numberingSystem });
  const date = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeZone: 'UTC',
    numberingSystem,
  });
  const day = (d: string) => date.format(new Date(`${d}T00:00:00Z`));
  const when = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: safeTimeZone(g.requesterTimezone),
    numberingSystem,
  }).format(ctx.now);
  const money = (amount: string, currency: string) =>
    formatMoney(amount, currency, { locale, digits: options.digits });
  const collate = new Intl.Collator(locale, { numeric: true }).compare;
  const pathSeparator = locale === 'ar' ? '‹' : '›';
  const list = (xs: string[]) => xs.join(locale === 'ar' ? '، ' : ', ');

  const groups = new Map<string, { path: string[]; text: string; things: InsuranceThing[] }>();
  for (const t of g.things) {
    const steps = t.path
      .map((s) => (s.isUnplaced ? base.unplaced : (s.name ?? '')))
      .filter((s) => s !== '');
    const key = t.path.at(-1)?.id ?? '';
    let group = groups.get(key);
    if (!group) {
      group = { path: steps, text: steps.join(` ${pathSeparator} `), things: [] };
      groups.set(key, group);
    }
    group.things.push(t);
  }

  const places = [...groups.entries()]
    .sort(([, a], [, b]) => collate(a.text, b.text))
    .map(([key, group]) => {
      const things = [...group.things].sort(
        (a, b) => collate(a.name, b.name) || (a.id < b.id ? -1 : 1),
      );
      return {
        key,
        path: group.path,
        totals: g.moneyShown ? totalsOf(things).map(([c, v]) => money(v, c)) : [],
        things: things.map(
          (t): InsuranceViewThing => ({
            id: t.id,
            photo: ctx.withPhoto.has(t.id) ? `/thumbs/${t.id}.jpg` : null,
            name: t.name,
            brand: t.brand ?? '',
            model: t.model ?? '',
            serial: t.serial ?? '',
            status: t.trashed
              ? base.trashed
              : t.lifecycle !== 'in_use'
                ? (base.lifecycle[t.lifecycle as keyof typeof base.lifecycle] ?? '')
                : '',
            purchasedOn: t.purchasedOn ? day(t.purchasedOn) : '',
            price: t.price !== null && t.priceCurrency ? money(t.price, t.priceCurrency) : '',
            value: t.value !== null && t.valueCurrency ? money(t.value, t.valueCurrency) : '',
            valuedOn: t.valuedOn ? day(t.valuedOn) : '',
            receipts: g.moneyShown ? nf.format(t.receipts) : '',
            link: `${ctx.publicUrl}/t/${t.id}`,
          }),
        ),
      };
    });

  const totals = g.moneyShown ? totalsOf(g.things) : [];
  let converted = '';
  let convertedLabel = '';
  if (options.reportCurrency && totals.length > 0) {
    const c = convertedTotal(totals, options.reportCurrency, options.asOf, g.rates);
    if (c) {
      convertedLabel = w.converted(options.reportCurrency);
      converted = money(c.amount, options.reportCurrency);
      if (c.rateDates.length > 0) converted += ` (${w.ratesOf(list(c.rateDates.map(day)))})`;
    }
  }
  const fallback = g.things.some((t) => t.value === null && t.price !== null);
  const incident = g.incident
    ? {
        title: w.incident[g.incident.kind],
        lines: [
          w.occurred(day(g.incident.occurredOn)),
          ...(g.incident.policeReference ? [w.police(g.incident.policeReference)] : []),
          ...(g.incident.insurerReference ? [w.insurer(g.incident.insurerReference)] : []),
        ],
      }
    : null;
  let host = '';
  try {
    host = new URL(ctx.publicUrl).host;
  } catch {
    host = '';
  }
  return {
    lang: locale,
    dir: locale === 'ar' ? 'rtl' : 'ltr',
    pathSeparator,
    digits: numberingSystem,
    labels: {
      title: w.title,
      totals: w.totals,
      subtotal: w.subtotal,
      thing: w.thing,
      purchase: w.purchase,
      value: w.value,
      receipts: w.receipts,
      serial: w.serial,
      page: w.page,
      of: w.of,
      empty: w.empty,
    },
    scopeName: g.location.name,
    asOfLine: w.asOf(day(options.asOf)),
    ownerLine: g.ownerName ? w.owner(g.ownerName) : '',
    generatedBy: g.requesterName,
    generatedLine: w.generated(g.requesterName, when),
    footer: ['Kept', host, when].filter((x) => x !== '').join(' · '),
    incident,
    totals: totals.map(([c, v]) => money(v, c)),
    convertedLabel,
    converted,
    moneyNote: !g.moneyShown ? w.noMoney : fallback ? w.purchaseFallback : '',
    places,
  };
}

// ---------------------------------------------------------------------------------------------
// CSV (D169)
// ---------------------------------------------------------------------------------------------

const CSV_COLUMNS = [
  'id',
  'short_id',
  'name',
  'brand',
  'model',
  'serial',
  'place',
  'lifecycle',
  'quantity',
] as const;
const CSV_MONEY_COLUMNS = [
  'purchased_on',
  'price',
  'price_currency',
  'value',
  'value_currency',
  'valued_on',
  'receipts',
] as const;

/** One row per thing, formula-safe cells (@kept/shared safeCsvCell, D169), money columns only
 * when the gate shows money. Canonical amounts and ISO dates: a spreadsheet reads them as
 * numbers. */
export function insuranceCsv(g: InsuranceGathered): string {
  const header = [...CSV_COLUMNS, ...(g.moneyShown ? CSV_MONEY_COLUMNS : [])];
  const things = [...g.things].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : 1,
  );
  const lines = things.map((t) =>
    [
      t.id,
      t.shortCode ?? '',
      t.name,
      t.brand ?? '',
      t.model ?? '',
      t.serial ?? '',
      t.path.map((s) => s.name ?? '').join(' > '),
      t.trashed ? 'trashed' : t.lifecycle,
      t.quantity,
      ...(g.moneyShown
        ? [
            t.purchasedOn ?? '',
            t.price ?? '',
            t.priceCurrency ?? '',
            t.value ?? '',
            t.valueCurrency ?? '',
            t.valuedOn ?? '',
            t.receipts,
          ]
        : []),
    ]
      .map(safeCsvCell)
      .join(','),
  );
  return `${[header.join(','), ...lines].join('\r\n')}\r\n`;
}
