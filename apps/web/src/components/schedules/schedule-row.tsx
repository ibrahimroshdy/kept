/**
 * One schedule in a list (plan T21; screens §5 Schedules): its name, what it's for (a link to the
 * thing or place, with its path), how often and when it was last done, and when it's next due as
 * a pill ("In 12 days", "3 days overdue", "At 60,000 km"), with a snooze or a skip said under it.
 *
 * Actions follow screens §3: hidden for a role that can't manage schedules (viewers), disabled
 * with the reason offline. Complete is the row's button; the rest (Snooze or Unsnooze, Skip once,
 * Log a service, Edit, Delete) are buttons from `md` and fold into **More** on a phone (the
 * inbox's bottom sheet), so no second row of controls. Every write but a new one offers Undo.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { householdApi } from '@/api/household/queries';
import type { Schedule } from '@/api/household/types';
import { useOfferUndo } from '@/components/history/undo';
import { CalendarIcon, WrenchIcon } from '@/components/icons';
import { type OverflowAction, OverflowActions } from '@/components/inbox/overflow-actions';
import { IconTile, useErrorText } from '@/components/page';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import { toast } from '@/components/ui/toast';
import { addressOf } from '@/lib/address';
import { sep, useFormat } from '@/lib/format';
import { useOnline } from '@/lib/online';
import { useInvalidateHousehold, useLocationAccess } from './access';
import { ScheduleStatePill, useScheduleText } from './labels';

export type ScheduleRowAction = 'complete' | 'snooze' | 'edit' | 'log';

export function ScheduleRowView({
  schedule: s,
  onOpen,
  showLocation,
  note,
}: {
  schedule: Schedule;
  /** Beside the due pill: a vehicle's "estimated ~14 Nov" (step 5, T18). */
  note?: ReactNode;
  /** Opens one of the sheets for this schedule (the page holds them). */
  onOpen: (action: ScheduleRowAction, schedule: Schedule) => void;
  /** The location's name, where the list spans several. */
  showLocation?: string | undefined;
}) {
  const { t } = useLingui();
  const text = useScheduleText();
  const f = useFormat();
  const access = useLocationAccess()(s.locationId);
  const offerUndo = useOfferUndo();
  const invalidate = useInvalidateHousehold();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const online = useOnline();
  const canManage = access.can('schedules-claims.manage');
  const thingId = s.subject.type === 'thing' ? s.subject.id : undefined;
  const undoOpts = thingId ? { thingId } : {};
  const held = text.held(s);
  const last = text.last(s);
  const recurring = s.everyMonths != null || s.everyUnits != null;
  const snoozed = !!(s.snoozedUntil || s.snoozedUntilValue);

  const run = async (
    write: () => Promise<{ auditEvents: string[] }>,
    title: string,
    failed: string,
  ) => {
    try {
      const { auditEvents } = await write();
      offerUndo({ title }, auditEvents, undoOpts);
      await invalidate();
    } catch (e) {
      toast({ title: failed, description: errorText(e), tone: 'danger' });
    }
  };

  const actions: OverflowAction[] = canManage
    ? [
        snoozed
          ? {
              id: 'unsnooze',
              label: t`Unsnooze`,
              onAction: () =>
                void run(
                  () => householdApi.unsnoozeSchedule(s.id, s.rowVersion),
                  t`Unsnoozed ${s.name}`,
                  t`Couldn't unsnooze it`,
                ),
            }
          : { id: 'snooze', label: t`Snooze`, onAction: () => onOpen('snooze', s) },
        ...(recurring && !s.skipNext
          ? [
              {
                id: 'skip',
                label: t`Skip once`,
                onAction: () =>
                  void run(
                    () => householdApi.skipSchedule(s.id, s.rowVersion),
                    t`Skipping ${s.name} once`,
                    t`Couldn't skip it`,
                  ),
              },
            ]
          : []),
        { id: 'log', label: t`Log a service`, onAction: () => onOpen('log', s) },
        { id: 'edit', label: t`Edit`, onAction: () => onOpen('edit', s) },
        {
          id: 'delete',
          label: t`Delete`,
          danger: true,
          onAction: () =>
            void (async () => {
              const ok = await confirm({
                title: t`Delete ${s.name}?`,
                body: t`Its reminders stop. The services it recorded stay on their thing or place.`,
                confirmLabel: t`Delete`,
                destructive: true,
              });
              if (ok)
                await run(
                  () => householdApi.deleteSchedule(s.id, s.rowVersion),
                  t`Deleted ${s.name}`,
                  t`Couldn't delete it`,
                );
            })(),
        },
      ]
    : [];

  const subjectLink =
    s.subject.type === 'thing' ? (
      <Link
        to="/t/$id"
        params={{ id: addressOf(s.subject) }}
        className="text-ink underline-offset-2 hover:underline"
      >
        <bdi>{s.subject.name}</bdi>
      </Link>
    ) : s.subject.type === 'place' ? (
      <Link
        to="/p/$id"
        params={{ id: addressOf(s.subject) }}
        className="text-ink underline-offset-2 hover:underline"
      >
        <bdi>{s.subject.name}</bdi>
      </Link>
    ) : (
      <bdi>{s.subject.name}</bdi>
    );
  const dueDay = s.next.dueOn ? f.day(s.next.dueOn) : null;

  return (
    <article
      aria-label={s.name}
      data-schedule={s.id}
      className="grid gap-2 px-3.5 py-3 md:flex md:items-center md:gap-3"
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <IconTile>{recurring ? <WrenchIcon /> : <CalendarIcon />}</IconTile>
        <div className="grid min-w-0 flex-1 gap-1">
          <div className="font-semibold text-[15px] leading-snug text-ink [overflow-wrap:anywhere]">
            <bdi>{s.name}</bdi>
          </div>
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
            {subjectLink}
            {s.subject.path ? (
              <>
                {sep()}
                <bdi>{s.subject.path}</bdi>
              </>
            ) : showLocation ? (
              <>
                {sep()}
                <bdi>{showLocation}</bdi>
              </>
            ) : null}
          </div>
          <div className="text-small text-ink-2 [overflow-wrap:anywhere]">
            {text.interval(s)}
            {last ? `${sep()}${last}` : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <ScheduleStatePill state={s.next.state}>{text.due(s, access.today)}</ScheduleStatePill>
            {dueDay ? <span className="text-small text-ink-3">{text.dueDay(s)}</span> : null}
            {held ? <span className="text-small text-ink-2">{held}</span> : null}
            {note}
          </div>
        </div>
      </div>
      {canManage ? (
        <div className="flex flex-wrap gap-2 ps-13 md:ps-0">
          <Button
            size="small"
            isDisabled={!online}
            onPress={() => onOpen('complete', s)}
            aria-label={t`Complete ${s.name}`}
          >
            <Trans context="schedule action">Complete</Trans>
          </Button>
          <OverflowActions actions={actions} title={s.name} isDisabled={!online} />
        </div>
      ) : null}
    </article>
  );
}
