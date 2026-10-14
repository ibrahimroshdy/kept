/**
 * Insights (1.x, D234; screens §1, §2 `/insights`): spending, value, vehicle costs and warranty
 * coverage across your locations with Money on (components/insights/insights-screen.tsx). The
 * location chip is `f.location`, named here: the definition is precached, the screen isn't. Its
 * chunk loads on demand from assets/household/ (vite.config.ts): it reads the server, and its
 * error screen stays precached and says "Needs a connection" offline.
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { InsightsScreen } from '@/components/insights/insights-screen';
import { InsightsRouteError } from '@/components/on-demand-route-error';
import { Page } from '@/components/page';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/insights')({
  validateSearch: listSearch(['location']),
  component: InsightsPage,
  errorComponent: InsightsRouteError,
});

function InsightsPage() {
  const { t } = useLingui();
  return (
    <Page title={t`Insights`} wide>
      <InsightsScreen />
    </Page>
  );
}
