/**
 * Account settings (screens §5 Settings → Account, Q21): the registries of one owner account,
 * with a switcher over the accounts you manage. `?account=` picks the account (yours by default)
 * and every tab keeps it; each tab's own list state (search, the selected type) is its own.
 * "Print inventory" (D201) makes a report of the account's locations you can see.
 */
import { Trans, useLingui } from '@lingui/react/macro';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import * as z from 'zod/mini';
import { useLocations } from '@/api/queries';
import { LinkTabs } from '@/components/link-tabs';
import { AccountRouteError } from '@/components/on-demand-route-error';
import { Page } from '@/components/page';
import { AccountSwitcher } from '@/components/registries/account-switcher';
import { useRequestedAccountScope } from '@/components/registries/api';
import { PrintInventory } from '@/components/reports/print-sheet';
import { SettingsTabs } from '@/components/settings-tabs';

export const Route = createFileRoute('/_app/settings/account')({
  validateSearch: z.catch(z.object({ account: z.optional(z.string()) }), {}),
  component: AccountLayout,
  errorComponent: AccountRouteError,
});

/** Tab links keep the account and drop the other tab's list state. */
const keepAccount = ((prev: { account?: string }) =>
  prev.account ? { account: prev.account } : {}) as never;

function AccountLayout() {
  const { t } = useLingui();
  const scope = useRequestedAccountScope();
  const locations = useLocations();
  // The account's locations you can see: what its inventory report covers (D201).
  const accountLocations = (locations.data ?? [])
    .filter((l) => l.ownerAccountId === scope.accountId)
    .map((l) => l.id);
  const tab = (to: string) => ({ to, search: keepAccount }) as never;
  return (
    <Page title={t`Account`} wide>
      <SettingsTabs />
      <AccountSwitcher scope={scope} />
      {scope.accountId && accountLocations.length > 0 ? (
        <PrintInventory scope={{ accountId: scope.accountId }} locationIds={accountLocations} />
      ) : null}
      <LinkTabs
        label={t`Account`}
        tabs={[
          { key: 'types', label: <Trans>Types</Trans>, link: tab('/settings/account/types') },
          {
            key: 'place-kinds',
            label: <Trans>Place kinds</Trans>,
            link: tab('/settings/account/place-kinds'),
          },
          { key: 'brands', label: <Trans>Brands</Trans>, link: tab('/settings/account/brands') },
          {
            key: 'vendors',
            label: <Trans>Vendors</Trans>,
            link: tab('/settings/account/vendors'),
          },
          { key: 'people', label: <Trans>People</Trans>, link: tab('/settings/account/people') },
          { key: 'tags', label: <Trans>Tags</Trans>, link: tab('/settings/account/tags') },
          {
            key: 'templates',
            label: <Trans>Templates</Trans>,
            link: tab('/settings/account/templates'),
          },
          {
            key: 'exchange-rates',
            label: <Trans>Exchange rates</Trans>,
            link: tab('/settings/account/exchange-rates'),
          },
        ]}
      />
      <Outlet />
    </Page>
  );
}
