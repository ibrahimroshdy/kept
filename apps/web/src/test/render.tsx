/**
 * Render inside the app's providers, in English (LTR) or Arabic (RTL), with the document's
 * lang/dir set the way the pre-paint script sets them.
 */
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { expect } from 'vitest';
import { AppProviders } from '@/app-providers';
import { activateLocale } from '@/i18n/i18n';
import { directionOf, type Locale } from '@/lib/prefs';

export async function renderUI(ui: ReactElement, { locale = 'en' }: { locale?: Locale } = {}) {
  await activateLocale(locale);
  document.documentElement.lang = locale;
  document.documentElement.dir = directionOf(locale);
  const user = userEvent.setup();
  const result = render(<AppProviders locale={locale}>{ui}</AppProviders>);
  return { user, ...result };
}

// Tailwind utilities that set a physical side. Logical ones (ms-, pe-, start-, end-,
// border-s, rounded-e, text-start) mirror in RTL; these don't. Same rule as
// scripts/check-logical-css.mjs, applied to what actually rendered.
const PHYSICAL =
  /(^|[\s:])-?(ml|mr|pl|pr|left|right|border-l|border-r|rounded-l|rounded-r|rounded-tl|rounded-tr|rounded-bl|rounded-br|scroll-ml|scroll-mr|scroll-pl|scroll-pr)-|(^|[\s:])(text-left|text-right|float-left|float-right)(\s|$)/; // logical-css-ignore: the list itself

export function expectLogicalOnly(root: ParentNode = document.body) {
  const offenders: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>('[class]')) {
    const cls = el.getAttribute('class') ?? '';
    if (PHYSICAL.test(cls)) offenders.push(cls);
  }
  expect(offenders).toEqual([]);
}
