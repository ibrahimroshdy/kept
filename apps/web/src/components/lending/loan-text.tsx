/**
 * How a loan reads (D57): "With Murdock since 3 Oct · due 17 Oct" for a thing lent out, "From
 * Murdock since 10 Sep · due back 20 Oct" for one borrowed in, and copying T22's "polite
 * reminder", which Kept never sends (D57: Kept never messages people outside the household).
 */
import type { LoanDirection } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useCallback } from 'react';
import type { LoanRow } from '@/api/household/types';
import { daysBetween } from '@/components/schedules/access';
import { toast } from '@/components/ui/toast';
import { useFormat } from '@/lib/format';
import { usePoliteReminder } from './polite-reminder';

export type LoanLike = {
  direction: LoanDirection;
  personName: string;
  startedAt: string;
  dueOn: string | null;
};

export function useLoanText() {
  const { t } = useLingui();
  const fmt = useFormat();
  /**
   * The line the header and the loan panel show. The person's name is isolated (<bdi>), so a
   * Latin name in an Arabic sentence, or one ending in a neutral character, keeps its place
   * (UI step-4 review L9). The same messages as before: Lingui renders an element value.
   */
  const line = useCallback(
    (l: LoanLike): ReactNode => {
      const who = <bdi>{l.personName}</bdi>;
      const since = fmt.day(l.startedAt);
      const due = l.dueOn ? fmt.day(l.dueOn) : null;
      if (l.direction === 'out')
        return due ? (
          <Trans>
            With {who} since {since} · due {due}
          </Trans>
        ) : (
          <Trans>
            With {who} since {since}
          </Trans>
        );
      return due ? (
        <Trans>
          From {who} since {since} · due back {due}
        </Trans>
      ) : (
        <Trans>
          From {who} since {since}
        </Trans>
      );
    },
    [fmt],
  );
  /** "Due in 11 days", "Due today", "2 days overdue"; null without a due date. */
  const dueIn = useCallback(
    (dueOn: string | null, today: string): string | null => {
      if (!dueOn) return null;
      const n = daysBetween(today, dueOn);
      if (n === 0) return t`Due today`;
      if (n > 0) return plural(n, { one: 'Due in # day', other: 'Due in # days' });
      return plural(-n, { one: '# day overdue', other: '# days overdue' });
    },
    [t],
  );
  return { line, dueIn };
}

/**
 * Copies T22's polite reminder (./polite-reminder.ts, the same words as the Lending screen) for a
 * loan out; the person sends it themselves, if at all.
 */
export function useCopyPoliteReminder() {
  const { t } = useLingui();
  const reminder = usePoliteReminder();
  return useCallback(
    async (loan: LoanRow) => {
      const text = reminder(loan);
      try {
        await navigator.clipboard.writeText(text);
        toast({
          title: t`Reminder copied`,
          description: t`Send it however you like. Kept never sends it.`,
          tone: 'ok',
        });
      } catch {
        toast({
          title: t`Couldn't copy it. Here it is to copy by hand:`,
          description: text,
          tone: 'danger',
        });
      }
    },
    [reminder, t],
  );
}
