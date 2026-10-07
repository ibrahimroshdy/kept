/**
 * The thing's schedules (screens §5 "Schedules"; T20 over T21's parts): each with its next due
 * point and state, and T21's row actions and sheets (Complete, Snooze, Edit, Log a service), so
 * the thing page and the Schedules screen behave the same. "New schedule" opens T21's sheet on
 * this thing. With Schedules off here the tab isn't shown (thing-screen.tsx).
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { type ReactNode, useState } from 'react';
import { useSubjectSchedules } from '@/api/household/queries';
import type { Schedule } from '@/api/household/types';
import { ScheduleIcon } from '@/components/icons';
import { EmptyState, ErrorState, LoadingRows, Section } from '@/components/page';
import { CompleteSheet } from '@/components/schedules/complete-sheet';
import { type ScheduleRowAction, ScheduleRowView } from '@/components/schedules/schedule-row';
import { ScheduleSheet } from '@/components/schedules/schedule-sheet';
import { SnoozeSheet } from '@/components/schedules/snooze-sheet';
import { LogServiceSheet } from '@/components/services/log-service-sheet';
import { Button } from '@/components/ui/button';
import { useThingCtx } from './context';
import { useBlocked } from './household';

type Open = { action: ScheduleRowAction | 'new'; schedule: Schedule | null } | null;

export function ThingSchedulesSection({
  note,
  empty,
  footer,
}: {
  /** Beside a row's due pill (a vehicle's estimated date, step 5). */
  note?: (s: Schedule) => ReactNode;
  /** Instead of "Nothing scheduled" (a vehicle's starter schedules, step 5). */
  empty?: ReactNode;
  /** Under the list (what a vehicle's estimates rest on, step 5). */
  footer?: ReactNode;
} = {}) {
  const { thing, can } = useThingCtx();
  const { t } = useLingui();
  const blocked = useBlocked();
  const q = useSubjectSchedules({ thingId: thing.id });
  const [open, setOpen] = useState<Open>(null);
  const close = () => setOpen(null);
  const manage = can('schedules-claims.manage');
  const s = open?.schedule ?? null;
  return (
    <Section
      title={<Trans>Schedules</Trans>}
      action={
        manage ? (
          <Button
            size="small"
            variant="secondary"
            isDisabled={!!blocked}
            onPress={() => setOpen({ action: 'new', schedule: null })}
          >
            <Trans>New schedule</Trans>
          </Button>
        ) : null
      }
    >
      {blocked && manage ? <p className="m-0 text-small text-ink-3">{blocked}</p> : null}
      {q.isPending ? (
        <LoadingRows rows={2} label={t`Loading the schedules`} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data.items.length === 0 && empty ? (
        empty
      ) : q.data.items.length === 0 ? (
        <EmptyState icon={<ScheduleIcon />} title={<Trans>Nothing scheduled</Trans>}>
          <Trans>A service or a check that comes round: Kept reminds you before it's due.</Trans>
        </EmptyState>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {q.data.items.map((x) => (
            <li key={x.id}>
              <ScheduleRowView
                schedule={x}
                note={note?.(x)}
                onOpen={(action, schedule) => setOpen({ action, schedule })}
              />
            </li>
          ))}
        </ul>
      )}
      {footer}
      {manage ? (
        <>
          <CompleteSheet
            schedule={open?.action === 'complete' ? s : null}
            onClose={close}
            onMore={(x) => setOpen({ action: 'log', schedule: x })}
          />
          <SnoozeSheet schedule={open?.action === 'snooze' ? s : null} onClose={close} />
          <ScheduleSheet
            open={open?.action === 'new' || open?.action === 'edit'}
            schedule={open?.action === 'edit' ? s : null}
            subject={{ thingId: thing.id }}
            locationId={thing.locationId}
            onClose={close}
          />
          <LogServiceSheet
            open={open?.action === 'log' && !!s}
            subject={{ thingId: thing.id }}
            {...(s ? { subjectRef: s.subject } : {})}
            locationId={thing.locationId}
            completes={s ? [s.id] : []}
            onClose={close}
          />
        </>
      ) : null}
    </Section>
  );
}
