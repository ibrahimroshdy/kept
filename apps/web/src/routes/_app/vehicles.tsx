/**
 * Vehicles (step-5 plan T17; screens §1, §8): every car, motorbike and generator in the locations
 * with the module on, with its odometer, what's due next and its documents
 * (components/vehicles/list.tsx). A vehicle's tabs live on `/t/$id` as `?tab=`. Its search is the
 * `vehicles` surface's list state (filters, sort, saved views). Its chunk loads on demand from
 * assets/household/ (vite.config.ts): the list reads the server; its error screen stays
 * precached and says "Needs a connection" offline.
 */
import { SURFACE_FILTER_KEYS } from '@kept/shared';
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { CarIcon } from '@/components/icons';
import { EmptyState, Page } from '@/components/page';
import { useModuleAnywhere } from '@/components/schedules/access';
import { VehiclesList } from '@/components/vehicles/list';
import { VehiclesRouteError } from '@/components/vehicles/route-error';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/vehicles')({
  validateSearch: listSearch(SURFACE_FILTER_KEYS.vehicles),
  component: VehiclesPage,
  errorComponent: VehiclesRouteError,
});

function VehiclesPage() {
  const { t } = useLingui();
  const module = useModuleAnywhere('vehicles');
  return (
    <Page title={t`Vehicles`} wide>
      {module.loaded && !module.on ? (
        <EmptyState icon={<CarIcon />} title={<Trans>Vehicles is off in your locations</Trans>}>
          <Trans>
            An owner or admin turns it on in the location's settings, under What to track.
          </Trans>
        </EmptyState>
      ) : (
        <VehiclesList />
      )}
    </Page>
  );
}
