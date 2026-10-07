import { describe, expect, it } from 'vitest';
import { type CurrencyContext, type CurrencyMatch, mapCurrencyMark } from './currency-marks.js';

const eg: CurrencyContext = { languages: ['ar', 'en'], vendorCountry: 'EG' };
const plain: CurrencyContext = { languages: ['en'] };

describe('mapCurrencyMark (§2.1 currency rule, D136, D189)', () => {
  const rows: Array<[string, CurrencyContext, CurrencyMatch | null]> = [
    // A bare dollar always waits, with no preselection (D189), wherever the receipt is from.
    ['$', plain, { ambiguous: ['USD', 'CAD'] }],
    ['$', { languages: ['en'], vendorCountry: 'US' }, { ambiguous: ['USD', 'CAD'] }],
    [' $ ', eg, { ambiguous: ['USD', 'CAD'] }],
    ['دولار', eg, { ambiguous: ['USD', 'CAD'] }],
    ['US$', plain, { code: 'USD' }],
    ['USD', plain, { code: 'USD' }],
    ['C$', plain, { code: 'CAD' }],
    ['CA$', plain, { code: 'CAD' }],
    ['cad', plain, { code: 'CAD' }],
    // The pound: GBP only with a British hint.
    ['£', plain, { ambiguous: ['GBP', 'EGP'] }],
    ['£', eg, { ambiguous: ['GBP', 'EGP'] }],
    ['£', { languages: ['en'], vendorCountry: 'GB' }, { code: 'GBP' }],
    ['£', { languages: ['en'], addressText: '10 High St, London SW1A 1AA' }, { code: 'GBP' }],
    ['£', { languages: ['en'], addressText: 'Tel +44 20 7946 0000' }, { code: 'GBP' }],
    ['£', { languages: ['en'], addressText: 'VAT Reg No 123 4567 89' }, { code: 'GBP' }],
    ['£', { languages: ['en'], addressText: 'Corner Shop Ltd' }, { code: 'GBP' }],
    ['£', { languages: ['en-GB'] }, { code: 'GBP' }],
    ['GBP', plain, { code: 'GBP' }],
    ['جنيه إسترليني', eg, { code: 'GBP' }],
    // Egyptian pounds, Latin and Arabic marks.
    ['E£', eg, { code: 'EGP' }],
    ['LE', eg, { code: 'EGP' }],
    ['L.E.', eg, { code: 'EGP' }],
    ['L.E', plain, { code: 'EGP' }],
    ['EGP', plain, { code: 'EGP' }],
    ['ج.م', eg, { code: 'EGP' }],
    ['ج.م.', eg, { code: 'EGP' }],
    ['جنيه', eg, { code: 'EGP' }],
    ['جنيه مصري', eg, { code: 'EGP' }],
    // Euro.
    ['€', plain, { code: 'EUR' }],
    ['EUR', plain, { code: 'EUR' }],
    ['يورو', eg, { code: 'EUR' }],
    // Other ISO codes only when enabled on the instance (D168).
    ['SAR', { languages: ['ar'], enabled: ['EGP', 'SAR'] }, { code: 'SAR' }],
    ['SAR', plain, null],
    ['XYZ', { languages: ['en'], enabled: ['XYZ'] }, null],
    // Unknown marks give nothing to suggest.
    ['¥', plain, null],
    ['', plain, null],
    ['Total', plain, null],
  ];

  it('has at least 30 rows, some of them Arabic', () => {
    expect(rows.length).toBeGreaterThanOrEqual(30);
    expect(rows.filter(([seen]) => /[؀-ۿ]/.test(seen)).length).toBeGreaterThanOrEqual(6);
  });

  it.each(rows)('%j in %j → %j', (seen, ctx, expected) => {
    expect(mapCurrencyMark(seen, ctx)).toEqual(expected);
  });
});
