import { describe, expect, it } from 'vitest';
import { safeName } from './claim-pack.js';
import { expiredPage, langOf, packDay } from './download.js';
import { convertedTotal, missingRates } from './report.js';

// Step 4, T18: the claim pack's and the insurance report's pure parts.

describe('langOf() (the expired page, engineering spec §5)', () => {
  it.each([
    [undefined, 'en'],
    ['', 'en'],
    ['ar-EG,ar;q=0.9,en;q=0.5', 'ar'],
    ['de-CH', 'de'],
    ['ja,fr;q=0.8', 'fr'],
    ['en;q=0.2,it;q=0.9', 'it'],
    ['ar;q=0,fr', 'fr'],
    ['xx,yy', 'en'],
  ])('%s → %s', (header, lang) => {
    expect(langOf(header)).toBe(lang);
  });

  it('writes the page right to left in Arabic, escaped, and never indexed', () => {
    const page = expiredPage('ar');
    expect(page).toContain('<html lang="ar" dir="rtl">');
    expect(page).toContain('<meta name="robots" content="noindex">');
    expect(expiredPage('en')).toContain('<h1>This link has expired</h1>');
  });
});

describe('safeName() (ZIP entry names from what people typed)', () => {
  it.each([
    ['Television', 'Television'],
    ['../../etc/passwd', 'etc passwd'],
    ['a/b\\c:d*e?f"g<h>i|j', 'a b c d e f g h i j'],
    ['   ', 'thing'],
    ['...hidden', 'hidden'],
    ['تلفزيون الصالة', 'تلفزيون الصالة'],
    ['x'.repeat(80), 'x'.repeat(60)],
    ['tab\there\u0000nul', 'tab here nul'],
  ])('%j → %j', (input, output) => {
    expect(safeName(input, 'thing')).toBe(output);
  });
});

describe('packDay()', () => {
  it("reads a UUIDv7 run id's day", () => {
    // 0x019a1b2c3d4e ms = 2025-10-23 (UTC).
    expect(packDay('x/019a1b2c-3d4e-7000-8000-000000000000.zip')).toBe(
      new Date(0x019a1b2c3d4e).toISOString().slice(0, 10),
    );
  });
});

describe('the converted total (Q21: never chained, never estimated)', () => {
  const rates = [
    { fromCcy: 'USD', toCcy: 'EGP', rate: '48.5', validFrom: '2026-09-01' },
    { fromCcy: 'EGP', toCcy: 'EUR', rate: '0.018', validFrom: '2026-08-01' },
  ];
  const totals: [string, string][] = [
    ['EGP', '1000'],
    ['USD', '10'],
  ];

  it('converts each currency by its own pair, or the inverse, dated', () => {
    expect(convertedTotal(totals, 'EGP', '2026-09-30', rates)).toEqual({
      amount: '1485',
      rateDates: ['2026-09-01'],
    });
    // EUR → EGP has no pair of its own: the inverse of EGP → EUR, 1 / 0.018.
    expect(convertedTotal([['EUR', '18']], 'EGP', '2026-09-30', rates)).toEqual({
      amount: '1000',
      rateDates: ['2026-08-01'],
    });
  });

  it('lists the pairs with no rate on or before the day', () => {
    expect(missingRates(totals, 'EGP', '2026-08-31', rates)).toEqual([{ from: 'USD', to: 'EGP' }]);
    // USD → EUR would need a chain through EGP: missing.
    expect(missingRates(totals, 'EUR', '2026-09-30', rates)).toEqual([{ from: 'USD', to: 'EUR' }]);
    expect(convertedTotal(totals, 'EUR', '2026-09-30', rates)).toBeNull();
  });
});
