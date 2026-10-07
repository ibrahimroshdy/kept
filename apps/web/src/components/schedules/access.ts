/**
 * What the reader may do with a step-4 record in one location (screens §3): their role, whether a
 * module is on there, whether money shows, and "today" in the location's own zone, which decides
 * due and overdue (engineering spec §7.13). The global lists (Schedules, Lending) hold rows from
 * several locations, so each row asks for its own.
 */
import { type Action, can, effectiveModules, type ModuleId } from '@kept/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { householdKeys } from '@/api/household/queries';
import { inventoryKeys } from '@/api/inventory/queries';
import { useLocations } from '@/api/queries';
import type { LocationDetail } from '@/api/types';

/** A calendar date in a time zone, YYYY-MM-DD. */
export function dayIn(timeZone: string | undefined, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

const dayNumber = (day: string): number => {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** Whole days from `from` to `to` (both YYYY-MM-DD): positive when `to` is later. */
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** `day` plus `n` days, YYYY-MM-DD. */
export function addDays(day: string, n: number): string {
  return new Date((dayNumber(day) + n) * 86_400_000).toISOString().slice(0, 10);
}

export type LocationAccess = {
  location: LocationDetail | undefined;
  can: (action: Action) => boolean;
  moduleOn: (m: ModuleId) => boolean;
  /** Money shows here: the Money module is on and the role may see it (D13). */
  money: boolean;
  /** Today in the location's zone. */
  today: string;
};

export function accessOf(location: LocationDetail | undefined): LocationAccess {
  const modules: readonly ModuleId[] = location
    ? (location.effectiveModules ?? [
        ...effectiveModules(location.modules, { providerResolved: location.providerResolved }),
      ])
    : [];
  const role = location?.role;
  const allowed = (action: Action) =>
    !!role &&
    can(role, action, { moneyVisibleToViewers: location?.moneyVisibleToViewers ?? false });
  return {
    location,
    can: allowed,
    moduleOn: (m) => modules.includes(m),
    money: modules.includes('money') && allowed('money.view'),
    today: dayIn(location?.timezone),
  };
}

/** `accessOf` for every location the reader has, by id. */
export function useLocationAccess(): (locationId: string) => LocationAccess {
  const locations = useLocations();
  const list = locations.data ?? [];
  return useCallback((id: string) => accessOf(list.find((l) => l.id === id)), [list]);
}

/** Whether a module is on in any of the reader's locations (its nav entry shows, screens §1). */
export function useModuleAnywhere(m: ModuleId): { on: boolean; loaded: boolean } {
  const locations = useLocations();
  const list = locations.data ?? [];
  return { on: list.some((l) => accessOf(l).moduleOn(m)), loaded: !!locations.data };
}

/**
 * After a schedule, service or loan write: every list and section that may show it (the lists,
 * the thing's and place's sections, the agenda behind Home's rows and the notification centre).
 */
export function useInvalidateHousehold() {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: householdKeys.schedules.all }),
        qc.invalidateQueries({ queryKey: householdKeys.loans.all }),
        qc.invalidateQueries({ queryKey: ['household'] }),
        qc.invalidateQueries({ queryKey: householdKeys.agenda.all }),
        qc.invalidateQueries({ queryKey: householdKeys.notifications.all }),
        qc.invalidateQueries({ queryKey: inventoryKeys.things.all }),
        qc.invalidateQueries({ queryKey: inventoryKeys.places.all }),
        // Home's overdue, due, expiring and loan rows are /home's counts.
        qc.invalidateQueries({ queryKey: inventoryKeys.home }),
      ]).then(() => undefined),
    [qc],
  );
}
