/**
 * A vehicle's tabs on its thing page (plan T18; screens §5, §8): Overview · Readings · Services ·
 * Fuel · Schedules · Documents · Costs, as `?tab=` from `md` up and as one scrolling page with
 * pinned section chips on a phone (thing-screen.tsx draws both). After them come the vehicle's
 * Details (the type's fields and Edit) and the thing's other sections (Paperwork, Value, Loans,
 * Claims, Links, History), so nothing a thing has is lost. Step 2's Meters section gives way to
 * Readings; step 4's Schedules section is the Schedules tab, with estimated dates.
 *
 * Only a vehicle (./is-vehicle.ts) with Vehicles on in its location gets them; any other metered
 * thing keeps step 2's Meters and step 4's sections. This module is small and precached; the tabs'
 * content loads on demand (./vehicle-lazy.tsx → ./vehicle-sections.tsx, assets/household/).
 *
 * The parts read the thing from `useThingCtx()` and move between tabs with `useVehicleNav()`;
 * the other step-5 tasks' parts (Services, Fuel, Documents, the history report) plug in at
 * ./slots.tsx with no props.
 */

import type { ModuleId } from '@kept/shared';
import { useLingui } from '@lingui/react/macro';
import type { ReactNode } from 'react';
import type { ThingView } from '@/api/inventory/types';
import type { LocationDetail } from '@/api/types';
import { DocumentIcon } from '@/components/icons';
import { useIsVehicle } from './is-vehicle';
import {
  VehicleCostsPart,
  VehicleDocumentsPart,
  VehicleFuelPart,
  VehicleOverviewPart,
  VehicleReadingsPart,
  VehicleReportSheetPart,
  VehicleSchedulesPart,
  VehicleServicesPart,
} from './vehicle-lazy';

/** The tabs only a vehicle has (`overview` and `schedules` are every thing's keys). */
export const VEHICLE_TABS = [
  'readings',
  'services',
  'fuel',
  'documents',
  'costs',
  'details',
] as const;
export type VehicleTab = (typeof VEHICLE_TABS)[number];
type Key = string;

/**
 * A vehicle's tab order, from the tabs the thing would have otherwise. A vehicle opens on its
 * Overview, even one that holds things (the Corolla's jack): Contents comes after Details (UI
 * step-5 review M5).
 */
export function vehicleTabOrder<T extends Key>(base: readonly T[]): (T | VehicleTab)[] {
  const contents = base.filter((x) => x === 'contents');
  const schedules = base.filter((x) => x === 'schedules');
  const rest = base.filter(
    (x) => x !== 'contents' && x !== 'overview' && x !== 'meters' && x !== 'schedules',
  );
  return [
    'overview' as T,
    'readings',
    'services',
    'fuel',
    ...schedules,
    'documents',
    'costs',
    'details',
    ...contents,
    ...rest,
  ];
}

/** Whether this thing shows as a vehicle: a vehicle type, with Vehicles on in its location. */
export function useShowsAsVehicle(
  thing: ThingView,
  location: LocationDetail,
  moduleOn: (m: ModuleId) => boolean,
): boolean {
  const vehicle = useIsVehicle(thing, location.ownerAccountId);
  return vehicle && moduleOn('vehicles');
}

export function useVehicleTitles(): Record<VehicleTab | 'overview', string> {
  const { t } = useLingui();
  return {
    overview: t`Overview`,
    readings: t`Readings`,
    services: t`Services`,
    fuel: t`Fuel`,
    documents: t`Documents`,
    costs: t`Costs`,
    details: t`Details`,
  };
}

/** A vehicle tab's content; null for a key that isn't a vehicle's own (thing-screen has it). */
export function vehiclePanel(tab: Key): ReactNode {
  switch (tab) {
    case 'overview':
      return <VehicleOverviewPart />;
    case 'readings':
      return <VehicleReadingsPart />;
    case 'services':
      return <VehicleServicesPart />;
    case 'fuel':
      return <VehicleFuelPart />;
    case 'schedules':
      return <VehicleSchedulesPart />;
    case 'documents':
      return <VehicleDocumentsPart />;
    case 'costs':
      return <VehicleCostsPart />;
    default:
      return null;
  }
}

/** The vehicle's own items in the thing's action menu: the history report (T23). */
export function useVehicleActions() {
  const { t } = useLingui();
  return [{ id: 'history-report', label: t`History report`, icon: <DocumentIcon /> }];
}

/** The history report sheet, loaded with the vehicle's tabs. */
export function VehicleReportSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return open ? <VehicleReportSheetPart open onClose={onClose} /> : null;
}

export { useVehicleNav, VehicleNavProvider } from './nav';
