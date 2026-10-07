/**
 * Lingui (D96): ICU messages, PO catalogues in src/locales/<locale>/messages.po, compiled on
 * import by @lingui/vite-plugin. `pnpm --filter @kept/web i18n:extract` refreshes the catalogues.
 */
import { i18n, type Messages } from '@lingui/core';
import { localiseSeparators } from '@/lib/format';
import { type Digits, formatLocale, type Locale } from '@/lib/prefs';

const loaders: Record<Locale, () => Promise<{ messages: Messages }>> = {
  en: () => import('../locales/en/messages.po'),
  ar: () => import('../locales/ar/messages.po'),
  fr: () => import('../locales/fr/messages.po'),
  de: () => import('../locales/de/messages.po'),
  it: () => import('../locales/it/messages.po'),
};

/**
 * `locales` carries the digit choice (D143) into Lingui's own number, date and plural `#`
 * formatting, so `plural(n, …)` in Arabic shows ٣ or 3 as the person chose.
 */
export async function activateLocale(locale: Locale, digits: Digits = 'eastern'): Promise<void> {
  const { messages } = await loaders[locale]();
  i18n.loadAndActivate({
    locale,
    locales: [formatLocale(locale, digits)],
    messages: localiseSeparators(messages, locale),
  });
}

export { i18n };
