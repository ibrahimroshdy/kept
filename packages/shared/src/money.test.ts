import { describe, expect, it } from 'vitest';
import { ISO_CURRENCIES, minorUnits, SUPPORTED_DEFAULT } from './currencies.js';
import {
  AmountError,
  canonicalAmount,
  canonicalMoney,
  convert,
  type FxRate,
  formatAmount,
  formatMoney,
  parseAmount,
  roundForDisplay,
} from './money.js';

const LRI = '⁦';
const PDI = '⁩';
const RLM = '‏';
const NBSP = ' ';

describe('ISO_CURRENCIES', () => {
  it('lists every default currency with 2 minor units, and JPY with 0', () => {
    for (const code of SUPPORTED_DEFAULT) expect(minorUnits(code)).toBe(2);
    expect(minorUnits('JPY')).toBe(0);
    expect(minorUnits('KWD')).toBe(3);
  });

  it('has unique, well-formed codes', () => {
    const codes = ISO_CURRENCIES.map((c) => c.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of ISO_CURRENCIES) {
      expect(c.code).toMatch(/^[A-Z]{3}$/);
      expect([0, 2, 3, 4]).toContain(c.minorUnits);
    }
  });
});

describe('parseAmount', () => {
  it.each([
    ['1234.5', '1234.5'],
    ['1,234.50', '1234.5'],
    ['1,200', '1200'],
    ['0012.3400', '12.34'],
    ['0', '0'],
    ['0.0', '0'],
    ['.5', '0.5'],
    ['5.', '5'],
    ['  42  ', '42'],
    ['1234.5678', '1234.5678'],
    ['999999999999.9999', '999999999999.9999'],
    ['١٢٣٤٫٥', '1234.5'],
    ['١٬٢٠٠٫٥٠', '1200.5'],
    ['١,٢٠٠', '1200'],
    ['۱۲۳۴٫۵', '1234.5'],
    ['1٬234.5', '1234.5'],
  ])('%j → %j', (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    '-1',
    '+1',
    '1e5',
    '1E5',
    'abc',
    '1.23456',
    '1,23',
    '12,34,567',
    '1,234,56',
    '1.234,56',
    '1..2',
    '.',
    ',',
    '1 234',
    'NaN',
    'Infinity',
    '1000000000000',
    '٫',
  ])('rejects %j with invalid_amount', (input) => {
    expect(() => parseAmount(input)).toThrow(AmountError);
    try {
      parseAmount(input);
    } catch (e) {
      expect((e as AmountError).code).toBe('invalid_amount');
    }
  });

  it('is idempotent on its own output', () => {
    for (const s of ['1,234.50', '١٬٢٠٠٫٥٠', '.5', '007']) {
      const once = parseAmount(s);
      expect(parseAmount(once)).toBe(once);
    }
  });
});

describe('canonicalAmount: one form on the wire, whatever was stored (numeric(16,4) pads)', () => {
  it.each([
    ['150.0000', '150'],
    ['150', '150'],
    ['1250.5000', '1250.5'],
    ['0.0000', '0'],
    ['0.0500', '0.05'],
    ['000123.4500', '123.45'],
    ['999999999999.9999', '999999999999.9999'],
  ])('%s → %s', (stored, wire) => {
    expect(canonicalAmount(stored)).toBe(wire);
  });

  it('leaves null and what is not an amount alone, never throwing on output', () => {
    expect(canonicalAmount(null)).toBeNull();
    expect(canonicalAmount(undefined)).toBeNull();
    expect(canonicalAmount('-5.00')).toBe('-5.00');
    expect(canonicalAmount('n/a')).toBe('n/a');
  });

  it('canonicalMoney reaches amounts in {amount, currency} values and lists of them', () => {
    expect(canonicalMoney('3000.0000')).toBe('3000');
    expect(canonicalMoney({ amount: '12.5000', currency: 'EGP' })).toEqual({
      amount: '12.5',
      currency: 'EGP',
    });
    expect(canonicalMoney([{ amount: '1.10', currency: 'USD' }, null])).toEqual([
      { amount: '1.1', currency: 'USD' },
      null,
    ]);
    expect(canonicalMoney(42)).toBe(42);
    expect(canonicalMoney({ note: '1.00' })).toEqual({ note: '1.00' });
  });
});

