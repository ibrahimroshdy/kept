/**
 * A vehicle's tabs, loaded on demand from ./vehicle-sections.tsx (its own chunk in
 * assets/household/, cached by the service worker on first use): they all read the server (costs,
 * the meter's series and proofs, fills, documents), so none of it could work offline before its
 * first load. While a part loads, a skeleton; when it can't load, the §3 reason, "Needs a
 * connection". The thing page itself, and Log a reading, stay offline (T19).
 */
import { useLingui } from '@lingui/react/macro';
import { type ComponentType, lazy, Suspense } from 'react';
import { LoadingRows, Notice } from '@/components/page';

type Sections = typeof import('./vehicle-sections');

function Unavailable() {
  const { t } = useLingui();
  return <Notice title={t`Needs a connection`} />;
}

function part<P extends object>(pick: (m: Sections) => ComponentType<P>, quiet = false) {
  const fallback = (quiet ? () => null : Unavailable) as ComponentType<P>;
  const Lazy = lazy(() =>
    import('./vehicle-sections')
      .then((m) => ({ default: pick(m) }))
      .catch(() => ({ default: fallback })),
  );
  return function Part(props: P) {
    return (
      <Suspense fallback={quiet ? null : <LoadingRows rows={2} />}>
        <Lazy {...props} />
      </Suspense>
    );
  };
}

export const VehicleOverviewPart = part((m) => m.VehicleOverview);
export const VehicleReadingsPart = part((m) => m.VehicleReadings);
export const VehicleServicesPart = part((m) => m.VehicleServices);
export const VehicleFuelPart = part((m) => m.VehicleFuel);
export const VehicleSchedulesPart = part((m) => m.VehicleSchedules);
export const VehicleDocumentsPart = part((m) => m.VehicleDocuments);
export const VehicleCostsPart = part((m) => m.VehicleCosts);
/** The history report sheet (T23), from the action menu; a sheet renders nothing until opened. */
export const VehicleReportSheetPart = part((m) => m.VehicleReportSheet, true);
