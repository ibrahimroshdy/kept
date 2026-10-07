/**
 * A schedule in words (screens §5, D29, D52; step-4 Q2): how often ("Every 12 months", "Every
 * 10,000 km or 12 months", "Once, on 18 Dec"), when it's next due ("in 12 days", "due today",
 * "3 days overdue", "at 60,000 km"), and its state as a pill with an icon, a word and a colour
 * together, never colour alone (D134). The due point comes from the server's agenda (`next`),
 * never recomputed here; only the day count is, against today in the location's zone.
 */
import type { ScheduleState } from '@kept/shared';
import { plural } from '@lingui/core/macro';
import { useLingui } from '@lingui/react/macro';
import type { Schedule } from '@/api/household/types';
import { AlertIcon, CalendarIcon, ClockIcon } from '@/components/icons';
import { Pill, type PillTone } from '@/components/page';
import { useFormat } from '@/lib/format';
import { useMeterUnit } from '@/lib/units';
import { daysBetween } from './access';

/** A decimal string on a meter, in the reader's digits ("60,000"). */
export function useUnits() {
  const f = useFormat();
  const unitOf = useMeterUnit();
  return (value: string, unit: string | null | undefined) => {
    const n = Number(value);
    const shown = Number.isFinite(n) ? f.num(n) : value;
    return unit ? `${shown} ${unitOf(unit)}` : shown;
  };
}

/** "in 12 days", "due today", "3 days overdue", from today to a due day. */
export function useDayCount() {
  const { t } = useLingui();
  return (today: string, dueOn: string): string => {
    const n = daysBetween(today, dueOn);
    if (n === 0) return t`Due today`;
    if (n > 0) return plural(n, { one: 'In # day', other: 'In # days' });
    return plural(-n, { one: '# day overdue', other: '# days overdue' });
  };
}

export function useScheduleText() {
  const { t } = useLingui();
  const f = useFormat();
  const units = useUnits();
  const count = useDayCount();

  /** How often: "Every 12 months", "Every 10,000 km or 12 months", "Once, on 18 Dec". */
  const interval = (s: Schedule): string => {
    const unit = s.meter?.unit ?? null;
    if (s.everyUnits != null && s.everyMonths != null) {
      const every = units(s.everyUnits, unit);
      const months = s.everyMonths;
      return plural(months, {
        one: `Every ${every} or # month`,
        other: `Every ${every} or # months`,
      });
    }
    if (s.everyMonths != null)
      return plural(s.everyMonths, { one: 'Every month', other: 'Every # months' });
    if (s.everyUnits != null) {
      const every = units(s.everyUnits, unit);
      return t`Every ${every}`;
    }
    const day = s.dueOn ? f.day(s.dueOn) : '';
    return t`Once, on ${day}`;
  };

  /**
   * When it's next due, for a row: the day count and the reading, whichever apply ("In 12 days",
   * "At 60,000 km", "In 12 days or at 60,000 km").
   */
  const due = (s: Schedule, today: string): string => {
    const unit = s.meter?.unit ?? null;
    const at = s.next.dueValue ? units(s.next.dueValue, unit) : null;
    const days = s.next.dueOn ? count(today, s.next.dueOn) : null;
    // Overdue by the meter while the day is still ahead (T29): the reading passed it.
    if (
      s.next.state === 'overdue' &&
      at &&
      (!s.next.dueOn || daysBetween(today, s.next.dueOn) >= 0)
    )
      return t`Past ${at}`;
    if (days && at) return t`${days} or at ${at}`;
    if (days) return days;
    if (at) return t`At ${at}`;
    return t`No due date yet`;
  };

  /** The due day itself, for a second line ("Due 18 Dec"). */
  const dueDay = (s: Schedule): string | null => {
    if (!s.next.dueOn) return null;
    const day = f.day(s.next.dueOn);
    return t`Due ${day}`;
  };

  /** A snooze or a skip, when one is set. */
  const held = (s: Schedule): string | null => {
    const unit = s.meter?.unit ?? null;
    if (s.snoozedUntil) {
      const day = f.day(s.snoozedUntil);
      return t`Snoozed until ${day}`;
    }
    if (s.snoozedUntilValue) {
      const at = units(s.snoozedUntilValue, unit);
      return t`Snoozed until ${at}`;
    }
    if (s.skipNext) return t`Skipping once`;
    return null;
  };

  const last = (s: Schedule): string | null => {
    if (!s.lastService) return null;
    const day = f.day(s.lastService.servicedOn);
    return t`Last done ${day}`;
  };

  return { interval, due, dueDay, held, last };
}

export function useScheduleStateLabels(): Record<ScheduleState, string> {
  const { t } = useLingui();
  return { upcoming: t`Upcoming`, due: t`Due`, overdue: t`Overdue` };
}

const STATE_PILL: Record<ScheduleState, { tone: PillTone; icon: React.ReactNode }> = {
  upcoming: { tone: 'neutral', icon: <CalendarIcon /> },
  due: { tone: 'warn', icon: <ClockIcon /> },
  overdue: { tone: 'danger', icon: <AlertIcon /> },
};

/** The state as a pill, with the day count as its words ("In 12 days", "3 days overdue"). */
export function ScheduleStatePill({ state, children }: { state: ScheduleState; children: string }) {
  const s = STATE_PILL[state];
  return (
    <span data-state={state} className="contents">
      <Pill tone={s.tone} icon={s.icon}>
        {children}
      </Pill>
    </span>
  );
}
