// SPIKE (step 5, T0, V38). The Corolla's last six months, and the formatters the app would use
// (Intl in the reader's language and digits; ar-EG gives Eastern Arabic digits).
export type Lang = 'en' | 'ar';
export const KEYS = ['fuel', 'service', 'fees'] as const;
export type Key = (typeof KEYS)[number];
export type Row = { month: string } & Record<Key, number>;

export const COSTS: Row[] = [
  { month: '2026-04', fuel: 2140, service: 0, fees: 380 },
  { month: '2026-05', fuel: 1980, service: 3450, fees: 0 },
  { month: '2026-06', fuel: 2310, service: 0, fees: 6200 },
  { month: '2026-07', fuel: 2650, service: 850, fees: 0 },
  { month: '2026-08', fuel: 2490, service: 0, fees: 0 },
  { month: '2026-09', fuel: 1720, service: 5100, fees: 250 },
];

export type Reading = { date: string; km: number; estimate?: boolean };
/** Month-end odometer readings, then the estimate for today + 30 days (dashed). */
export const READINGS: Reading[] = [
  { date: '2026-04-28', km: 84210 },
  { date: '2026-05-30', km: 85390 },
  { date: '2026-06-27', km: 86650 },
  { date: '2026-07-31', km: 88120 },
  { date: '2026-08-29', km: 89310 },
  { date: '2026-09-26', km: 90440 },
  { date: '2026-10-30', km: 91790, estimate: true },
];

export function fmt(lang: Lang) {
  const locale = lang === 'ar' ? 'ar-EG' : 'en-GB';
  const n = new Intl.NumberFormat(locale);
  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EGP',
    maximumFractionDigits: 0,
  });
  const month = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' });
  const monthYear = new Intl.DateTimeFormat(locale, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const compact = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 });
  return {
    num: (v: number) => n.format(v),
    km: (v: number) => (lang === 'ar' ? `${n.format(v)} كم` : `${n.format(v)} km`),
    money: (v: number) => money.format(v),
    compact: (v: number) => compact.format(v),
    month: (m: string) => month.format(new Date(`${m}-15T00:00:00Z`)),
    monthYear: (m: string) => monthYear.format(new Date(`${m}-15T00:00:00Z`)),
    day: (d: string) => day.format(new Date(`${d}T00:00:00Z`)),
  };
}

export const L = {
  en: {
    costs: 'Costs by month',
    odo: 'Odometer',
    fuel: 'Fuel',
    service: 'Service and parts',
    fees: 'Fees and insurance',
    total: 'Total',
    month: 'Month',
    date: 'Date',
    reading: 'Reading',
    estimated: 'Estimated',
    showTable: 'Show as table',
    hideTable: 'Hide table',
    costsChart: 'Costs by month, stacked by category. Arrow keys move between bars.',
    odoChart: 'Odometer readings with an estimate. Arrow keys move between points.',
  },
  ar: {
    costs: 'التكاليف شهريًا',
    odo: 'العداد',
    fuel: 'الوقود',
    service: 'الصيانة وقطع الغيار',
    fees: 'الرسوم والتأمين',
    total: 'الإجمالي',
    month: 'الشهر',
    date: 'التاريخ',
    reading: 'القراءة',
    estimated: 'تقديري',
    showTable: 'اعرض كجدول',
    hideTable: 'أخفِ الجدول',
    costsChart: 'التكاليف شهريًا، مكدّسة حسب الفئة. تنقّل بين الأعمدة بمفاتيح الأسهم.',
    odoChart: 'قراءات العداد مع تقدير. تنقّل بين النقاط بمفاتيح الأسهم.',
  },
} as const;