describe('roundForDisplay (half away from zero, at the edges only: Q2)', () => {
  it.each([
    ['1.005', 2, '1.01'],
    ['1.004', 2, '1.00'],
    ['2.5', 0, '3'],
    ['3.5', 0, '4'],
    ['-2.5', 0, '-3'],
    ['-1.005', 2, '-1.01'],
    ['0.0049', 2, '0.00'],
    ['1200', 2, '1200.00'],
    ['1234.5678', 3, '1234.568'],
    ['9.995', 2, '10.00'],
    ['999999999999.9999', 2, '1000000000000.00'],
    ['12', 0, '12'],
  ])('roundForDisplay(%j, %i) = %j', (amount, units, expected) => {
    expect(roundForDisplay(amount, units)).toBe(expected);
  });

  it('never returns negative zero', () => {
    expect(roundForDisplay('-0.001', 2)).toBe('0.00');
  });
});

describe('formatMoney: five currencies × en/ar × western/eastern digits (D136, D143)', () => {
  const table: [string, string, 'western' | 'eastern', string][] = [
    ['USD', 'en', 'western', '$1,200.00'],
    ['CAD', 'en', 'western', 'CA$1,200.00'],
    ['GBP', 'en', 'western', '£1,200.00'],
    ['EUR', 'en', 'western', '€1,200.00'],
    ['EGP', 'en', 'western', `EGP${NBSP}1,200.00`],
    // English ignores the Eastern-digits setting: it is an Arabic-only preference (D143).
    ['USD', 'en', 'eastern', '$1,200.00'],
    ['CAD', 'en', 'eastern', 'CA$1,200.00'],
    ['GBP', 'en', 'eastern', '£1,200.00'],
    ['EUR', 'en', 'eastern', '€1,200.00'],
    ['EGP', 'en', 'eastern', `EGP${NBSP}1,200.00`],
    ['USD', 'ar', 'western', `${LRI}1,200.00${NBSP}US$${PDI}`],
    ['CAD', 'ar', 'western', `${LRI}1,200.00${NBSP}CA$${PDI}`],
    ['GBP', 'ar', 'western', `${LRI}1,200.00${NBSP}UK£${PDI}`],
    ['EUR', 'ar', 'western', `${LRI}1,200.00${NBSP}€${PDI}`],
    ['EGP', 'ar', 'western', `${LRI}1,200.00${NBSP}ج.م.${RLM}${PDI}`],
    ['USD', 'ar', 'eastern', `${LRI}١٬٢٠٠٫٠٠${NBSP}US$${PDI}`],
    ['CAD', 'ar', 'eastern', `${LRI}١٬٢٠٠٫٠٠${NBSP}CA$${PDI}`],
    ['GBP', 'ar', 'eastern', `${LRI}١٬٢٠٠٫٠٠${NBSP}UK£${PDI}`],
    ['EUR', 'ar', 'eastern', `${LRI}١٬٢٠٠٫٠٠${NBSP}€${PDI}`],
    ['EGP', 'ar', 'eastern', `${LRI}١٬٢٠٠٫٠٠${NBSP}ج.م.${RLM}${PDI}`],
  ];

  it.each(table)('%s in %s (%s)', (currency, locale, digits, expected) => {
    expect(formatMoney('1200', currency, { locale, digits })).toBe(expected);
  });

  it('never writes EGP as a bare £ in any locale', () => {
    for (const locale of ['en', 'en-GB', 'en-EG', 'fr', 'de', 'ar', 'ar-EG']) {
      const s = formatMoney('1200', 'EGP', { locale });
      expect(s).not.toMatch(/£/);
      expect(s).toMatch(/EGP|ج\.م\./);
    }
  });

  it('isolates Arabic-locale results left-to-right, with regional Arabic tags too', () => {
    const s = formatMoney('5', 'EGP', { locale: 'ar-EG', digits: 'western' });
    expect(s.startsWith(LRI) && s.endsWith(PDI)).toBe(true);
    expect(s).toBe(`${LRI}5.00${NBSP}ج.م.${RLM}${PDI}`);
  });

  it('rounds half away from zero to the minor units, without float drift', () => {
    expect(formatMoney('1.005', 'USD', { locale: 'en' })).toBe('$1.01');
    expect(formatMoney('0.125', 'EUR', { locale: 'en' })).toBe('€0.13');
    expect(formatMoney('1234.5', 'JPY', { locale: 'en' })).toBe('¥1,235');
    expect(formatMoney('123456789012.3456', 'USD', { locale: 'en' })).toBe('$123,456,789,012.35');
  });

  it('formats a negative total with the sign inside the isolate', () => {
    expect(formatMoney('-1200', 'USD', { locale: 'en' })).toBe('-$1,200.00');
    expect(formatMoney('-1200', 'USD', { locale: 'ar' })).toBe(`${LRI}-1,200.00${NBSP}US$${PDI}`);
  });

  it('defaults to English with Western digits', () => {
    expect(formatMoney('1200', 'GBP')).toBe('£1,200.00');
  });
});

