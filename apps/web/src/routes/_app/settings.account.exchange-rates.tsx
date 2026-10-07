/**
 * Account → Exchange rates (plan T26; D76, D136): the rates you entered, per pair and date, that
 * turn totals in several currencies into one. Kept never estimates a rate. Inside the Account
 * frame (settings.account.tsx), so no Page of its own; the tab loads on demand
 * (components/incidents/lazy.tsx).
 */
import { createFileRoute } from '@tanstack/react-router';
import { ExchangeRatesTab } from '@/components/incidents/lazy';
import { TabRouteError } from '@/components/incidents/route-error';
import { LoadingRows } from '@/components/page';
import { useRequestedAccountScope } from '@/components/registries/api';

export const Route = createFileRoute('/_app/settings/account/exchange-rates')({
  component: RatesTab,
  errorComponent: TabRouteError,
});

function RatesTab() {
  const scope = useRequestedAccountScope();
  if (scope.isPending || !scope.accountId) return <LoadingRows rows={3} />;
  return <ExchangeRatesTab key={scope.accountId} scope={scope} />;
}
