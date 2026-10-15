/**
 * The spreadsheet's words (1.x, D250): each column's header, and the reader's words for the
 * thing form's checks.
 */
import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';
import type { ColumnId, Messages } from './model';

export function useColumnLabels(): Record<ColumnId, string> {
  const { t } = useLingui();
  return useMemo(
    () => ({
      name: t`Name`,
      place: t`Where`,
      shortCode: t`Short ID`,
      type: t`Type`,
      brand: t`Brand`,
      model: t`Model`,
      serial: t`Serial number`,
      quantity: t`Quantity`,
      tags: t`Tags`,
      purchasedOn: t`Bought`,
      price: t`Price`,
      warranty: t`Warranty ends`,
      condition: t`Condition`,
      colour: t`Colour`,
      barcode: t`Barcode`,
      belongsTo: t`Belongs to`,
      expiresOn: t`Expires`,
      notes: t`Notes`,
      lastSeen: t`Last seen`,
      updated: t`Changed`,
    }),
    [t],
  );
}

export function useSheetMessages(): Messages {
  const { t } = useLingui();
  return useMemo(
    () => ({
      nameRequired: t`A thing needs a name.`,
      tooLong: (max: number) => t`At most ${max} characters.`,
      quantity: t`Enter a whole number, 0 or more.`,
      quantityFixed: t`This one is counted one by one: its quantity stays 1.`,
    }),
    [t],
  );
}
