/**
 * Condition reports' words (1.x, D235): the two kinds, a room's condition, and the dates the
 * screens print (the walk-through's day as the location wrote it; a photo's time in the
 * location's time zone, when Kept received it).
 */
import type { ConditionReportKind, RoomCondition } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import { useMemo } from 'react';

export function useConditionKindLabels(): Record<ConditionReportKind, string> {
  const { t } = useLingui();
  return { move_in: t`Move-in`, move_out: t`Move-out` };
}

export function useRoomConditionLabels(): Record<RoomCondition, string> {
  const { t } = useLingui();
  return { good: t`Good`, fair: t`Fair`, poor: t`Poor`, damaged: t`Damaged` };
}

function safeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** `day('2026-09-01')` → "1 Sept 2026"; `at(iso, zone)` → "1 Sept 2026, 14:32" in that zone. */
export function useConditionDates() {
  const { i18n } = useLingui();
  const locale = i18n.locale || 'en';
  return useMemo(() => {
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' });
    const zones = new Map<string, Intl.DateTimeFormat>();
    return {
      day: (d: string) => day.format(new Date(`${d}T00:00:00Z`)).replace(/ /g, ' '),
      at: (iso: string, zone: string) => {
        let f = zones.get(zone);
        if (!f) {
          f = new Intl.DateTimeFormat(locale, {
            dateStyle: 'medium',
            timeStyle: 'short',
            timeZone: safeZone(zone),
          });
          zones.set(zone, f);
        }
        return f.format(new Date(iso));
      },
    };
  }, [locale]);
}
