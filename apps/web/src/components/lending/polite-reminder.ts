/**
 * "Copy a polite reminder" (D57): a short, friendly message in the reader's language, for them to
 * send however they like. Kept never sends it. It names the thing, when it was lent and, when the
 * loan is overdue, the day it was due back; nothing else about the household.
 */
import { useLingui } from '@lingui/react/macro';
import type { LoanRow } from '@/api/household/types';
import { useFormat } from '@/lib/format';

/** What the reminder reads from a loan: a list row, or a loan and its thing's name (T24's centre). */
export type ReminderLoan = Pick<LoanRow, 'person' | 'startedAt' | 'overdue' | 'dueOn'> & {
  thing: { name: string | null };
};

export function usePoliteReminder() {
  const { t } = useLingui();
  const f = useFormat();
  return (loan: ReminderLoan): string => {
    const person = loan.person.name;
    const thing = loan.thing.name ?? t`the thing`;
    const since = f.day(loan.startedAt);
    if (loan.overdue && loan.dueOn) {
      const due = f.day(loan.dueOn);
      return t`Hi ${person}, a friendly reminder about the ${thing} I lent you on ${since}. It was due back on ${due}. Could you bring it back when you can? Thank you!`;
    }
    return t`Hi ${person}, a friendly reminder about the ${thing} I lent you on ${since}. Could you bring it back when you're done with it? Thank you!`;
  };
}
