/** Words for warranty kinds and terms (D53, D55), shared by the list, the sheet and claims. */
import type { WarrantyKind } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';

export function useWarrantyKindLabels(): Record<WarrantyKind, string> {
  const { t } = useLingui();
  return {
    manufacturer: t`Manufacturer warranty`,
    extended: t`Extended warranty`,
    store: t`Store warranty`,
    credit_card: t`Credit card cover`,
    insurance: t`Insurance`,
  };
}

/** "2 years", "18 months", "1 year": a term as people say it. */
export function useTermText() {
  // Subscribes to the language, so the term re-renders when it changes.
  const { i18n } = useLingui();
  void i18n;
  return (months: number): string =>
    months % 12 === 0
      ? plural(months / 12, { one: '# year', other: '# years' })
      : plural(months, { one: '# month', other: '# months' });
}