describe('formatAmount (the number alone, for inputs) round-trips through parseAmount', () => {
  it.each([
    ['1200.5', 'en', 'western', '1,200.5'],
    ['1200.5', 'ar', 'eastern', '١٬٢٠٠٫٥'],
    ['1200.5', 'ar', 'western', '1,200.5'],
    ['0.0001', 'en', 'western', '0.0001'],
    ['999999999999.9999', 'ar', 'eastern', '٩٩٩٬٩٩٩٬٩٩٩٬٩٩٩٫٩٩٩٩'],
  ] as const)('%s in %s (%s)', (amount, locale, digits, expected) => {
    const shown = formatAmount(amount, { locale, digits });
    expect(shown).toBe(expected);
    expect(parseAmount(shown)).toBe(amount);
  });
});

describe('convert() (D76, D136; step-4 plan Q21)', () => {
  const rates: FxRate[] = [
    { fromCcy: 'USD', toCcy: 'EGP', rate: '48.5', validFrom: '2026-06-01' },
    { fromCcy: 'USD', toCcy: 'EGP', rate: '49.25', validFrom: '2026-09-01' },
    { fromCcy: 'EUR', toCcy: 'USD', rate: '1.1', validFrom: '2026-01-01' },
    { fromCcy: 'GBP', toCcy: 'EGP', rate: '65', validFrom: '2026-01-01' },
    { fromCcy: 'EGP', toCcy: 'GBP', rate: '0.0149', validFrom: '2026-09-01' },
  ];

  it('uses the newest rate on or before the day', () => {
    expect(convert('100', 'USD', 'EGP', '2026-09-30', rates)).toEqual({ amount: '4925' });
    expect(convert('100', 'USD', 'EGP', '2026-08-31', rates)).toEqual({ amount: '4850' });
    expect(convert('100', 'USD', 'EGP', '2026-09-01', rates)).toEqual({ amount: '4925' });
  });

  it('falls back to the inverse pair, rounding once to 4 decimals', () => {
    // 1000 EGP / 49.25 = 20.304568…
    expect(convert('1000', 'EGP', 'USD', '2026-09-30', rates)).toEqual({ amount: '20.3046' });
  });

  it('prefers the pair over a newer inverse', () => {
    expect(convert('10', 'GBP', 'EGP', '2026-09-30', rates)).toEqual({ amount: '650' });
  });

  it('never chains through a third currency, and never estimates', () => {
    expect(convert('10', 'EUR', 'EGP', '2026-09-30', rates)).toEqual({
      missing: { from: 'EUR', to: 'EGP' },
    });
    expect(convert('10', 'USD', 'EGP', '2026-05-31', rates)).toEqual({
      missing: { from: 'USD', to: 'EGP' },
    });
  });

  it('keeps the same currency as it is, canonical', () => {
    expect(convert('150.5000', 'EGP', 'EGP', '2026-09-30', [])).toEqual({ amount: '150.5' });
  });

  it('is exact: no floating point', () => {
    const r: FxRate[] = [{ fromCcy: 'USD', toCcy: 'EGP', rate: '0.1', validFrom: '2026-01-01' }];
    expect(convert('0.3', 'USD', 'EGP', '2026-09-30', r)).toEqual({ amount: '0.03' });
    const big: FxRate[] = [
      { fromCcy: 'USD', toCcy: 'EGP', rate: '48.12345678', validFrom: '2026-01-01' },
    ];
    // 123456789012.3456 × 48.12345678 = 5941167450233.192368…
    expect(convert('123456789012.3456', 'USD', 'EGP', '2026-09-30', big)).toEqual({
      amount: '5941167450233.1924',
    });
    // Half away from zero at the 4th decimal: 0.00005 × 1 → 0.0001.
    const one: FxRate[] = [{ fromCcy: 'USD', toCcy: 'EGP', rate: '0.5', validFrom: '2026-01-01' }];
    expect(convert('0.0001', 'USD', 'EGP', '2026-09-30', one)).toEqual({ amount: '0.0001' });
  });
});
