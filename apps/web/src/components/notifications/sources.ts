/**
 * The records behind a reminder, read when an inline action needs them (plan T24; step-4 Q32:
 * every action goes through the source's own route). A notification carries only ids, so
 * Complete and Snooze read the schedule from its thing's or place's schedules, and Mark returned
 * and the polite reminder read the loan from its thing's loans: the same queries the thing page
 * uses, so what they fetch is shared.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { householdApi, householdKeys } from '@/api/household/queries';
import type { Loan, Notification, Schedule } from '@/api/household/types';

type Reminder = NonNullable<Notification['reminder']>;

export class SourceGone extends Error {
  constructor() {
    super('The record behind this notification is gone.');
  }
}

export function useReminderSources() {
  const qc = useQueryClient();
  const schedule = useCallback(
    async (r: Reminder): Promise<Schedule> => {
      const { subject } = r;
      if (subject.type === 'location') throw new SourceGone();
      const res =
        subject.type === 'thing'
          ? await qc.fetchQuery({
              queryKey: householdKeys.schedules.thing(subject.id),
              queryFn: () => householdApi.thingSchedules(subject.id),
              staleTime: 0,
            })
          : await qc.fetchQuery({
              queryKey: householdKeys.schedules.place(subject.id),
              queryFn: () => householdApi.placeSchedules(subject.id),
              staleTime: 0,
            });
      const found = res.items.find((s) => s.id === r.sourceId);
      if (!found) throw new SourceGone();
      return found;
    },
    [qc],
  );
  const loan = useCallback(
    async (r: Reminder): Promise<Loan> => {
      if (r.subject.type !== 'thing') throw new SourceGone();
      const thingId = r.subject.id;
      const res = await qc.fetchQuery({
        queryKey: householdKeys.loans.thing(thingId),
        queryFn: () => householdApi.thingLoans(thingId),
        staleTime: 0,
      });
      const found = res.items.find((l) => l.id === r.sourceId);
      if (!found) throw new SourceGone();
      return found;
    },
    [qc],
  );
  return { schedule, loan };
}
