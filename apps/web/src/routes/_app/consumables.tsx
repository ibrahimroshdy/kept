/**
 * Consumables (plan T23; D14, screens "Other screens"): what's running low in a location, low
 * first, with Adjust (components/consumables/stock-list.tsx). Its chunk loads on demand from
 * assets/household/ (vite.config.ts): the list reads the server.
 */
import { useLingui } from '@lingui/react/macro';
import { createFileRoute } from '@tanstack/react-router';
import { StockList } from '@/components/consumables/stock-list';
import { Page } from '@/components/page';
import { ConsumablesRouteError } from '@/components/portability/route-error';
import { listSearch } from '@/lib/url-state';

export const Route = createFileRoute('/_app/consumables')({
  // The list's filters (`f.location`, `f.state`), named here: the definition is precached, the
  // list isn't.
  validateSearch: listSearch(['location', 'state']),
  component: ConsumablesPage,
  errorComponent: ConsumablesRouteError,
});

function ConsumablesPage() {
  const { t } = useLingui();
  return (
    <Page title={t`Consumables`} wide>
      <StockList />
    </Page>
  );
}
