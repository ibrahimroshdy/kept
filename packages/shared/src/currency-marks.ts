/**
 * From the currency mark printed on a receipt to an ISO code (engineering spec §2.1's currency
 * rule; D136, D168, D189). The model returns what it saw (`$`, `E£`, `ج.م`, `EUR`…) and this
 * decides. Unambiguous marks map directly. A bare `$` always waits for the person, with no
 * preselection (D189). A bare `£` is GBP only when something on the receipt is British;
 * otherwise it waits between GBP and EGP, since Egyptian receipts print `£` too.
 */

import { ISO_CURRENCIES, SUPPORTED_DEFAULT } from './currencies.js';

export type CurrencyContext = {
  /** ISO 3166 alpha-2 of the vendor, when known. */
  vendorCountry?: string;
  /** The printed vendor address, phone and footer, as read. */
  addressText?: string;
  /** The location's languages (BCP 47), e.g. `['ar', 'en']`. */
  languages: readonly string[];
  /** Currencies enabled on the instance (D168); defaults to the five of D136. */
  enabled?: readonly string[];
};

export type CurrencyMatch = { code: string } | { ambiguous: string[] };

/** Latin marks, upper-cased with spaces and dots removed. */
const LATIN: Readonly<Record<string, string>> = Object.freeze({
  US$: 'USD',
  USD: 'USD',
  C$: 'CAD',
  CA$: 'CAD',
  CAD: 'CAD',
  GBP: 'GBP',
  'E£': 'EGP',
  LE: 'EGP',
  EGP: 'EGP',
  '€': 'EUR',
  EUR: 'EUR',
});

/** Arabic marks, with spaces, dots and alef variants folded. */
const ARABIC: Readonly<Record<string, string>> = Object.freeze({
  جم: 'EGP',
  جنيه: 'EGP',
  جنيهمصري: 'EGP',
  جنيهات: 'EGP',
  جنيهاسترليني: 'GBP',
  دولارامريكي: 'USD',
  دولاركندي: 'CAD',
  يورو: 'EUR',
});

const UK_POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i;

function britishHint(ctx: CurrencyContext): boolean {
  const country = ctx.vendorCountry?.toUpperCase();
  if (country === 'GB' || country === 'UK') return true;
  if (ctx.languages.some((l) => /^en-GB$/i.test(l))) return true;
  const text = ctx.addressText ?? '';
  return (
    UK_POSTCODE.test(text) ||
    /\+\s?44\b/.test(text) ||
    /\bVAT\s*Reg/i.test(text) ||
    /\bLtd\b/i.test(text)
  );
}

/**
 * The code for a printed mark, the choices to offer when it is ambiguous, or null when the
 * mark means nothing here (the inbox then asks with no suggestion).
 */
export function mapCurrencyMark(seen: string, ctx: CurrencyContext): CurrencyMatch | null {
  const latin = seen.toUpperCase().replace(/[\s.]/g, '');
  if (!latin) return null;
  if (latin === '$') return { ambiguous: ['USD', 'CAD'] };
  if (latin === '£') return britishHint(ctx) ? { code: 'GBP' } : { ambiguous: ['GBP', 'EGP'] };
  const fromLatin = LATIN[latin];
  if (fromLatin) return { code: fromLatin };

  const arabic = latin.replace(/[أإآ]/g, 'ا');
  if (arabic === 'دولار') return { ambiguous: ['USD', 'CAD'] };
  const fromArabic = ARABIC[arabic];
  if (fromArabic) return { code: fromArabic };

  if (/^[A-Z]{3}$/.test(latin)) {
    const enabled: readonly string[] = ctx.enabled ?? SUPPORTED_DEFAULT;
    const known = ISO_CURRENCIES.some((c) => c.code === latin);
    if (known && enabled.includes(latin)) return { code: latin };
  }
  return null;
}
