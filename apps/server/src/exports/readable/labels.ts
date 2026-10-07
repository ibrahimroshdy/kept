import type { Condition, Lifecycle } from '@kept/shared';
import { wordsFor } from '../../reports/labels.js';

// The readable copy's words (D159; plan T13, Q12). Like the inventory report it carries (D201),
// it is written in English or Arabic: an export asked for in another language reads in English.
// The Arabic follows the report's (reports/labels.ts), which follows the web catalogue.

export type ReadableLocale = 'en' | 'ar';

export const readableLocaleOf = (locale: string | null | undefined): ReadableLocale =>
  (locale ?? '').slice(0, 2).toLowerCase() === 'ar' ? 'ar' : 'en';

export type ReadableWords = {
  title: string;
  intro: string;
  exported: (when: string) => string;
  places: string;
  things: string;
  thingCount: (n: number, formatted: string) => string;
  unplaced: string;
  trashed: string;
  photo: string;
  name: string;
  shortId: string;
  type: string;
  brandModel: string;
  serial: string;
  quantity: string;
  condition: string;
  tags: string;
  lastSeen: string;
  bought: string;
  files: string;
  inside: string;
  ownPage: string;
  spreadsheets: string;
  pdf: string;
  pdfLeftOut: (max: string) => string;
  pdfFailed: string;
  moneyHidden: string;
  empty: string;
  fileRole: Record<string, string>;
  conditions: Record<Condition, string>;
  lifecycles: Record<Exclude<Lifecycle, 'in_use'>, string>;
};

const EN: Omit<ReadableWords, 'thingCount' | 'unplaced' | 'trashed' | 'serial' | 'bought'> = {
  title: 'Readable copy',
  intro:
    'Everything in this location as Kept held it. It opens with nothing but a browser: photos, receipts and documents open from the files beside it.',
  exported: (when) => `Exported ${when}`,
  places: 'Places',
  things: 'Things',
  photo: 'Photo',
  name: 'Name',
  shortId: 'Short ID',
  type: 'Type',
  brandModel: 'Brand and model',
  quantity: 'Quantity',
  condition: 'Condition',
  tags: 'Tags',
  lastSeen: 'Last seen',
  files: 'Files',
  inside: 'Inside',
  ownPage: 'On its own page',
  spreadsheets: 'Spreadsheets (CSV)',
  pdf: 'Inventory report (PDF)',
  pdfLeftOut: (max) =>
    `The inventory report (PDF) was left out: it holds at most ${max} things. Every thing is listed below and in things.csv.`,
  pdfFailed: 'The inventory report (PDF) could not be made this time. Every thing is listed below.',
  moneyHidden: 'Prices are left out: they are hidden from the person who exported this.',
  empty: 'Nothing here.',
  fileRole: {
    photo: 'Photo',
    receipt: 'Receipt',
    invoice: 'Invoice',
    manual: 'Manual',
    warranty_doc: 'Warranty',
    proof: 'Proof',
    condition_out: 'Condition when lent',
    condition_in: 'Condition when returned',
    registration: 'Registration',
    document: 'Document',
  },
  conditions: { new: 'New', good: 'Good', fair: 'Fair', poor: 'Poor', broken: 'Broken' },
  lifecycles: {
    sold: 'Sold',
    given_away: 'Given away',
    lost: 'Lost',
    disposed: 'Disposed of',
    stolen: 'Stolen',
    destroyed: 'Destroyed',
    returned_to_owner: 'Returned to its owner',
  },
};

const AR: typeof EN = {
  title: 'نسخة مقروءة',
  intro:
    'كل ما في هذا الموقع كما حفظه Kept. تُفتح بالمتصفح وحده: الصور والإيصالات والمستندات تُفتح من الملفات التي بجانبها.',
  exported: (when) => `صُدّرت في ${when}`,
  places: 'الأماكن',
  things: 'الأشياء',
  photo: 'صورة',
  name: 'الاسم',
  shortId: 'المعرّف القصير',
  type: 'النوع',
  brandModel: 'العلامة والطراز',
  quantity: 'الكمية',
  condition: 'الحالة',
  tags: 'الوسوم',
  lastSeen: 'آخر مرة شوهد',
  files: 'الملفات',
  inside: 'داخل',
  ownPage: 'في صفحة خاصة',
  spreadsheets: 'جداول البيانات (CSV)',
  pdf: 'تقرير الجرد (PDF)',
  pdfLeftOut: (max) =>
    `لم يُضمَّن تقرير الجرد (PDF): يتسع لـ ${max} شيء على الأكثر. كل الأشياء مدرجة أدناه وفي things.csv.`,
  pdfFailed: 'تعذّر إنشاء تقرير الجرد (PDF) هذه المرة. كل الأشياء مدرجة أدناه.',
  moneyHidden: 'الأسعار غير مضمّنة: إنها مخفية عن الشخص الذي صدّر هذه النسخة.',
  empty: 'لا شيء هنا.',
  fileRole: {
    photo: 'صورة',
    receipt: 'إيصال',
    invoice: 'فاتورة',
    manual: 'دليل',
    warranty_doc: 'ضمان',
    proof: 'إثبات',
    condition_out: 'الحالة عند الإعارة',
    condition_in: 'الحالة عند الإرجاع',
    registration: 'رخصة',
    document: 'مستند',
  },
  conditions: { new: 'جديد', good: 'جيد', fair: 'مقبول', poor: 'سيئ', broken: 'معطوب' },
  lifecycles: {
    sold: 'بِيع',
    given_away: 'أُهدي',
    lost: 'مفقود',
    disposed: 'تم التخلص منه',
    stolen: 'سُرق',
    destroyed: 'أُتلف',
    returned_to_owner: 'أُعيد إلى مالكه',
  },
};

export function readableWords(locale: ReadableLocale): ReadableWords {
  const report = wordsFor(locale);
  return {
    ...(locale === 'ar' ? AR : EN),
    thingCount: report.thingCount,
    unplaced: report.unplaced,
    trashed: report.trashed,
    serial: report.serial,
    bought: report.bought,
  };
}
