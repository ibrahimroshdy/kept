/**
 * Everything a screen needs above it: Lingui, React Aria's locale (which sets direction for
 * keyboard handling and popover placement), the confirm dialog and the toast region.
 */
import { I18nProvider as LinguiProvider } from '@lingui/react';
import type { ReactNode } from 'react';
import { I18nProvider as AriaI18nProvider } from 'react-aria-components';
import { ConfirmProvider } from '@/components/ui/confirm';
import { Toaster } from '@/components/ui/toast';
import { i18n } from '@/i18n/i18n';
import type { Locale } from '@/lib/prefs';

export function AppProviders({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <LinguiProvider i18n={i18n}>
      <AriaI18nProvider locale={locale}>
        <ConfirmProvider>
          {children}
          <Toaster />
        </ConfirmProvider>
      </AriaI18nProvider>
    </LinguiProvider>
  );
}
